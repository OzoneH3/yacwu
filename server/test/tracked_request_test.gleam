//// Tracked requests: deadlines cover the whole request lifetime, and every
//// failure says whether the backend can have seen the request.

import gleam/dynamic/decode
import gleam/erlang/process.{type Pid, type Subject}
import gleam/int
import gleam/json
import gleam/list
import gleeunit/should
import script_stub.{type Control, type Event}
import yacwu/codex

@external(erlang, "erlang", "unique_integer")
fn unique() -> Int

@external(erlang, "erlang", "suspend_process")
fn suspend(pid: Pid) -> Bool

@external(erlang, "erlang", "resume_process")
fn resume(pid: Pid) -> Bool

fn socket_path() -> String {
  "/tmp/yacwu-tracked-"
  <> int.to_string(int.absolute_value(unique()))
  <> ".sock"
}

fn setup(auto_init: Bool) -> #(codex.Codex, Subject(Event), Subject(Control)) {
  let path = socket_path()
  let events = process.new_subject()
  let control = script_stub.start(path, events, auto_init)
  let name: codex.Codex = process.new_name("tracked_test")
  let assert Ok(_) = codex.start(name, "stub", codex.UnixSock(path))
  #(name, events, control)
}

fn track_async(
  cx: codex.Codex,
  method: String,
  timeout: Int,
) -> Subject(codex.TrackedReply) {
  let results = process.new_subject()
  let _ =
    process.spawn(fn() {
      process.send(
        results,
        codex.request_tracked(cx, method, json.object([]), timeout),
      )
    })
  results
}

/// #(pending, queued) request counts from the manager's own diagnostics.
fn outstanding(cx: codex.Codex) -> #(Int, Int) {
  let text = json.to_string(codex.diagnostic_snapshot(cx))
  let assert Ok(pending) =
    json.parse(text, decode.at(["pending"], decode.list(decode.dynamic)))
  let assert Ok(queued) =
    json.parse(text, decode.at(["queuedCount"], decode.int))
  #(list.length(pending), queued)
}

pub fn expired_while_queued_is_never_written_test() {
  let #(cx, events, control) = setup(False)
  let results = track_async(cx, "relay/probe", 150)
  let assert Ok(init) = script_stub.expect(events, "initialize", 2000)
  let assert Ok(codex.TrackedReply(0, Error(codex.NotSent(_)))) =
    process.receive(results, 1000)
  // The handshake completes only now; the expired request must stay unsent.
  script_stub.reply(control, init.id, json.object([]))
  let assert Ok(_) = script_stub.expect(events, "initialized", 1000)
  script_stub.collect(events, "relay/probe", 300) |> should.equal([])
  outstanding(cx) |> should.equal(#(0, 0))
}

/// The connection becomes ready after the deadline but before the manager
/// has processed the request's expiry timer: the flush itself must refuse.
pub fn ready_after_deadline_is_never_written_test() {
  let #(cx, events, control) = setup(False)
  let results = track_async(cx, "relay/probe", 150)
  let assert Ok(init) = script_stub.expect(events, "initialize", 2000)
  let assert Ok(pid) = process.named(cx)
  suspend(pid)
  // The handshake reply lands in the mailbox ahead of the expiry timer.
  script_stub.reply(control, init.id, json.object([]))
  process.sleep(300)
  resume(pid)
  let assert Ok(codex.TrackedReply(0, Error(codex.NotSent(_)))) =
    process.receive(results, 1000)
  script_stub.collect(events, "relay/probe", 300) |> should.equal([])
}

pub fn expired_after_write_drops_late_reply_test() {
  let #(cx, events, control) = setup(True)
  let results = track_async(cx, "relay/probe", 150)
  let assert Ok(frame) = script_stub.expect(events, "relay/probe", 2000)
  let assert Ok(codex.TrackedReply(generation, Error(codex.Expired))) =
    process.receive(results, 1000)
  should.be_true(generation > 0)
  outstanding(cx) |> should.equal(#(0, 0))
  // A reply after expiry is dropped without disturbing the manager.
  script_stub.reply(control, frame.id, json.object([]))
  let next = track_async(cx, "relay/next", 2000)
  let assert Ok(second) = script_stub.expect(events, "relay/next", 2000)
  script_stub.reply(control, second.id, json.object([#("ok", json.bool(True))]))
  let assert Ok(codex.TrackedReply(same, Ok(_))) = process.receive(next, 1000)
  same |> should.equal(generation)
}

pub fn backend_error_is_rejected_with_code_and_message_test() {
  let #(cx, events, control) = setup(True)
  let results = track_async(cx, "turn/steer", 2000)
  let assert Ok(frame) = script_stub.expect(events, "turn/steer", 2000)
  script_stub.reply_error(control, frame.id, -32_600, "no active turn to steer")
  let assert Ok(codex.TrackedReply(
    _,
    Error(codex.Rejected(-32_600, "no active turn to steer")),
  )) = process.receive(results, 1000)
}

pub fn connection_lost_after_write_is_lost_test() {
  let #(cx, events, control) = setup(True)
  let results = track_async(cx, "relay/probe", 2000)
  let assert Ok(_) = script_stub.expect(events, "relay/probe", 2000)
  process.send(control, script_stub.Kill)
  let assert Ok(codex.TrackedReply(generation, Error(codex.Lost(_)))) =
    process.receive(results, 2000)
  should.be_true(generation > 0)
}

pub fn connect_failure_is_not_sent_test() {
  let name: codex.Codex = process.new_name("tracked_test_missing")
  let assert Ok(_) = codex.start(name, "missing", codex.UnixSock(socket_path()))
  let assert codex.TrackedReply(0, Error(codex.NotSent(_))) =
    codex.request_tracked(name, "relay/probe", json.object([]), 5000)
}

pub fn no_manager_is_not_sent_test() {
  let name: codex.Codex = process.new_name("tracked_test_absent")
  let assert codex.TrackedReply(0, Error(codex.NotSent(_))) =
    codex.request_tracked(name, "relay/probe", json.object([]), 100)
}

/// A backend that stays connected but never answers: manager-side request
/// state is released at each deadline instead of growing.
pub fn silent_backend_does_not_accumulate_pending_test() {
  let #(cx, _events, _control) = setup(True)
  let results = process.new_subject()
  list.repeat(Nil, 40)
  |> list.each(fn(_) {
    let _ =
      process.spawn(fn() {
        process.send(
          results,
          codex.request_tracked(cx, "relay/probe", json.object([]), 100),
        )
      })
    Nil
  })
  let replies =
    list.repeat(Nil, 40)
    |> list.map(fn(_) {
      let assert Ok(reply) = process.receive(results, 2000)
      reply.result
    })
  list.all(replies, fn(result) { result == Error(codex.Expired) })
  |> should.be_true
  outstanding(cx) |> should.equal(#(0, 0))
  codex.info(cx).state |> should.equal("connected")
}

/// The caller disappearing does not leave its request behind.
pub fn caller_death_releases_pending_test() {
  let #(cx, events, _control) = setup(True)
  let caller =
    process.spawn_unlinked(fn() {
      codex.request_tracked(cx, "relay/probe", json.object([]), 150)
      Nil
    })
  let assert Ok(_) = script_stub.expect(events, "relay/probe", 2000)
  process.kill(caller)
  process.sleep(300)
  outstanding(cx) |> should.equal(#(0, 0))
}

pub fn lifecycle_carries_generations_test() {
  let #(cx, events, control) = setup(True)
  let life = process.new_subject()
  codex.subscribe_lifecycle(cx, process.self(), life)
  // Connect by sending something.
  let results = track_async(cx, "relay/probe", 2000)
  let assert Ok(frame) = script_stub.expect(events, "relay/probe", 2000)
  let assert Ok(codex.Connected("stub", first)) = process.receive(life, 1000)
  script_stub.reply(control, frame.id, json.object([]))
  let assert Ok(codex.TrackedReply(written, Ok(_))) =
    process.receive(results, 1000)
  written |> should.equal(first)

  script_stub.notify(
    control,
    "turn/started",
    json.object([
      #("threadId", json.string("thr-1")),
      #(
        "turn",
        json.object([
          #("id", json.string("turn-1")),
          #("status", json.string("inProgress")),
          #("items", json.preprocessed_array([])),
        ]),
      ),
    ]),
  )
  let assert Ok(codex.TurnStarted("stub", g, "thr-1", "turn-1")) =
    process.receive(life, 1000)
  g |> should.equal(first)

  process.send(control, script_stub.Kill)
  let assert Ok(codex.Disconnected("stub", gone)) = process.receive(life, 2000)
  gone |> should.equal(first)

  // The next connection has a fresh generation, and a late subscriber is
  // told about it immediately.
  let results = track_async(cx, "relay/again", 2000)
  let assert Ok(frame) = script_stub.expect(events, "relay/again", 2000)
  let assert Ok(codex.Connected("stub", second)) = process.receive(life, 1000)
  should.be_true(second != first)
  script_stub.reply(control, frame.id, json.object([]))
  let assert Ok(_) = process.receive(results, 1000)
  let late = process.new_subject()
  let _ =
    process.spawn(fn() {
      let inner = process.new_subject()
      codex.subscribe_lifecycle(cx, process.self(), inner)
      let assert Ok(event) = process.receive(inner, 1000)
      process.send(late, event)
    })
  let assert Ok(codex.Connected("stub", current)) = process.receive(late, 1000)
  current |> should.equal(second)
}
