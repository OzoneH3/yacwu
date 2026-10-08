//// The session relay actor: owns `relay_core` state and performs its
//// effects. It never waits on a backend itself — delivery attempts and
//// recovery reads run in monitored worker processes and report back by
//// message — so one stuck backend cannot stall sends, settings or reads for
//// anyone else. State is in memory only and is lost on restart (a new
//// `epoch` tells browsers to drop what they knew).

import exception
import gleam/bit_array
import gleam/crypto
import gleam/dict.{type Dict}
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/erlang/process.{type Monitor, type Name, type Pid, type Subject}
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/otp/actor
import gleam/otp/supervision
import gleam/result
import gleam/string
import yacwu/codex.{type Codex}
import yacwu/jsonx
import yacwu/relay_core.{type Address, type Message}

pub type Relay =
  Name(Msg)

/// How the relay reaches backends. Injected so tests can point it at stub
/// managers instead of the host registry.
pub type Backends {
  Backends(
    resolve: fn(String) -> Result(Codex, String),
    subscribe: fn(Pid, Subject(codex.Lifecycle)) -> Nil,
  )
}

pub type Timeouts {
  Timeouts(steer: Int, read: Int, tick: Int)
}

pub fn default_timeouts() -> Timeouts {
  Timeouts(steer: 30_000, read: 15_000, tick: 15_000)
}

/// Queued messages reserved to ride along with a user's `turn/start`.
pub type Claim {
  Claim(submission: String, text: String)
}

pub opaque type Msg {
  Send(
    input: relay_core.SendInput,
    reply: Subject(Result(relay_core.SendResult, String)),
  )
  ClaimStart(to: Address, owner: Pid, reply: Subject(Option(Claim)))
  Dispatching(submission: String)
  Finished(submission: String, reply: codex.TrackedReply)
  RecoveryDone(
    ticket: Int,
    generation: Int,
    outcome: relay_core.RecoveryOutcome,
  )
  Life(codex.Lifecycle)
  Down(pid: Pid)
  Wake
  Tick
  SetEnabled(thread: String, enabled: Bool, reply: Subject(Bool))
  IsEnabled(thread: String, reply: Subject(Bool))
  ForThread(thread: String, reply: Subject(#(String, List(Message))))
  GetMessage(id: String, reply: Subject(Result(Message, Nil)))
  Subscribe(owner: Pid, subject: Subject(String))
}

type Work {
  SteerWork(submission: String)
  ReadWork(ticket: Int)
  /// The HTTP handler carrying an injected `turn/start`.
  OwnerWork(submission: String)
}

type State {
  State(
    core: relay_core.Core,
    self: Subject(Msg),
    life: Subject(codex.Lifecycle),
    backends: Backends,
    timeouts: Timeouts,
    work: Dict(Pid, #(Work, Monitor)),
    subscribers: List(#(Pid, Subject(String))),
    /// The earliest Wake already scheduled (monotonic ms), if any.
    next_wake: Option(Int),
  )
}

/// The VM's monotonic clock in ms. It may be negative; only differences
/// and comparisons between its readings are meaningful.
fn clock(_state: State) -> Int {
  codex.now_ms()
}

pub fn supervised(
  name: Relay,
  backends: Backends,
) -> supervision.ChildSpecification(Subject(Msg)) {
  supervision.worker(fn() {
    start(name, backends, relay_core.default_limits(), default_timeouts())
  })
}

pub fn start(
  name: Relay,
  backends: Backends,
  limits: relay_core.Limits,
  timeouts: Timeouts,
) -> actor.StartResult(Subject(Msg)) {
  actor.new_with_initialiser(1000, fn(subject) {
    let life = process.new_subject()
    let selector =
      process.new_selector()
      |> process.select(subject)
      |> process.select_map(life, Life)
      |> process.select_monitors(fn(down) {
        case down {
          process.ProcessDown(pid: pid, ..) -> Down(pid)
          process.PortDown(..) -> Wake
        }
      })
    backends.subscribe(process.self(), life)
    let _ = process.send_after(subject, timeouts.tick, Tick)
    let epoch =
      crypto.strong_random_bytes(6)
      |> bit_array.base16_encode
      |> string.lowercase
    State(
      core: relay_core.new(epoch, limits),
      self: subject,
      life: life,
      backends: backends,
      timeouts: timeouts,
      work: dict.new(),
      subscribers: [],
      next_wake: None,
    )
    |> actor.initialised
    |> actor.selecting(selector)
    |> actor.returning(subject)
    |> Ok
  })
  |> actor.named(name)
  |> actor.on_message(handle)
  |> actor.start
}

// -- Public API ---------------------------------------------------------------

fn call(
  relay: Relay,
  timeout: Int,
  make: fn(Subject(a)) -> Msg,
) -> Result(a, Nil) {
  exception.rescue(fn() {
    process.call(process.named_subject(relay), timeout, make)
  })
  |> result.replace_error(Nil)
}

pub fn send(
  relay: Relay,
  input: relay_core.SendInput,
) -> Result(relay_core.SendResult, String) {
  call(relay, 5000, Send(input, _))
  |> result.unwrap(Error("the relay is restarting; try again shortly"))
}

/// Reserve queued messages for the `turn/start` the caller is about to
/// send. The caller is monitored until it reports `finish`.
pub fn claim_start(relay: Relay, to: Address) -> Option(Claim) {
  call(relay, 5000, ClaimStart(to, process.self(), _)) |> result.unwrap(None)
}

/// Report that the claimed submission is about to be written.
pub fn dispatching(relay: Relay, submission: String) -> Nil {
  let _ =
    exception.rescue(fn() {
      process.send(process.named_subject(relay), Dispatching(submission))
    })
  Nil
}

pub fn finish(
  relay: Relay,
  submission: String,
  reply: codex.TrackedReply,
) -> Nil {
  let _ =
    exception.rescue(fn() {
      process.send(process.named_subject(relay), Finished(submission, reply))
    })
  Nil
}

pub fn set_enabled(
  relay: Relay,
  thread: String,
  enabled: Bool,
) -> Result(Bool, Nil) {
  call(relay, 5000, SetEnabled(thread, enabled, _))
}

pub fn is_enabled(relay: Relay, thread: String) -> Bool {
  call(relay, 5000, IsEnabled(thread, _)) |> result.unwrap(True)
}

/// The current epoch and the retained messages sent by or to `thread`.
pub fn for_thread(
  relay: Relay,
  thread: String,
) -> Result(#(String, List(Message)), Nil) {
  call(relay, 5000, ForThread(thread, _))
}

pub fn get_message(relay: Relay, id: String) -> Result(Message, Nil) {
  call(relay, 5000, GetMessage(id, _)) |> result.unwrap(Error(Nil))
}

/// Receive `yacwu/relay/update` notifications as JSON text (for SSE).
/// Idempotent per owner.
pub fn subscribe(relay: Relay, owner: Pid, subject: Subject(String)) -> Nil {
  let _ =
    exception.rescue(fn() {
      process.send(process.named_subject(relay), Subscribe(owner, subject))
    })
  Nil
}

// -- JSON ---------------------------------------------------------------------

pub fn state_name(state: relay_core.MessageState) -> String {
  case state {
    relay_core.Queued -> "queued"
    relay_core.Reserved -> "sending"
    relay_core.Accepted -> "accepted"
    relay_core.Uncertain -> "uncertain"
    relay_core.Rejected -> "rejected"
  }
}

fn address_json(address: Address) -> Json {
  json.object([
    #("host", json.string(address.host)),
    #("thread", json.string(address.thread)),
  ])
}

pub fn message_json(m: Message) -> Json {
  json.object([
    #("id", json.string(m.id)),
    #("from", address_json(m.from)),
    #("to", address_json(m.to)),
    #("text", json.string(m.text)),
    #("state", json.string(state_name(m.state))),
    #("reason", json.string(m.reason)),
    #("submission", json.string(m.submission)),
    #("turnId", json.string(m.turn)),
    #("generation", json.int(m.generation)),
    #("createdAt", json.int(m.created_at)),
    #("version", json.int(m.version)),
    // What an acknowledgement from this recipient's backend means.
    #(
      "ack",
      json.string(case m.provider {
        relay_core.CodexBackend -> "backend"
        relay_core.ClaudeAdapter -> "adapterRecorded"
      }),
    ),
  ])
}

// -- Actor --------------------------------------------------------------------

fn handle(state: State, msg: Msg) -> actor.Next(State, Msg) {
  let now = clock(state)
  case msg {
    Send(input, reply) -> {
      let #(core, result, effects) = relay_core.send(state.core, now, input)
      process.send(reply, result)
      actor.continue(perform(State(..state, core: core), effects))
    }
    ClaimStart(to, owner, reply) -> {
      let #(core, claim, effects) = relay_core.claim_start(state.core, now, to)
      let state = State(..state, core: core)
      case claim {
        None -> {
          process.send(reply, None)
          actor.continue(perform(state, effects))
        }
        Some(#(sub, text)) -> {
          process.send(reply, Some(Claim(sub.id, text)))
          let state = watch(state, owner, OwnerWork(sub.id))
          actor.continue(perform(state, effects))
        }
      }
    }
    Dispatching(sub) ->
      actor.continue(
        State(..state, core: relay_core.dispatched(state.core, sub)),
      )
    Finished(sub, reply) -> {
      let state = unwatch_submission(state, sub)
      let #(core, effects) =
        relay_core.finish(
          state.core,
          now,
          sub,
          reply.generation,
          outcome(reply),
        )
      actor.continue(perform(State(..state, core: core), effects))
    }
    RecoveryDone(ticket, generation, result) -> {
      let #(core, effects) =
        relay_core.recovered(state.core, now, ticket, generation, result)
      actor.continue(perform(State(..state, core: core), effects))
    }
    Life(event) -> {
      let #(core, effects) = relay_core.lifecycle(state.core, now, event)
      actor.continue(perform(State(..state, core: core), effects))
    }
    Down(pid) ->
      case dict.get(state.work, pid) {
        Ok(#(work, _)) -> {
          let state = State(..state, work: dict.delete(state.work, pid))
          let #(core, effects) = case work {
            SteerWork(sub) | OwnerWork(sub) ->
              relay_core.attempt_lost(state.core, now, sub)
            ReadWork(ticket) ->
              relay_core.recovered(
                state.core,
                now,
                ticket,
                0,
                relay_core.ReadFailed("the recovery worker stopped"),
              )
          }
          actor.continue(perform(State(..state, core: core), effects))
        }
        Error(_) ->
          actor.continue(
            State(
              ..state,
              subscribers: list.filter(state.subscribers, fn(s) { s.0 != pid }),
            ),
          )
      }
    Wake -> {
      let #(core, effects) = relay_core.tick(state.core, now)
      actor.continue(perform(
        State(..state, core: core, next_wake: None),
        effects,
      ))
    }
    Tick -> {
      // Re-subscribing is idempotent and heals a restarted registry.
      state.backends.subscribe(process.self(), state.life)
      let _ = process.send_after(state.self, state.timeouts.tick, Tick)
      let #(core, effects) = relay_core.tick(state.core, now)
      actor.continue(perform(State(..state, core: core), effects))
    }
    SetEnabled(thread, enabled, reply) -> {
      let #(core, effects) =
        relay_core.set_enabled(state.core, now, thread, enabled)
      process.send(reply, enabled)
      actor.continue(perform(State(..state, core: core), effects))
    }
    IsEnabled(thread, reply) -> {
      process.send(reply, relay_core.enabled(state.core, thread))
      actor.continue(state)
    }
    ForThread(thread, reply) -> {
      process.send(reply, #(
        relay_core.epoch(state.core),
        relay_core.for_thread(state.core, thread),
      ))
      actor.continue(state)
    }
    GetMessage(id, reply) -> {
      process.send(reply, relay_core.message(state.core, id))
      actor.continue(state)
    }
    Subscribe(owner, subject) -> {
      let known = list.any(state.subscribers, fn(s) { s.0 == owner })
      case known {
        True -> Nil
        False -> {
          let _ = process.monitor(owner)
          Nil
        }
      }
      actor.continue(
        State(..state, subscribers: [
          #(owner, subject),
          ..list.filter(state.subscribers, fn(s) { s.0 != owner })
        ]),
      )
    }
  }
}

fn outcome(reply: codex.TrackedReply) -> relay_core.Outcome {
  case reply.result {
    Ok(value) ->
      relay_core.Acknowledged(
        jsonx.field_string(value, ["turnId"])
        |> result.lazy_or(fn() { jsonx.field_string(value, ["turn", "id"]) })
        |> result.unwrap(""),
      )
    Error(codex.Rejected(code, message)) ->
      relay_core.BackendError(code, message)
    Error(codex.NotSent(reason)) -> relay_core.NeverSent(reason)
    Error(codex.Lost(reason)) -> relay_core.Unconfirmed(reason)
    Error(codex.Expired) ->
      relay_core.Unconfirmed("no answer from the backend before the deadline")
  }
}

fn watch(state: State, pid: Pid, work: Work) -> State {
  let monitor = process.monitor(pid)
  State(..state, work: dict.insert(state.work, pid, #(work, monitor)))
}

/// An owner that reported its outcome is no longer watched.
fn unwatch_submission(state: State, sub: String) -> State {
  let entries =
    dict.to_list(state.work)
    |> list.filter(fn(entry) {
      case entry.1.0 {
        OwnerWork(s) -> s == sub
        _ -> False
      }
    })
  list.fold(entries, state, fn(state, entry) {
    process.demonitor_process(entry.1.1)
    State(..state, work: dict.delete(state.work, entry.0))
  })
}

fn perform(state: State, effects: List(relay_core.Effect)) -> State {
  list.fold(effects, state, fn(state, effect) {
    case effect {
      relay_core.Publish(m) -> {
        let text =
          json.to_string(
            json.object([
              #("method", json.string("yacwu/relay/update")),
              #(
                "params",
                json.object([
                  #("epoch", json.string(relay_core.epoch(state.core))),
                  #("message", message_json(m)),
                ]),
              ),
            ]),
          )
        list.each(state.subscribers, fn(s) { process.send(s.1, text) })
        state
      }
      relay_core.WakeAt(at) -> {
        let now = clock(state)
        let needed = case state.next_wake {
          None -> True
          Some(scheduled) -> at < scheduled || scheduled <= now
        }
        case needed {
          False -> state
          True -> {
            let _ =
              process.send_after(state.self, int.max(at - now, 0) + 1, Wake)
            State(..state, next_wake: Some(at))
          }
        }
      }
      relay_core.StartSteer(sub, to, turn, text) -> {
        let relay = state.self
        let backends = state.backends
        let timeout = state.timeouts.steer
        let pid =
          process.spawn_unlinked(fn() {
            case backends.resolve(to.host) {
              Error(reason) ->
                process.send(
                  relay,
                  Finished(
                    sub,
                    codex.TrackedReply(0, Error(codex.NotSent(reason))),
                  ),
                )
              Ok(cx) -> {
                process.send(relay, Dispatching(sub))
                let reply =
                  codex.request_tracked(
                    cx,
                    "turn/steer",
                    json.object([
                      #("threadId", json.string(to.thread)),
                      #("expectedTurnId", json.string(turn)),
                      #(
                        "input",
                        json.preprocessed_array([
                          json.object([
                            #("type", json.string("text")),
                            #("text", json.string(text)),
                          ]),
                        ]),
                      ),
                      #("clientUserMessageId", json.string(sub)),
                    ]),
                    timeout,
                  )
                process.send(relay, Finished(sub, reply))
              }
            }
          })
        watch(state, pid, SteerWork(sub))
      }
      relay_core.StartRecovery(ticket, to) -> {
        let relay = state.self
        let backends = state.backends
        let timeout = state.timeouts.read
        let pid =
          process.spawn_unlinked(fn() {
            let #(generation, result) = case backends.resolve(to.host) {
              Error(reason) -> #(0, relay_core.ReadFailed(reason))
              Ok(cx) -> recover(cx, to.thread, timeout)
            }
            process.send(relay, RecoveryDone(ticket, generation, result))
          })
        watch(state, pid, ReadWork(ticket))
      }
    }
  })
}

/// Establish a recipient's runtime from the backend: the thread's runtime
/// status (`thread/read`, metadata only), then — only when active — its
/// in-progress turn (`thread/turns/list`). Both reads must come from the
/// same connection. Anything short of exactly one in-progress turn on an
/// active thread is inconclusive.
pub fn recover(
  cx: Codex,
  thread: String,
  timeout: Int,
) -> #(Int, relay_core.RecoveryOutcome) {
  let read =
    codex.request_tracked(
      cx,
      "thread/read",
      json.object([
        #("threadId", json.string(thread)),
        #("includeTurns", json.bool(False)),
      ]),
      timeout,
    )
  case read.result {
    Error(codex.Rejected(_, message)) ->
      case relay_core.missing_thread(message) {
        True -> #(read.generation, relay_core.Gone(message))
        False -> #(0, relay_core.ReadFailed(message))
      }
    Error(failure) -> #(0, relay_core.ReadFailed(describe(failure)))
    Ok(value) ->
      case jsonx.field_string(value, ["thread", "status", "type"]) {
        Ok("idle") | Ok("notLoaded") -> #(read.generation, relay_core.FoundIdle)
        Ok("active") -> active_turn(cx, thread, timeout, read.generation)
        Ok(other) -> #(
          read.generation,
          relay_core.Inconclusive("thread status is " <> other),
        )
        Error(_) -> #(
          read.generation,
          relay_core.Inconclusive("the thread read carried no runtime status"),
        )
      }
  }
}

fn active_turn(
  cx: Codex,
  thread: String,
  timeout: Int,
  generation: Int,
) -> #(Int, relay_core.RecoveryOutcome) {
  // codex returns newest first and honours `limit`; the Claude adapter
  // ignores both and returns every turn. Either way, look for the turn
  // whose own status is in progress rather than trusting position.
  let page =
    codex.request_tracked(
      cx,
      "thread/turns/list",
      json.object([
        #("threadId", json.string(thread)),
        #("limit", json.int(20)),
        #("sortDirection", json.string("desc")),
        #("itemsView", json.string("notLoaded")),
      ]),
      timeout,
    )
  case page.result {
    Error(failure) -> #(0, relay_core.ReadFailed(describe(failure)))
    Ok(_) if page.generation != generation -> #(
      0,
      relay_core.ReadFailed("the connection changed between recovery reads"),
    )
    Ok(value) -> {
      let turns =
        decode.run(value, decode.at(["data"], decode.list(decode.dynamic)))
        |> result.unwrap([])
      in_progress(turns, generation)
    }
  }
}

fn in_progress(
  turns: List(Dynamic),
  generation: Int,
) -> #(Int, relay_core.RecoveryOutcome) {
  let running =
    list.filter_map(turns, fn(turn) {
      case jsonx.field_string(turn, ["status"]) {
        Ok("inProgress") -> jsonx.field_string(turn, ["id"])
        _ -> Error(Nil)
      }
    })
  case running {
    [turn] -> #(generation, relay_core.FoundActive(turn))
    [] -> #(
      generation,
      relay_core.Inconclusive(
        "the thread is active but lists no turn in progress",
      ),
    )
    _ -> #(
      generation,
      relay_core.Inconclusive("the thread lists several turns in progress"),
    )
  }
}

fn describe(failure: codex.Failure) -> String {
  case failure {
    codex.NotSent(reason) -> "not sent: " <> reason
    codex.Rejected(code, message) ->
      "rejected (" <> int.to_string(code) <> "): " <> message
    codex.Lost(reason) -> "connection lost: " <> reason
    codex.Expired -> "no answer before the deadline"
  }
}
