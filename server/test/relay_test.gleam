//// The relay actor against real managers driven by the scriptable stub:
//// actual request parameters, both providers' recovery response shapes,
//// silent backends next to responsive ones, and worker/owner deaths.

import gleam/dynamic/decode
import gleam/erlang/process.{type Subject}
import gleam/int
import gleam/json
import gleam/list
import gleam/option.{None, Some}
import gleam/string
import gleeunit/should
import script_stub.{type Control, type Event}
import yacwu/codex
import yacwu/relay
import yacwu/relay_core.{Address, SendInput}

@external(erlang, "erlang", "unique_integer")
fn unique() -> Int

type Stub {
  Stub(name: codex.Codex, events: Subject(Event), control: Subject(Control))
}

fn stub(label: String) -> Stub {
  let path =
    "/tmp/yacwu-relay-"
    <> int.to_string(int.absolute_value(unique()))
    <> ".sock"
  let events = process.new_subject()
  let control = script_stub.start(path, events, True)
  let name: codex.Codex = process.new_name("relay_test_" <> label)
  let assert Ok(_) = codex.start(name, label, codex.UnixSock(path))
  Stub(name, events, control)
}

/// A relay wired to stub managers "a" and "b".
fn setup(timeout: Int) -> #(relay.Relay, Stub, Stub) {
  let a = stub("a")
  let b = stub("b")
  let name: relay.Relay = process.new_name("relay_test")
  let backends =
    relay.Backends(
      resolve: fn(host) {
        case host {
          "a" -> Ok(a.name)
          "b" -> Ok(b.name)
          _ -> Error("unknown host")
        }
      },
      subscribe: fn(pid, subject) {
        codex.subscribe_lifecycle(a.name, pid, subject)
        codex.subscribe_lifecycle(b.name, pid, subject)
      },
    )
  let assert Ok(_) =
    relay.start(
      name,
      backends,
      relay_core.default_limits(),
      relay.Timeouts(steer: timeout, read: timeout, tick: 600_000),
      relay.memory_persistence(True),
    )
  connect(a)
  connect(b)
  #(name, a, b)
}

fn connect(s: Stub) {
  let done = process.new_subject()
  let _ =
    process.spawn(fn() {
      process.send(
        done,
        codex.request_tracked(s.name, "test/connect", json.object([]), 2000),
      )
    })
  let assert Ok(frame) = script_stub.expect(s.events, "test/connect", 2000)
  script_stub.reply(s.control, frame.id, json.object([]))
  let assert Ok(_) = process.receive(done, 2000)
  Nil
}

fn turn_json(id: String, status: String) {
  json.object([
    #("id", json.string(id)),
    #("status", json.string(status)),
    #("items", json.preprocessed_array([])),
  ])
}

fn turn_started(s: Stub, thread: String, turn: String) {
  script_stub.notify(
    s.control,
    "turn/started",
    json.object([
      #("threadId", json.string(thread)),
      #("turn", turn_json(turn, "inProgress")),
    ]),
  )
}

fn turn_completed(s: Stub, thread: String, turn: String) {
  script_stub.notify(
    s.control,
    "turn/completed",
    json.object([
      #("threadId", json.string(thread)),
      #("turn", turn_json(turn, "completed")),
    ]),
  )
}

fn send(r: relay.Relay, id: String, host: String, thread: String) {
  let assert Ok(relay_core.Fresh(_)) =
    relay.send(
      r,
      SendInput(
        id,
        Address("a", "thr-sender"),
        Address(host, thread),
        "hello " <> id,
        relay_core.CodexBackend,
        1,
      ),
    )
  Nil
}

fn wait_state(
  r: relay.Relay,
  id: String,
  state: relay_core.MessageState,
  timeout: Int,
) -> Bool {
  case relay.get_message(r, id) {
    Ok(m) if m.state == state -> True
    _ ->
      case timeout <= 0 {
        True -> False
        False -> {
          process.sleep(20)
          wait_state(r, id, state, timeout - 20)
        }
      }
  }
}

fn param(frame: script_stub.Frame, path: List(String)) -> String {
  let assert Ok(value) =
    json.parse(frame.text, decode.at(["params", ..path], decode.string))
  value
}

/// Outstanding `turn/steer` requests on the manager (it also issues its
/// own account reads, which the stub leaves unanswered).
fn pending_count(s: Stub) -> Int {
  let text = json.to_string(codex.diagnostic_snapshot(s.name))
  let assert Ok(methods) =
    json.parse(
      text,
      decode.at(["pending"], decode.list(decode.at(["method"], decode.string))),
    )
  list.count(methods, fn(method) { method == "turn/steer" })
}

pub fn steer_carries_turn_guard_and_submission_id_test() {
  let #(r, _a, b) = setup(2000)
  turn_started(b, "thr-bob", "turn-1")
  process.sleep(50)
  send(r, "msg-0001", "b", "thr-bob")
  let assert Ok(frame) = script_stub.expect(b.events, "turn/steer", 2000)
  param(frame, ["threadId"]) |> should.equal("thr-bob")
  param(frame, ["expectedTurnId"]) |> should.equal("turn-1")
  let submission = param(frame, ["clientUserMessageId"])
  should.be_true(string.starts_with(submission, "rs-"))
  let assert Ok(text) =
    json.parse(
      frame.text,
      decode.at(
        ["params", "input"],
        decode.list(decode.at(["text"], decode.string)),
      ),
    )
  let assert [body] = text
  should.be_true(string.contains(
    body,
    "[Yacwu relay message msg-0001 from session thr-sender on a]\nhello msg-0001\n[/Yacwu relay message msg-0001]",
  ))
  script_stub.reply(
    b.control,
    frame.id,
    json.object([#("turnId", json.string("turn-1"))]),
  )
  wait_state(r, "msg-0001", relay_core.Accepted, 2000) |> should.be_true
  let assert Ok(m) = relay.get_message(r, "msg-0001")
  m.turn |> should.equal("turn-1")
  m.submission |> should.equal(submission)
  // The connection the acknowledgement came from is recorded.
  should.be_true(m.generation > 0)
}

/// The backend stores the input and then answers with an internal error:
/// the message is uncertain and never written again.
pub fn internal_error_after_acceptance_is_not_resent_test() {
  let #(r, _a, b) = setup(2000)
  turn_started(b, "thr-bob", "turn-1")
  process.sleep(50)
  send(r, "msg-0001", "b", "thr-bob")
  let assert Ok(frame) = script_stub.expect(b.events, "turn/steer", 2000)
  script_stub.reply_error(b.control, frame.id, -32_603, "internal error")
  wait_state(r, "msg-0001", relay_core.Uncertain, 2000) |> should.be_true
  turn_started(b, "thr-bob", "turn-2")
  script_stub.collect(b.events, "turn/steer", 500) |> should.equal([])
}

/// One backend never answers; another keeps working, the relay stays
/// responsive, and the silent manager's request state stays bounded.
pub fn silent_backend_is_isolated_and_bounded_test() {
  let #(r, a, b) = setup(300)
  let threads =
    list.index_map(list.repeat(Nil, 12), fn(_, i) {
      "thr-a" <> int.to_string(i)
    })
  list.each(threads, fn(t) { turn_started(a, t, "turn-" <> t) })
  turn_started(b, "thr-bob", "turn-b")
  process.sleep(100)
  list.each(threads, fn(t) { send(r, "msg-" <> t, "a", t) })
  // Only the per-host cap of attempts is outstanding at once.
  process.sleep(100)
  pending_count(a) |> should.equal(8)
  // The other backend is unaffected...
  send(r, "msg-bob1", "b", "thr-bob")
  let assert Ok(frame) = script_stub.expect(b.events, "turn/steer", 1000)
  script_stub.reply(
    b.control,
    frame.id,
    json.object([#("turnId", json.string("turn-b"))]),
  )
  wait_state(r, "msg-bob1", relay_core.Accepted, 1000) |> should.be_true
  // ...and so is the relay itself.
  let started = codex.now_ms()
  relay.is_enabled(r, "thr-bob") |> should.be_true
  should.be_true(codex.now_ms() - started < 100)
  // Every silent attempt ends uncertain; the queue behind the cap drains.
  list.all(threads, fn(t) {
    wait_state(r, "msg-" <> t, relay_core.Uncertain, 3000)
  })
  |> should.be_true
  // Each message was written exactly once: 8 behind the cap first, then 4.
  let frames = script_stub.collect(a.events, "turn/steer", 200)
  list.length(frames) |> should.equal(12)
  pending_count(a) |> should.equal(0)
  // A late answer to an expired request changes nothing.
  list.each(frames, fn(f) {
    script_stub.reply(
      a.control,
      f.id,
      json.object([#("turnId", json.string("x"))]),
    )
  })
  process.sleep(100)
  wait_state(r, "msg-" <> list_first(threads), relay_core.Uncertain, 0)
  |> should.be_true
}

fn list_first(items: List(String)) -> String {
  let assert [first, ..] = items
  first
}

fn thread_read_reply(s: Stub, frame: script_stub.Frame, status: String) {
  script_stub.reply(
    s.control,
    frame.id,
    json.object([
      #(
        "thread",
        json.object([
          #("id", json.string(param(frame, ["threadId"]))),
          #(
            "status",
            json.object([
              #("type", json.string(status)),
              #("activeFlags", json.preprocessed_array([])),
            ]),
          ),
          #("turns", json.preprocessed_array([])),
        ]),
      ),
    ]),
  )
}

/// codex shape: newest first, honouring the limit.
pub fn recovery_finds_in_progress_turn_codex_shape_test() {
  let #(r, _a, b) = setup(2000)
  send(r, "msg-0001", "b", "thr-new")
  let assert Ok(read) = script_stub.expect(b.events, "thread/read", 2000)
  thread_read_reply(b, read, "active")
  let assert Ok(page) = script_stub.expect(b.events, "thread/turns/list", 2000)
  script_stub.reply(
    b.control,
    page.id,
    json.object([
      #(
        "data",
        json.preprocessed_array([
          turn_json("t9", "inProgress"),
          turn_json("t8", "completed"),
        ]),
      ),
      #("nextCursor", json.null()),
    ]),
  )
  let assert Ok(steer) = script_stub.expect(b.events, "turn/steer", 2000)
  param(steer, ["expectedTurnId"]) |> should.equal("t9")
}

/// Claude adapter shape: every turn, oldest first.
pub fn recovery_finds_in_progress_turn_adapter_shape_test() {
  let #(r, _a, b) = setup(2000)
  send(r, "msg-0001", "b", "thr-new")
  let assert Ok(read) = script_stub.expect(b.events, "thread/read", 2000)
  thread_read_reply(b, read, "active")
  let assert Ok(page) = script_stub.expect(b.events, "thread/turns/list", 2000)
  script_stub.reply(
    b.control,
    page.id,
    json.object([
      #(
        "data",
        json.preprocessed_array([
          turn_json("t1", "completed"),
          turn_json("t2", "interrupted"),
          turn_json("t3", "inProgress"),
        ]),
      ),
      #("nextCursor", json.null()),
      #("backwardsCursor", json.null()),
    ]),
  )
  let assert Ok(steer) = script_stub.expect(b.events, "turn/steer", 2000)
  param(steer, ["expectedTurnId"]) |> should.equal("t3")
}

pub fn recovery_without_usable_turn_does_not_steer_test() {
  let #(r, _a, b) = setup(2000)
  send(r, "msg-0001", "b", "thr-new")
  let assert Ok(read) = script_stub.expect(b.events, "thread/read", 2000)
  thread_read_reply(b, read, "active")
  let assert Ok(page) = script_stub.expect(b.events, "thread/turns/list", 2000)
  script_stub.reply(
    b.control,
    page.id,
    json.object([
      #("data", json.preprocessed_array([turn_json("t1", "completed")])),
      #("nextCursor", json.null()),
    ]),
  )
  script_stub.collect(b.events, "turn/steer", 400) |> should.equal([])
  let assert Ok(m) = relay.get_message(r, "msg-0001")
  m.state |> should.equal(relay_core.Queued)
}

pub fn idle_recipient_waits_without_wake_test() {
  let #(r, _a, b) = setup(2000)
  send(r, "msg-0001", "b", "thr-new")
  let assert Ok(read) = script_stub.expect(b.events, "thread/read", 2000)
  thread_read_reply(b, read, "idle")
  script_stub.collect(b.events, "turn/steer", 300) |> should.equal([])
  script_stub.collect(b.events, "turn/start", 100) |> should.equal([])
}

/// The HTTP handler carrying an injected start dies: before dispatching
/// the claim is released; after dispatching the members are uncertain.
pub fn owner_death_around_injected_start_test() {
  let #(r, _a, b) = setup(2000)
  turn_started(b, "thr-bob", "t0")
  turn_completed(b, "thr-bob", "t0")
  process.sleep(50)
  send(r, "msg-0001", "b", "thr-bob")
  let to = Address("b", "thr-bob")
  let claimed = process.new_subject()
  let _ =
    process.spawn_unlinked(fn() {
      process.send(claimed, relay.claim_start(r, to))
    })
  let assert Ok(Some(_)) = process.receive(claimed, 1000)
  wait_state(r, "msg-0001", relay_core.Queued, 1000) |> should.be_true
  let _ =
    process.spawn_unlinked(fn() {
      let claim = relay.claim_start(r, to)
      case claim {
        Some(c) -> relay.dispatching(r, c.submission)
        None -> Nil
      }
      process.send(claimed, claim)
    })
  let assert Ok(Some(_)) = process.receive(claimed, 1000)
  wait_state(r, "msg-0001", relay_core.Uncertain, 1000) |> should.be_true
  None |> should.equal(None)
}
