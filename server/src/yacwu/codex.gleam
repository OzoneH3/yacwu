//// Manager for one `codex app-server`, local or remote.
////
//// Multiplexes many threads (sessions) over one JSON-RPC connection. Every
//// codex notification carries `params.threadId`, so the frontend can route
//// events to the right session. There is no database here: codex persists
//// its own sessions on disk and we read them back via `thread/list` and
//// `thread/read`.
////
//// Transports:
////
//// - `Local`: a child app-server speaking newline-delimited JSON over
////   stdio — `codex app-server`, or an alternative backend command (see
////   `backends`). Spawned lazily on the first request and respawned on the
////   next request after it exits — the original behaviour.
//// - `UnixSock`: an already-running app-server listening on a Unix socket
////   (codex's WebSocket transport). The server outlives this manager.
//// - `Ssh`: a persistent app-server on a remote machine, reached through an
////   `ssh -N -L` Unix-socket forward and bootstrapped over ssh on demand
////   (see `remote`). The remote server outlives yacwu and every SSH drop:
////   on disconnect the manager reconnects with backoff, re-initializes (the
////   handshake is per-connection by design), and re-resumes the threads it
////   had open so notifications flow again. In-flight turns keep running on
////   the remote machine while we are away.

import envoy
import exception
import gleam/bit_array
import gleam/dict.{type Dict}
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/erlang/atom
import gleam/erlang/port.{type Port}
import gleam/erlang/process.{type Name, type Pid, type Subject}
import gleam/int
import gleam/io
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/otp/actor
import gleam/result
import gleam/string
import yacwu/account_limits
import yacwu/backends
import yacwu/diagnostics
import yacwu/file_access
import yacwu/jsonx
import yacwu/oauth
import yacwu/remote
import yacwu/usage
import yacwu/ws

// Version we report in the `initialize` handshake. We present ourselves as the
// codex CLI rather than as a distinct client, so this tracks the latest codex
// release (`@openai/codex` on npm) rather than yacwu's own version.
const codex_version = "0.147.0"

// -- Erlang port FFI ---------------------------------------------------------
//
// These custom types compile to exactly the Erlang terms `erlang:open_port/2`
// expects: variants without fields become atoms (`binary`, `exit_status`, …)
// and variants with fields become tagged tuples (`{args, [...]}`, `{cd, Dir}`).

type SpawnSpec {
  SpawnExecutable(path: String)
}

type PortOption {
  Binary
  ExitStatus
  UseStdio
  Hide
  Args(List(String))
  Cd(String)
}

@external(erlang, "erlang", "open_port")
fn erl_open_port(spec: SpawnSpec, options: List(PortOption)) -> Port

@external(erlang, "erlang", "port_command")
fn erl_port_command(port: Port, data: BitArray) -> Bool

@external(erlang, "erlang", "port_close")
fn erl_port_close(port: Port) -> Bool

@external(erlang, "erlang", "port_info")
fn erl_port_info(port: Port, item: atom.Atom) -> Dynamic

@external(erlang, "erlang", "is_port")
fn erl_is_port(value: a) -> Bool

@external(erlang, "erlang", "=:=")
fn erl_same_term(a: a, b: b) -> Bool

type SplitOption {
  Global
}

@external(erlang, "binary", "split")
fn binary_split(
  subject: BitArray,
  pattern: BitArray,
  options: List(SplitOption),
) -> List(BitArray)

// -- Public API ---------------------------------------------------------------

/// The default local app-server command.
pub const default_command = ["codex", "app-server"]

/// How to reach the app-server this manager drives.
pub type Transport {
  /// Child process over stdio (the classic local setup): `default_command`,
  /// or an alternative backend's argv.
  Local(command: List(String))
  /// Persistent server on a local Unix socket (WebSocket framing).
  UnixSock(path: String)
  /// Persistent server on `host` from ~/.ssh/config, over a forwarded
  /// Unix socket.
  Ssh(host: String)
  /// Persistent server on this machine, started detached by the same
  /// bootstrap as `Ssh` (socket `<name>.sock`), so it and its running turns
  /// outlive yacwu restarts: codex itself (`command` empty) or a stdio
  /// backend's argv run inside scripts/backend-daemon.mjs.
  LocalDaemon(name: String, command: List(String))
}

pub type Reply =
  Result(Dynamic, String)

/// Why a tracked request produced no result. The variants separate what is
/// known about acceptance: only `NotSent` proves the backend never saw the
/// request; `Rejected` carries the backend's own answer; `Lost` and `Expired`
/// mean it may have been written and acted on.
pub type Failure {
  /// Never written to the backend (deadline passed or the connection failed
  /// while the request was still queued, or no manager was running).
  NotSent(reason: String)
  /// The backend answered with a JSON-RPC error.
  Rejected(code: Int, message: String)
  /// Possibly written; the connection was lost before an answer arrived.
  Lost(reason: String)
  /// Possibly written; the deadline passed before an answer arrived. A later
  /// answer is dropped. The backend is not told to cancel anything.
  Expired
}

/// The outcome of a tracked request and the connection generation it was
/// written on (0 when it was never written).
pub type TrackedReply {
  TrackedReply(generation: Int, result: Result(Dynamic, Failure))
}

/// Connection and turn lifecycle, for in-process subscribers that need to
/// correlate events with the connection they came from. Generations are
/// unique for the VM's lifetime, so a restarted manager never reuses one.
pub type Lifecycle {
  Connected(host: String, generation: Int)
  Disconnected(host: String, generation: Int)
  TurnStarted(host: String, generation: Int, thread: String, turn: String)
  TurnCompleted(host: String, generation: Int, thread: String, turn: String)
}

/// Host connection details for /api/hosts, remote workspace operations,
/// and the UI. `codex_home` and `socket` are only known for SSH transports
/// once a bootstrap has run ("" until then, and always "" for local).
pub type HostInfo {
  HostInfo(
    state: String,
    home: String,
    codex_home: String,
    socket: String,
    error: String,
  )
}

pub opaque type Msg {
  Request(method: String, params: Json, reply: Subject(Reply))
  TrackedRequest(
    method: String,
    params: Json,
    deadline: Int,
    ticket: Int,
    reply: Subject(TrackedReply),
  )
  Expire(ticket: Int)
  Notify(method: String, params: Json)
  Subscribe(owner: Pid, subject: Subject(String))
  SubscribeLifecycle(owner: Pid, subject: Subject(Lifecycle))
  GetOsPid(reply: Subject(Result(Int, Nil)))
  GetInfo(reply: Subject(HostInfo))
  OpenForwarder(
    local: String,
    remote_sock: String,
    reply: Subject(Result(Nil, String)),
  )
  ConnResult(
    Result(#(remote.Socket, BitArray, Option(remote.Bootstrap)), String),
  )
  TryReconnect
  PortData(BitArray)
  PortExit(Int)
  TcpData(BitArray)
  TcpClosed
  SubscriberDown(pid: Pid)
  LinkedExit(exit: process.ExitMessage)
  DiagnosticTick
  GetDiagnostics(reply: Subject(Json))
  AnswerUserInput(
    item_id: String,
    answers: Json,
    reply: Subject(Result(Nil, String)),
  )
  Ignore
}

/// A handle used by HTTP handlers to talk to the manager.
pub type Codex =
  Name(Msg)

/// The working directory codex runs in (`YACWU_CWD`, defaulting to `$HOME`).
pub fn default_cwd() -> String {
  case envoy.get("YACWU_CWD") {
    Ok(cwd) if cwd != "" -> cwd
    _ -> local_home()
  }
}

fn local_home() -> String {
  envoy.get("HOME") |> result.unwrap("/")
}

type TimeUnit {
  Millisecond
}

@external(erlang, "erlang", "monotonic_time")
fn erl_monotonic_time(unit: TimeUnit) -> Int

type UniqueOption {
  Monotonic
  Positive
}

@external(erlang, "erlang", "unique_integer")
fn unique_integer(options: List(UniqueOption)) -> Int

/// Monotonic milliseconds, the clock tracked-request deadlines use.
pub fn now_ms() -> Int {
  erl_monotonic_time(Millisecond)
}

/// Send a request whose whole lifetime — queued before a connection is
/// ready, then pending on the wire — is bounded by `timeout_ms`. Unlike
/// `request`, failures say whether the request can have reached the
/// backend; see `Failure`. The manager answers by the deadline on its own,
/// so a caller never waits much past it.
pub fn request_tracked(
  codex: Codex,
  method: String,
  params: Json,
  timeout_ms: Int,
) -> TrackedReply {
  case process.named(codex) {
    Error(_) -> TrackedReply(0, Error(NotSent("codex manager is not running")))
    Ok(_) -> {
      let ticket = unique_integer([Monotonic, Positive])
      let deadline = now_ms() + timeout_ms
      case
        exception.rescue(fn() {
          process.call(
            process.named_subject(codex),
            timeout_ms + 5000,
            TrackedRequest(method, params, deadline, ticket, _),
          )
        })
      {
        Ok(reply) -> reply
        // The manager died (or stopped answering) after the request was
        // handed over: it may already have written it.
        Error(_) ->
          TrackedReply(0, Error(Lost("codex manager stopped before replying")))
      }
    }
  }
}

/// Receive this manager's connection and turn lifecycle. Idempotent per
/// owner; dropped automatically when `owner` exits. A subscriber that joins
/// while connected is told the current generation straight away.
pub fn subscribe_lifecycle(
  codex: Codex,
  owner: Pid,
  subject: Subject(Lifecycle),
) -> Nil {
  let _ =
    exception.rescue(fn() {
      process.send(
        process.named_subject(codex),
        SubscribeLifecycle(owner, subject),
      )
    })
  Nil
}

/// Send a JSON-RPC request to codex and wait for its response.
pub fn request(codex: Codex, method: String, params: Json) -> Reply {
  case
    exception.rescue(fn() {
      process.call_forever(process.named_subject(codex), Request(
        method,
        params,
        _,
      ))
    })
  {
    Ok(reply) -> reply
    Error(_) -> Error("codex manager is restarting; retry shortly")
  }
}

/// Read manager diagnostics without waiting for a Codex JSON-RPC response.
pub fn diagnostic_snapshot(codex: Codex) -> Json {
  case
    exception.rescue(fn() {
      process.call(process.named_subject(codex), 2000, GetDiagnostics)
    })
  {
    Ok(snapshot) -> snapshot
    Error(_) ->
      json.object([#("connection", json.string("manager_unavailable"))])
  }
}

/// Send a JSON-RPC notification (no response expected).
/// Answer a question the backend asked the user, under its request id.
pub fn answer_user_input(
  codex: Codex,
  item_id: String,
  answers: Json,
) -> Result(Nil, String) {
  exception.rescue(fn() {
    process.call(process.named_subject(codex), 10_000, AnswerUserInput(
      item_id,
      answers,
      _,
    ))
  })
  |> result.replace_error("the backend manager is restarting; retry shortly")
  |> result.flatten
}

pub fn notify(codex: Codex, method: String, params: Json) -> Nil {
  let _ =
    exception.rescue(fn() {
      process.send(process.named_subject(codex), Notify(method, params))
    })
  Nil
}

/// Subscribe `subject` to every codex notification, formatted as raw JSON
/// strings. The subscription is removed automatically when `owner` exits.
pub fn subscribe(codex: Codex, owner: Pid, subject: Subject(String)) -> Nil {
  let _ =
    exception.rescue(fn() {
      process.send(process.named_subject(codex), Subscribe(owner, subject))
    })
  Nil
}

/// OS pid of the managed `codex app-server` process, if it is a local child.
pub fn os_pid(codex: Codex) -> Result(Int, Nil) {
  case
    exception.rescue(fn() {
      process.call_forever(process.named_subject(codex), GetOsPid)
    })
  {
    Ok(pid) -> pid
    Error(_) -> Error(Nil)
  }
}

/// Connection state, home directory and last error for this host.
pub fn info(codex: Codex) -> HostInfo {
  case
    exception.rescue(fn() {
      process.call_forever(process.named_subject(codex), GetInfo)
    })
  {
    Ok(info) -> info
    Error(_) -> HostInfo("disconnected", "", "", "", "manager is restarting")
  }
}

/// Start a manager registered under `name`. `label` is the host name used in
/// `yacwu/host/status` notifications ("local" for the local transport).
pub fn start(
  name: Codex,
  label: String,
  transport: Transport,
) -> actor.StartResult(Subject(Msg)) {
  actor.new_with_initialiser(1000, fn(subject) {
    // The child's port is linked to this actor, and a port can die
    // abnormally out from under us — most notably with `epipe` when the
    // app-server exits (say, after an internal error like a model-refresh
    // timeout) while writes are still in flight. Untrapped, that exit
    // signal kills the manager along with every pending request and the
    // resumed-thread list; trapped, it is just a disconnect.
    process.trap_exits(True)
    let _ = process.send_after(subject, 30_000, DiagnosticTick)
    let selector =
      process.new_selector()
      |> process.select(subject)
      |> process.select_trapped_exits(LinkedExit)
      |> process.select_monitors(fn(down) {
        case down {
          process.ProcessDown(pid: pid, ..) -> SubscriberDown(pid)
          process.PortDown(..) -> Ignore
        }
      })
      |> process.select_other(classify_other)
    initial_state(name, label, transport)
    |> actor.initialised
    |> actor.selecting(selector)
    |> actor.returning(subject)
    |> Ok
  })
  |> actor.named(name)
  |> actor.on_message(handle)
  |> actor.start
}

// -- Internal state -----------------------------------------------------------

/// A request waiting for the connection to become ready. It has not been
/// written anywhere yet.
type Queued {
  Queued(method: String, params: Json, waiter: Waiter)
}

type Waiter {
  Plain(reply: Subject(Reply))
  /// `deadline` is absolute (`now_ms`); `ticket` identifies the request
  /// before it has a wire id.
  Tracked(ticket: Int, deadline: Int, reply: Subject(TrackedReply))
}

/// Whoever waits on a pending request: an HTTP caller, or nobody (requests
/// the manager sends on its own behalf, like post-reconnect re-resumes).
type ReplyTo {
  Caller(Subject(Reply))
  TrackedCaller(ticket: Int, reply: Subject(TrackedReply))
  Discard
}

type Pending {
  Pending(
    method: String,
    thread: Option(String),
    reply_to: ReplyTo,
    started_at: Int,
    /// The connection generation the request was written on.
    generation: Int,
    access: String,
  )
}

type Conn {
  PortConn(port: Port)
  SockConn(socket: remote.Socket)
}

type Status {
  NotRunning
  /// A connector process is establishing the remote connection.
  Connecting(queued: List(Queued))
  Initializing(conn: Conn, init_id: Int, queued: List(Queued))
  Running(conn: Conn)
}

type State {
  State(
    self: Codex,
    label: String,
    transport: Transport,
    status: Status,
    next_id: Int,
    pending: Dict(Int, Pending),
    account_cache: Dict(String, #(Int, Reply)),
    limit_stops: Dict(String, #(String, Int)),
    account_waiters: Dict(String, List(Subject(Reply))),
    next_usage_at: Int,
    subscribers: List(#(Pid, Subject(String))),
    buffer: BitArray,
    decoder: ws.Decoder,
    forwarder: Option(Port),
    /// The unlinked connection-setup process, monitored while `Connecting`.
    connector: Option(Pid),
    /// Threads resumed/started over this manager — re-resumed after a
    /// reconnect so their notifications keep flowing.
    resumed: List(String),
    /// Whether this manager has looked for threads a persistent backend was
    /// already running when it first connected (see `adopt_running_threads`).
    adopted: Bool,
    home: String,
    codex_home: String,
    remote_sock: String,
    /// The detached local server's OS pid (`LocalDaemon` only).
    daemon_pid: Result(Int, Nil),
    backoff: Int,
    last_error: String,
    activity: diagnostics.Tracker,
    silent_alerted: List(String),
    last_diagnostic_at: Int,
    last_received_at: Int,
    /// Unique id of the current initialized connection; 0 while there is
    /// none. Lets subscribers tell events and replies from different
    /// connections apart.
    generation: Int,
    /// Tracked tickets already written, mapped to their wire ids.
    tickets: Dict(Int, Int),
    lifecycle: List(#(Pid, Subject(Lifecycle))),
    /// Questions a backend asked the user (`item/tool/requestUserInput`),
    /// by item id, with the request's wire id to answer under.
    user_input: Dict(String, Dynamic),
    claude_read_only_support: Bool,
  )
}

fn initial_state(self: Codex, label: String, transport: Transport) -> State {
  usage.record(label, "collectorStarted", [])
  State(
    self: self,
    label: label,
    transport: transport,
    status: NotRunning,
    next_id: 1,
    pending: dict.new(),
    account_cache: dict.new(),
    limit_stops: dict.new(),
    account_waiters: dict.new(),
    next_usage_at: 0,
    subscribers: [],
    buffer: <<>>,
    decoder: ws.new_decoder(),
    forwarder: None,
    connector: None,
    resumed: [],
    adopted: False,
    home: case transport {
      Ssh(_) -> ""
      _ -> local_home()
    },
    codex_home: "",
    remote_sock: "",
    daemon_pid: Error(Nil),
    backoff: 0,
    last_error: "",
    activity: dict.new(),
    silent_alerted: [],
    last_diagnostic_at: 0,
    last_received_at: 0,
    generation: 0,
    tickets: dict.new(),
    lifecycle: [],
    user_input: dict.new(),
    claude_read_only_support: False,
  )
}

/// Raw port and socket messages arrive as bare tuples rather than typed
/// subject messages: `{Port, {data, Bin}}`, `{Port, {exit_status, Code}}`,
/// `{tcp, Sock, Data}`, `{tcp_closed, Sock}`, `{tcp_error, Sock, Reason}`.
fn classify_other(message: Dynamic) -> Msg {
  let tag =
    decode.run(message, decode.at([0], atom.decoder()))
    |> result.map(atom.to_string)
  case tag {
    Ok("tcp") ->
      case decode.run(message, decode.at([2], decode.bit_array)) {
        Ok(data) -> TcpData(data)
        Error(_) -> Ignore
      }
    Ok("tcp_closed") | Ok("tcp_error") -> TcpClosed
    _ ->
      case decode.run(message, decode.at([1, 1], decode.bit_array)) {
        Ok(data) -> PortData(data)
        Error(_) ->
          case decode.run(message, decode.at([1, 1], decode.int)) {
            Ok(code) -> PortExit(code)
            Error(_) -> Ignore
          }
      }
  }
}

fn handle(state: State, msg: Msg) -> actor.Next(State, Msg) {
  case msg {
    Request(method, params, reply) ->
      case method {
        "yacwu/fileAccess/read" | "yacwu/fileAccess/set" ->
          session_file_access(state, method, params, reply)
        "account/read" | "account/rateLimits/read" ->
          account_request(state, method, params, reply)
        _ -> on_request(state, Queued(method, params, Plain(reply)))
      }
    TrackedRequest(method, params, deadline, ticket, reply) -> {
      let now = now_ms()
      case deadline <= now {
        True -> {
          process.send(
            reply,
            TrackedReply(0, Error(NotSent("deadline passed before sending"))),
          )
          actor.continue(state)
        }
        False -> {
          let _ =
            process.send_after(
              process.named_subject(state.self),
              deadline - now,
              Expire(ticket),
            )
          on_request(
            state,
            Queued(method, params, Tracked(ticket, deadline, reply)),
          )
        }
      }
    }
    Expire(ticket) -> actor.continue(expire(state, ticket))
    SubscribeLifecycle(owner, subject) -> {
      let state = case list.any(state.lifecycle, fn(s) { s.0 == owner }) {
        True ->
          State(..state, lifecycle: [
            #(owner, subject),
            ..list.filter(state.lifecycle, fn(s) { s.0 != owner })
          ])
        False -> {
          let _ = process.monitor(owner)
          State(..state, lifecycle: [#(owner, subject), ..state.lifecycle])
        }
      }
      case state.status, state.generation {
        Running(_), generation if generation != 0 ->
          process.send(subject, Connected(state.label, generation))
        _, _ -> Nil
      }
      actor.continue(state)
    }
    AnswerUserInput(item_id, answers, reply) -> {
      case dict.get(state.user_input, item_id), state.status {
        Ok(id), Running(conn) -> {
          write_line(
            conn,
            json.object([
              #("id", jsonx.to_json(id)),
              #("result", json.object([#("answers", answers)])),
            ]),
          )
          process.send(reply, Ok(Nil))
          actor.continue(
            State(..state, user_input: dict.delete(state.user_input, item_id)),
          )
        }
        Ok(_), _ -> {
          process.send(reply, Error("the backend is not connected"))
          actor.continue(state)
        }
        Error(_), _ -> {
          process.send(reply, Error("this question is no longer waiting"))
          actor.continue(state)
        }
      }
    }
    Notify(method, params) -> {
      case state.status {
        Running(conn) | Initializing(conn, _, _) ->
          write_notification(conn, method, params)
        _ -> Nil
      }
      actor.continue(state)
    }
    Subscribe(owner, subject) -> {
      // Idempotent per owner: subscribers re-subscribe to self-heal after
      // registry restarts, and monitors must not accumulate.
      let state = case list.any(state.subscribers, fn(s) { s.0 == owner }) {
        True ->
          State(..state, subscribers: [
            #(owner, subject),
            ..list.filter(state.subscribers, fn(s) { s.0 != owner })
          ])
        False -> {
          let _ = process.monitor(owner)
          State(..state, subscribers: [#(owner, subject), ..state.subscribers])
        }
      }
      actor.continue(replay_silent_alerts(state, subject, oauth.now()))
    }
    SubscriberDown(pid) ->
      case state.connector == Some(pid), state.status {
        // The connection-setup process died without reporting (its 15s call
        // into this actor timed out, or it crashed): fall into the normal
        // connect-failed path instead of stranding `Connecting` forever.
        True, Connecting(_) ->
          on_conn_result(
            State(..state, connector: None),
            Error("connection setup did not complete"),
          )
        True, _ -> actor.continue(State(..state, connector: None))
        False, _ ->
          actor.continue(
            State(
              ..state,
              subscribers: list.filter(state.subscribers, fn(s) { s.0 != pid }),
              lifecycle: list.filter(state.lifecycle, fn(s) { s.0 != pid }),
            ),
          )
      }
    GetOsPid(reply) -> {
      let pid = case state.status {
        Running(PortConn(port)) | Initializing(PortConn(port), _, _) ->
          decode.run(
            erl_port_info(port, atom.create("os_pid")),
            decode.at([1], decode.int),
          )
          |> result.replace_error(Nil)
        Running(SockConn(_)) | Initializing(SockConn(_), _, _) ->
          state.daemon_pid
        _ -> Error(Nil)
      }
      process.send(reply, pid)
      actor.continue(state)
    }
    GetInfo(reply) -> {
      let connection_state = case state.status {
        NotRunning -> "disconnected"
        Connecting(_) | Initializing(_, _, _) -> "connecting"
        Running(_) -> "connected"
      }
      process.send(
        reply,
        HostInfo(
          connection_state,
          state.home,
          state.codex_home,
          state.remote_sock,
          state.last_error,
        ),
      )
      actor.continue(state)
    }
    OpenForwarder(local, remote_sock, reply) ->
      on_open_forwarder(state, local, remote_sock, reply)
    ConnResult(result) -> on_conn_result(state, result)
    TryReconnect ->
      case state.status, state.transport {
        NotRunning, UnixSock(_)
        | NotRunning, Ssh(_)
        | NotRunning, LocalDaemon(_, _)
        ->
          // Reconnect if there are resumed threads OR if a previous connection
          // attempt failed with queued requests still waiting (they were failed
          // but we want to retry). Since TryReconnect is only scheduled if either
          // condition is true, we just attempt to connect.
          begin_connect(state, [])
        _, _ -> actor.continue(state)
      }
    PortData(data) ->
      case state.status {
        Running(PortConn(_)) | Initializing(PortConn(_), _, _) ->
          on_port_data(state, data)
        // Any other port output (the ssh forwarder's stderr) is noise.
        _ -> actor.continue(state)
      }
    PortExit(code) ->
      case state.status {
        Running(PortConn(_)) | Initializing(PortConn(_), _, _) ->
          on_child_exit(state, code)
        // The ssh forwarder exited: the socket (if any) dies with it and
        // that arrives separately as TcpClosed.
        _ -> actor.continue(State(..state, forwarder: None))
      }
    LinkedExit(exit) -> on_linked_exit(state, exit)
    TcpData(data) -> on_tcp_data(state, data)
    TcpClosed ->
      case state.status {
        Running(SockConn(_)) | Initializing(SockConn(_), _, _) ->
          on_disconnect(
            state,
            "connection to " <> backend_name(state) <> " lost",
          )
        _ -> actor.continue(state)
      }
    GetDiagnostics(reply) -> {
      process.send(reply, state_diagnostics(state, oauth.now()))
      actor.continue(state)
    }
    DiagnosticTick -> {
      let state = sample_usage(state) |> enforce_account_limits
      let at = oauth.now()
      let _ = diagnostics.rotate_stderr(state.label)
      let snapshot = state_diagnostics(state, at)
      diagnostics.record(state.label, at, "heartbeat", [#("snapshot", snapshot)])
      let silent = diagnostics.silent_entries(state.activity, at)
      let silent_ids = list.map(silent, fn(entry) { entry.0 })
      let newly_silent =
        list.filter(silent, fn(entry) {
          !list.contains(state.silent_alerted, entry.0)
        })
      let state =
        list.fold(newly_silent, state, fn(state, entry) {
          let #(_, details) = entry
          diagnostics.record(state.label, at, "turn_silent", [
            #("details", details),
          ])
          broadcast_stalled(state, details)
        })
      case
        diagnostics.is_silent(state.activity, at)
        && at - state.last_diagnostic_at >= 120
      {
        True -> {
          diagnostics.record(state.label, at, "turn_silent_snapshot", [
            #("snapshot", snapshot),
          ])
          actor.continue(
            State(..state, silent_alerted: silent_ids, last_diagnostic_at: at),
          )
        }
        False -> actor.continue(State(..state, silent_alerted: silent_ids))
      }
      |> reschedule_diagnostics(state.self)
    }
    Ignore -> actor.continue(state)
  }
}

fn reschedule_diagnostics(
  next: actor.Next(State, Msg),
  self: Codex,
) -> actor.Next(State, Msg) {
  let _ =
    process.send_after(process.named_subject(self), 30_000, DiagnosticTick)
  next
}

fn state_diagnostics(state: State, at: Int) -> Json {
  let connection = case state.status {
    NotRunning -> "disconnected"
    Connecting(_) -> "connecting"
    Initializing(_, _, _) -> "initializing"
    Running(_) -> "connected"
  }
  let pending =
    dict.to_list(state.pending)
    |> list.map(fn(entry) {
      let #(id, request) = entry
      json.object([
        #("id", json.int(id)),
        #("method", json.string(request.method)),
        #("threadId", case request.thread {
          Some(id) -> json.string(id)
          None -> json.null()
        }),
        #("ageSeconds", json.int(at - request.started_at)),
      ])
    })
  let queued = case state.status {
    Connecting(queued) | Initializing(_, _, queued) -> list.length(queued)
    _ -> 0
  }
  let os_pid = case state.status {
    Running(PortConn(port)) | Initializing(PortConn(port), _, _) ->
      exception.rescue(fn() { erl_port_info(port, atom.create("os_pid")) })
      |> result.replace_error(Nil)
      |> result.try(fn(info) {
        decode.run(info, decode.at([1], decode.int))
        |> result.replace_error(Nil)
      })
      |> result.map(json.int)
      |> result.unwrap(json.null())
    _ -> json.null()
  }
  let stats =
    json.parse(json.to_string(os_pid), decode.int)
    |> result.map(diagnostics.process_stats)
    |> result.map(jsonx.to_json)
    |> result.unwrap(json.null())
  let #(events, stderr) = diagnostics.paths(state.label)
  json.object([
    #("at", json.int(at)),
    #("host", json.string(state.label)),
    #("connection", json.string(connection)),
    #("osPid", os_pid),
    #("process", stats),
    #("lastReceivedAt", json.int(state.last_received_at)),
    #("queuedCount", json.int(queued)),
    #("subscriberCount", json.int(list.length(state.subscribers))),
    #("pending", json.preprocessed_array(pending)),
    #("activeTurns", diagnostics.snapshot(state.activity, at)),
    #("eventLog", json.string(events)),
    #("stderrLog", json.string(stderr)),
  ])
}

fn account_provider(state: State) -> String {
  let provider = case state.transport {
    Local(command) | LocalDaemon(_, command) ->
      backends.provider(backends.Backend(state.label, command))
    _ -> "codex"
  }
  case provider {
    "copilot" | "claude" -> provider
    _ -> "codex"
  }
}

/// Only a Claude process with Yacwu's read-only guard can opt into this mode.
fn file_access_provider(state: State) -> String {
  case account_provider(state), state.claude_read_only_support {
    "claude", True -> "claude-read-only"
    provider, _ -> provider
  }
}

fn account_limit_reason(state: State) -> Option(String) {
  let limits = account_limits.load(account_limits.path())
  let #(at, data) = case
    dict.get(state.account_cache, "account/rateLimits/read")
  {
    Ok(#(at, Ok(data))) -> #(at, data)
    _ -> #(0, dynamic.nil())
  }
  account_limits.reason(limits, account_provider(state), data, at, oauth.now())
}

fn enforce_account_limits(state: State) -> State {
  case state.status, account_limit_reason(state) {
    Running(conn), Some(reason) ->
      list.fold(dict.to_list(state.activity), state, fn(state, entry) {
        let #(thread, activity) = entry
        let now = oauth.now()
        let retry = case dict.get(state.limit_stops, thread) {
          Ok(#(turn, at)) -> turn != activity.turn || now - at >= 30
          Error(_) -> True
        }
        case activity.turn != "" && retry {
          False -> state
          True -> {
            let state =
              State(
                ..state,
                limit_stops: dict.insert(state.limit_stops, thread, #(
                  activity.turn,
                  now,
                )),
              )
            let _ =
              diagnostics.record(
                state.label,
                oauth.now(),
                "account_limit_stop",
                [
                  #("threadId", json.string(thread)),
                  #("reason", json.string(reason)),
                ],
              )
            let state =
              broadcast(
                state,
                bit_array.from_string(
                  json.to_string(
                    json.object([
                      #("method", json.string("yacwu/accountLimit/stopped")),
                      #(
                        "params",
                        json.object([
                          #("threadId", json.string(thread)),
                          #("reason", json.string(reason)),
                        ]),
                      ),
                    ]),
                  ),
                ),
              )
            send_request(
              state,
              conn,
              "turn/interrupt",
              json.object([
                #("threadId", json.string(thread)),
                #("turnId", json.string(activity.turn)),
              ]),
              Discard,
            )
          }
        }
      })
    _, _ -> state
  }
}

/// Sample the shared weekly quota; avoid stacking reads if Codex is unresponsive.
fn account_cache_until(method: String, at: Int, reply: Reply) -> Int {
  let normal =
    at
    + case method {
      "account/read" -> 900
      _ -> 120
    }
  case method, reply {
    "account/rateLimits/read", Ok(data) -> {
      let threshold = case jsonx.field_string(data, ["rateLimits", "limitId"]) {
        Ok("claude-code") -> 90.0
        _ -> 100.0
      }
      let resets =
        ["primary", "secondary"]
        |> list.filter_map(fn(window) {
          let used =
            decode.run(
              data,
              decode.at(
                ["rateLimits", window, "usedPercent"],
                decode.one_of(decode.float, [
                  decode.map(decode.int, int.to_float),
                ]),
              ),
            )
            |> result.unwrap(0.0)
          let reset =
            jsonx.field_int(data, ["rateLimits", window, "resetsAt"])
            |> result.unwrap(0)
          case used >=. threshold && reset > at {
            True -> Ok(reset)
            False -> Error(Nil)
          }
        })
      case list.sort(resets, int.compare) |> list.first {
        Ok(reset) -> int.min(reset, at + 900)
        Error(_) -> normal
      }
    }
    _, _ -> normal
  }
}

fn sample_usage(state: State) -> State {
  let now = oauth.now()
  let quota_recent = case
    dict.get(state.account_cache, "account/rateLimits/read")
  {
    Ok(#(at, reply)) ->
      now < account_cache_until("account/rateLimits/read", at, reply)
    Error(_) -> False
  }
  let pending =
    dict.values(state.pending)
    |> list.any(fn(request) { request.method == "account/rateLimits/read" })
  case state.status, pending || quota_recent, now >= state.next_usage_at {
    Running(conn), False, True -> {
      let state = State(..state, next_usage_at: now + 120)
      let account_pending =
        dict.values(state.pending)
        |> list.any(fn(request) { request.method == "account/read" })
      let account_recent = case dict.get(state.account_cache, "account/read") {
        Ok(#(at, _)) -> now - at < 900
        Error(_) -> False
      }
      let state = case account_pending || account_recent {
        False ->
          send_request(
            state,
            conn,
            "account/read",
            json.object([#("refreshToken", json.bool(False))]),
            Discard,
          )
        True -> state
      }
      send_request(
        state,
        conn,
        "account/rateLimits/read",
        json.object([]),
        Discard,
      )
    }
    _, _, _ -> state
  }
}

fn account_request(
  state: State,
  method: String,
  params: Json,
  reply: Subject(Reply),
) -> actor.Next(State, Msg) {
  let now = oauth.now()
  let cached = dict.get(state.account_cache, method)
  let until = case cached {
    Ok(#(at, value)) -> account_cache_until(method, at, value)
    Error(_) -> 0
  }
  case cached {
    Ok(#(_, value)) if now < until -> {
      process.send(reply, value)
      actor.continue(state)
    }
    _ -> {
      let pending =
        dict.values(state.pending)
        |> list.any(fn(request) { request.method == method })
      case pending {
        True -> {
          let waiters =
            dict.get(state.account_waiters, method) |> result.unwrap([])
          actor.continue(
            State(
              ..state,
              account_waiters: dict.insert(state.account_waiters, method, [
                reply,
                ..waiters
              ]),
            ),
          )
        }
        False -> on_request(state, Queued(method, params, Plain(reply)))
      }
    }
  }
}

fn session_file_access(
  state: State,
  method: String,
  params: Json,
  reply: Subject(Reply),
) -> actor.Next(State, Msg) {
  let body = file_access.dynamic(params)
  let thread = jsonx.field_string(body, ["threadId"]) |> result.unwrap("")
  let provider = file_access_provider(state)
  let result = case method {
    "yacwu/fileAccess/read" -> file_access.load(state.label, thread)
    _ -> {
      let mode = jsonx.field_string(body, ["mode"]) |> result.unwrap("")
      let running = case dict.get(state.activity, thread) {
        Ok(activity) -> activity.turn != ""
        Error(_) -> False
      }
      let pending =
        dict.values(state.pending)
        |> list.any(fn(p) {
          p.thread == Some(thread)
          && {
            p.method == "turn/start"
            || p.method == "thread/resume"
            || p.method == "thread/fork"
            || p.method == "turn/steer"
          }
        })
      case running || pending {
        True -> Error("Stop the current turn before changing file access")
        False -> {
          use _ <- result.try(file_access.authorize(provider, mode))
          file_access.save(state.label, thread, mode)
          |> result.map(fn(_) { mode })
        }
      }
    }
  }
  process.send(
    reply,
    result
      |> result.map(fn(mode) {
        file_access.state(mode, provider) |> file_access.dynamic
      }),
  )
  actor.continue(state)
}

fn on_request(state: State, request: Queued) -> actor.Next(State, Msg) {
  case state.status {
    NotRunning -> begin_connect(state, [request])
    Connecting(queued) -> {
      let state = State(..state, status: Connecting([request, ..queued]))
      // Ensure we schedule a reconnect if one isn't already scheduled.
      // Without this, a connection failure leaves queued requests hanging
      // indefinitely for idle sessions with no resumed threads.
      let _ = schedule_reconnect(state)
      actor.continue(state)
    }
    Initializing(conn, init_id, queued) ->
      actor.continue(
        State(..state, status: Initializing(conn, init_id, [request, ..queued])),
      )
    Running(conn) -> actor.continue(dispatch_queued(state, conn, request))
  }
}

/// Write one request that was waiting (or arrived while connected). A
/// tracked request whose deadline has already passed is never written: its
/// `Expire` may still be in the mailbox behind the event that made the
/// connection ready.
fn dispatch_queued(state: State, conn: Conn, request: Queued) -> State {
  let blocked = case request.method {
    "turn/start" | "turn/steer" -> account_limit_reason(state)
    _ -> None
  }
  case blocked {
    Some(reason) -> {
      fail_queued([request], reason)
      state
    }
    None ->
      case
        file_access.prepare(
          state.label,
          file_access_provider(state),
          request.method,
          request.params,
        )
      {
        Error(reason) -> {
          fail_queued([request], reason)
          state
        }
        Ok(params) ->
          dispatch_allowed(state, conn, Queued(..request, params: params))
      }
  }
}

fn dispatch_allowed(state: State, conn: Conn, request: Queued) -> State {
  let Queued(method, params, waiter) = request
  case waiter {
    Plain(reply) -> send_request(state, conn, method, params, Caller(reply))
    Tracked(ticket, deadline, reply) ->
      case deadline <= now_ms() {
        True -> {
          process.send(
            reply,
            TrackedReply(0, Error(NotSent("deadline passed before sending"))),
          )
          state
        }
        False -> {
          let id = state.next_id
          let state =
            send_request(
              state,
              conn,
              method,
              params,
              TrackedCaller(ticket, reply),
            )
          State(..state, tickets: dict.insert(state.tickets, ticket, id))
        }
      }
  }
}

/// A tracked request's deadline passed. Still queued: it was never written,
/// so drop it and say so. Pending: it may have been written; stop waiting
/// and report that, leaving any later answer to be dropped. The backend is
/// not asked to cancel anything.
fn expire(state: State, ticket: Int) -> State {
  let is_ticket = fn(request: Queued) {
    case request.waiter {
      Tracked(t, _, _) -> t == ticket
      Plain(_) -> False
    }
  }
  let not_sent = fn(queued: List(Queued)) {
    list.each(queued, fn(request) {
      case request.waiter {
        Tracked(t, _, reply) if t == ticket ->
          process.send(
            reply,
            TrackedReply(0, Error(NotSent("deadline passed before sending"))),
          )
        _ -> Nil
      }
    })
    list.filter(queued, fn(request) { !is_ticket(request) })
  }
  case state.status {
    Connecting(queued) -> State(..state, status: Connecting(not_sent(queued)))
    Initializing(conn, init_id, queued) ->
      State(..state, status: Initializing(conn, init_id, not_sent(queued)))
    _ ->
      case dict.get(state.tickets, ticket) {
        Error(_) -> state
        Ok(id) -> {
          let state =
            State(..state, tickets: dict.delete(state.tickets, ticket))
          case dict.get(state.pending, id) {
            Ok(Pending(method, _, TrackedCaller(_, reply), _, generation, _)) -> {
              diagnostics.record(state.label, oauth.now(), "rpc_expired", [
                #("id", json.int(id)),
                #("method", json.string(method)),
              ])
              process.send(reply, TrackedReply(generation, Error(Expired)))
              State(..state, pending: dict.delete(state.pending, id))
            }
            _ -> state
          }
        }
      }
  }
}

fn emit_lifecycle(state: State, event: Lifecycle) -> Nil {
  list.each(state.lifecycle, fn(s) { process.send(s.1, event) })
}

/// Send one request over the wire and track its pending reply.
fn send_request(
  state: State,
  conn: Conn,
  method: String,
  params: Json,
  reply_to: ReplyTo,
) -> State {
  let params = case method {
    "thread/resume" -> {
      let thread =
        jsonx.field_string(file_access.dynamic(params), ["threadId"])
        |> result.unwrap("")
      file_access.apply(
        params,
        method,
        file_access.load(state.label, thread)
          |> result.unwrap(file_access.read_only),
      )
    }
    _ -> params
  }
  let id = state.next_id
  let at = oauth.now()
  usage.request(state.label, method, params)
  usage.snapshot_request(state.label, id, method, params)
  let state =
    State(
      ..state,
      activity: diagnostics.request(state.activity, method, params, at),
    )
  let turn_id =
    json.parse(json.to_string(params), decode.at(["turnId"], decode.string))
    |> result.unwrap(
      json.parse(
        json.to_string(params),
        decode.at(["expectedTurnId"], decode.string),
      )
      |> result.unwrap(""),
    )
  diagnostics.record(state.label, at, "rpc_sent", [
    #("id", json.int(id)),
    #("method", json.string(method)),
    #("turnId", json.string(turn_id)),
    #("threadId", case request_thread_id(method, params) {
      Some(id) -> json.string(id)
      None -> json.null()
    }),
  ])
  write_request(conn, id, method, params)
  State(
    ..state,
    next_id: id + 1,
    pending: dict.insert(
      state.pending,
      id,
      Pending(
        method,
        request_thread_id(method, params),
        reply_to,
        at,
        state.generation,
        case jsonx.field_string(file_access.dynamic(params), ["sandbox"]) {
          Ok("read-only") -> file_access.read_only
          _ -> file_access.read_write
        },
      ),
    ),
  )
}

/// The threadId a request operates on, captured for the handful of methods
/// whose *response* doesn't echo it (needed to maintain `resumed`).
fn request_thread_id(_method: String, params: Json) -> Option(String) {
  json.parse(json.to_string(params), decode.at(["threadId"], decode.string))
  |> option.from_result
}

// -- Connection establishment -------------------------------------------------

fn begin_connect(state: State, queued: List(Queued)) -> actor.Next(State, Msg) {
  case state.transport {
    Local(command) -> {
      let port = spawn_codex(command, state.label)
      actor.continue(begin_initialize(state, PortConn(port), queued))
    }
    UnixSock(_) | Ssh(_) | LocalDaemon(_, _) -> {
      let connector = spawn_connector(state)
      let state = broadcast_status(state, "connecting", "")
      actor.continue(
        State(..state, status: Connecting(queued), connector: Some(connector)),
      )
    }
  }
}

/// Send the `initialize` handshake on a fresh connection and queue everything
/// else until it completes.
fn begin_initialize(state: State, conn: Conn, queued: List(Queued)) -> State {
  let init_id = state.next_id
  write_request(
    conn,
    init_id,
    "initialize",
    json.object([
      // `clientInfo` is required by the handshake, so we cannot omit it, but we
      // do not want a custom user agent: the app-server derives the string it
      // presents upstream from these fields. Identify as the plain codex CLI
      // instead of inventing a yacwu-specific originator.
      #(
        "clientInfo",
        json.object([
          #("name", json.string("codex_cli_rs")),
          #("version", json.string(codex_version)),
        ]),
      ),
      #("capabilities", json.object([#("experimentalApi", json.bool(True))])),
    ]),
  )
  State(
    ..state,
    status: Initializing(conn, init_id, queued),
    next_id: init_id + 1,
  )
}

fn spawn_codex(command: List(String), label: String) -> Port {
  let capture = diagnostics.rotate_stderr(label)
  let #(_, stderr) = diagnostics.paths(label)
  diagnostics.record(label, oauth.now(), "child_start", [
    #("stderrCapture", json.bool(capture)),
  ])
  let command = case capture {
    True -> [
      "/bin/sh",
      "-c",
      "exec \"$@\" 2>>\"$YACWU_CODEX_STDERR_LOG\"",
      "yacwu-codex",
      ..command
    ]
    False -> command
  }
  erl_open_port(SpawnExecutable("/usr/bin/env"), [
    Binary,
    ExitStatus,
    UseStdio,
    Hide,
    // The AppImage bundles libraries on LD_LIBRARY_PATH for its own Erlang
    // runtime; codex and other backends are system binaries and must not
    // inherit that path.
    Args([
      "-u",
      "LD_LIBRARY_PATH",
      "YACWU_CODEX_STDERR_LOG=" <> stderr,
      "RUST_LOG=" <> { envoy.get("RUST_LOG") |> result.unwrap("info") },
      ..command
    ]),
    Cd(default_cwd()),
  ])
}

/// Establish a remote connection off the actor: bootstrap over ssh, ask the
/// actor to open the socket forward (ports must belong to the long-lived
/// actor), attach, then hand the socket back via `ConnResult`.
fn spawn_connector(state: State) -> Pid {
  let subject = process.named_subject(state.self)
  let owner = process.self()
  let transport = state.transport
  let pid =
    process.spawn_unlinked(fn() {
      let result = case transport {
        UnixSock(path) ->
          remote.attach(path, owner, 10)
          |> result.map(fn(handover) {
            #(handover.socket, handover.leftover, None)
          })
        Ssh(host) -> {
          use boot <- result.try(remote.bootstrap(host))
          let local = remote.local_socket_path(host)
          use _ <- result.try(
            process.call(subject, 15_000, OpenForwarder(local, boot.socket, _)),
          )
          use handover <- result.try(remote.attach(local, owner, 40))
          Ok(#(handover.socket, handover.leftover, Some(boot)))
        }
        LocalDaemon(name, command) -> {
          use boot <- result.try(remote.bootstrap_local(
            name,
            default_cwd(),
            command,
          ))
          use handover <- result.try(remote.attach(boot.socket, owner, 40))
          Ok(#(handover.socket, handover.leftover, Some(boot)))
        }
        Local(_) -> Error("local transport needs no connector")
      }
      process.send(subject, ConnResult(result))
    })
  let _ = process.monitor(pid)
  pid
}

fn on_open_forwarder(
  state: State,
  local: String,
  remote_sock: String,
  reply: Subject(Result(Nil, String)),
) -> actor.Next(State, Msg) {
  case state.forwarder {
    Some(old) -> remote.close_forwarder(old)
    None -> Nil
  }
  case state.transport {
    Ssh(host) ->
      case remote.open_forwarder(host, local, remote_sock) {
        Ok(port) -> {
          process.send(reply, Ok(Nil))
          actor.continue(State(..state, forwarder: Some(port)))
        }
        Error(message) -> {
          process.send(reply, Error(message))
          actor.continue(State(..state, forwarder: None))
        }
      }
    _ -> {
      process.send(reply, Error("not an ssh transport"))
      actor.continue(State(..state, forwarder: None))
    }
  }
}

fn on_conn_result(
  state: State,
  result: Result(#(remote.Socket, BitArray, Option(remote.Bootstrap)), String),
) -> actor.Next(State, Msg) {
  let state = State(..state, connector: None)
  case state.status, result {
    Connecting(queued), Ok(#(socket, leftover, boot)) -> {
      remote.activate(socket)
      let state = case boot {
        Some(boot) ->
          State(
            ..state,
            home: boot.home,
            codex_home: boot.codex_home,
            remote_sock: boot.socket,
            daemon_pid: case state.transport {
              LocalDaemon(_, _) -> int.parse(boot.pid)
              _ -> Error(Nil)
            },
          )
        None -> state
      }
      let state = State(..state, decoder: ws.new_decoder(), last_error: "")
      let state = begin_initialize(state, SockConn(socket), queued)
      // Bytes that arrived while the handshake was read belong to the
      // stream; run them through the normal frame path.
      case leftover {
        <<>> -> actor.continue(state)
        _ -> on_tcp_data(state, leftover)
      }
    }
    Connecting(queued), Error(message) -> {
      io.println_error("[codex " <> state.label <> "] connect: " <> message)
      fail_queued(queued, message)
      let state =
        State(
          ..state,
          status: NotRunning,
          last_error: message,
          backoff: state.backoff + 1,
        )
      let state = broadcast_status(state, "disconnected", message)
      // For socket-based transports with auto-wake enabled, schedule a reconnect on
      // connection failure. This ensures inactive sessions with failed connections
      // will retry when receiving new messages, rather than failing immediately.
      let auto_wake_enabled = is_auto_wake_enabled()
      case state.transport, auto_wake_enabled {
        Local(_), _ -> Nil
        _, False -> Nil
        _, True -> {
          let delay =
            int.min(30_000, 1000 * pow2(int.min(int.max(state.backoff - 1, 0), 5)))
          let _ =
            process.send_after(
              process.named_subject(state.self),
              delay,
              TryReconnect,
            )
          Nil
        }
      }
      actor.continue(state)
    }
    // A stray result after the connection already moved on: close it.
    _, Ok(#(socket, _, _)) -> {
      remote.close(socket)
      actor.continue(state)
    }
    _, Error(_) -> actor.continue(state)
  }
}

pub fn is_auto_wake_enabled() -> Bool {
  envoy.get("YACWU_AUTO_WAKE_SESSIONS")
  |> result.map(string.lowercase)
  |> result.unwrap("false") == "true"
}

fn schedule_reconnect(state: State) -> Nil {
  let auto_wake_enabled = is_auto_wake_enabled()
  let has_queued = case state.status {
    Connecting(queued) | Initializing(_, _, queued) -> !list.is_empty(queued)
    _ -> False
  }
  case state.transport, state.resumed, has_queued, auto_wake_enabled {
    Local(_), _, _, _ | _, [], False, _ -> Nil
    _, _, _, False if !has_queued -> Nil
    _, _, _, _ -> {
      // First retry after 1s, doubling to a 30s ceiling.
      let delay =
        int.min(30_000, 1000 * pow2(int.min(int.max(state.backoff - 1, 0), 5)))
      let _ =
        process.send_after(
          process.named_subject(state.self),
          delay,
          TryReconnect,
        )
      Nil
    }
  }
}

fn pow2(exponent: Int) -> Int {
  case exponent <= 0 {
    True -> 1
    False -> 2 * pow2(exponent - 1)
  }
}

// -- Incoming data ------------------------------------------------------------

fn on_port_data(state: State, data: BitArray) -> actor.Next(State, Msg) {
  let combined = bit_array.concat([state.buffer, data])
  let parts = binary_split(combined, <<"\n">>, [Global])
  // All parts but the last are complete lines; the last is the new buffer.
  let #(lines, buffer) = case list.reverse(parts) {
    [last, ..complete] -> #(list.reverse(complete), last)
    [] -> #([], <<>>)
  }
  let state = State(..state, buffer: buffer)
  let state = list.fold(lines, state, process_line)
  actor.continue(state)
}

fn on_tcp_data(state: State, data: BitArray) -> actor.Next(State, Msg) {
  let #(frames, decoder) = ws.push(state.decoder, data)
  handle_frames(State(..state, decoder: decoder), frames)
}

fn handle_frames(
  state: State,
  frames: List(ws.Frame),
) -> actor.Next(State, Msg) {
  case frames {
    [] -> actor.continue(state)
    [frame, ..rest] ->
      case frame {
        ws.Text(text) ->
          handle_frames(process_line(state, bit_array.from_string(text)), rest)
        ws.Ping(payload) -> {
          case state.status {
            Running(SockConn(socket)) | Initializing(SockConn(socket), _, _) ->
              remote.send_pong(socket, payload)
            _ -> Nil
          }
          handle_frames(state, rest)
        }
        // A close frame ends the connection; drop whatever followed it.
        ws.Close ->
          on_disconnect(state, "codex app-server closed the connection")
        // Protocol violations (oversized/hostile frames) must cost this
        // manager one disconnect+backoff, never unbounded memory: a bad
        // remote is never allowed to take the tree down.
        ws.Invalid(reason) ->
          on_disconnect(state, "dropping connection: " <> reason)
        ws.Pong(_) | ws.Binary(_) -> handle_frames(state, rest)
      }
  }
}

fn process_line(state: State, line: BitArray) -> State {
  case json.parse_bits(line, decode.dynamic) {
    Error(_) -> state
    Ok(msg) -> {
      let state = State(..state, last_received_at: oauth.now())
      let id = decode.run(msg, decode.at(["id"], decode.int))
      let method = decode.run(msg, decode.at(["method"], decode.string))
      let has_result =
        result.is_ok(decode.run(msg, decode.at(["result"], decode.dynamic)))
      let error = decode.run(msg, decode.at(["error"], decode.dynamic))
      let is_response = has_result || result.is_ok(error)
      // Backends may use string ids for their own requests.
      let has_id =
        result.is_ok(decode.run(msg, decode.at(["id"], decode.dynamic)))
      case id, method {
        // Response to one of our requests.
        Ok(id), _ if is_response -> on_response(state, id, msg, error)
        // Server-initiated request (has both id and method) — e.g. approvals.
        _, Ok(request_method) if has_id && !is_response ->
          on_server_request(state, line, msg, request_method)
        // Notification.
        _, Ok(method) -> {
          let at = oauth.now()
          usage.notification(state.label, method, msg)
          case method {
            "item/started" | "item/completed" ->
              file_access.inherit_agents(state.label, msg)
            _ -> Nil
          }
          let state = case method {
            "account/rateLimits/updated" -> {
              case jsonx.field(msg, ["params"]) {
                Ok(data) ->
                  State(
                    ..state,
                    account_cache: dict.insert(
                      state.account_cache,
                      "account/rateLimits/read",
                      #(at, Ok(data)),
                    ),
                  )
                Error(_) -> state
              }
            }
            "turn/started" | "turn/completed" -> sample_usage(state)
            _ -> state
          }
          case
            method,
            jsonx.field_string(msg, ["params", "threadId"]),
            jsonx.field_string(msg, ["params", "turn", "id"])
          {
            "turn/started", Ok(thread), Ok(turn) ->
              emit_lifecycle(
                state,
                TurnStarted(state.label, state.generation, thread, turn),
              )
            "turn/completed", Ok(thread), Ok(turn) ->
              emit_lifecycle(
                state,
                TurnCompleted(state.label, state.generation, thread, turn),
              )
            _, _, _ -> Nil
          }
          let state =
            State(
              ..state,
              activity: diagnostics.observe(state.activity, msg, at),
              silent_alerted: list.filter(state.silent_alerted, fn(thread) {
                thread
                != jsonx.field_string(msg, ["params", "threadId"])
                |> result.unwrap("")
              }),
            )
          let state = case method {
            "turn/started" | "account/rateLimits/updated" ->
              enforce_account_limits(state)
            _ -> state
          }
          case method {
            "turn/started"
            | "turn/completed"
            | "item/started"
            | "item/completed"
            | "error" ->
              diagnostics.record(state.label, at, "notification", [
                #("method", json.string(method)),
                #(
                  "threadId",
                  json.string(
                    jsonx.field_string(msg, ["params", "threadId"])
                    |> result.unwrap(""),
                  ),
                ),
                #(
                  "turnId",
                  json.string(
                    jsonx.field_string(msg, ["params", "turnId"])
                    |> result.unwrap(
                      jsonx.field_string(msg, ["params", "turn", "id"])
                      |> result.unwrap(""),
                    ),
                  ),
                ),
                #(
                  "itemType",
                  json.string(
                    jsonx.field_string(msg, ["params", "item", "type"])
                    |> result.unwrap(""),
                  ),
                ),
                #(
                  "itemId",
                  json.string(
                    jsonx.field_string(msg, ["params", "item", "id"])
                    |> result.unwrap(""),
                  ),
                ),
                #(
                  "turnStatus",
                  json.string(
                    jsonx.field_string(msg, ["params", "turn", "status"])
                    |> result.unwrap(""),
                  ),
                ),
                #(
                  "itemStatus",
                  json.string(
                    jsonx.field_string(msg, ["params", "item", "status"])
                    |> result.unwrap(""),
                  ),
                ),
              ])
            _ -> Nil
          }
          broadcast(state, line)
        }
        _, _ -> state
      }
    }
  }
}

fn on_response(
  state: State,
  id: Int,
  msg: Dynamic,
  error: Result(Dynamic, a),
) -> State {
  let reply = case error {
    Ok(err) ->
      Error(
        decode.run(err, decode.at(["message"], decode.string))
        |> result.unwrap("codex error"),
      )
    Error(_) ->
      Ok(
        decode.run(msg, decode.at(["result"], decode.dynamic))
        |> result.unwrap(dynamic.nil()),
      )
  }
  case state.status {
    Initializing(conn, init_id, queued) if id == init_id ->
      case reply {
        Ok(initialized) -> {
          write_notification(conn, "initialized", json.object([]))
          let state =
            State(
              ..state,
              status: Running(conn),
              claude_read_only_support: jsonx.field_string(initialized, [
                  "yacwuCapabilities",
                  "readOnlyFileAccess",
                ])
                == Ok("read-tools-v1"),
              backoff: 0,
              last_error: "",
              generation: unique_integer([Monotonic, Positive]),
            )
          let state = broadcast_status(state, "connected", "")
          // Lifecycle subscribers hear about the new connection before any
          // reply written on it can reach them through a caller.
          emit_lifecycle(state, Connected(state.label, state.generation))
          // Flush requests queued while the handshake was in flight.
          let state =
            list.fold(list.reverse(queued), state, fn(state, queued_request) {
              dispatch_queued(state, conn, queued_request)
            })
          // Re-open the threads this manager had loaded before the
          // disconnect, so their notifications flow on this connection too.
          let state =
            list.fold(state.resumed, state, fn(state, thread_id) {
              send_request(
                state,
                conn,
                "thread/resume",
                json.object([#("threadId", json.string(thread_id))]),
                Discard,
              )
            })
          case state.adopted, state.transport {
            False, Local(_) -> state
            False, _ -> {
              let codex = state.self
              process.spawn_unlinked(fn() { adopt_running_threads(codex) })
              State(..state, adopted: True)
            }
            True, _ -> state
          }
        }
        Error(message) -> {
          io.println_error(
            "[codex " <> state.label <> "] initialize failed: " <> message,
          )
          fail_queued(queued, message)
          close_conn(conn)
          let state =
            State(
              ..state,
              status: NotRunning,
              buffer: <<>>,
              decoder: ws.new_decoder(),
              last_error: message,
              backoff: state.backoff + 1,
            )
          let state = broadcast_status(state, "disconnected", message)
          schedule_reconnect(state)
          state
        }
      }
    _ ->
      case dict.get(state.pending, id) {
        Ok(Pending(method, thread, reply_to, started_at, generation, access)) -> {
          // Save before answering: follow-up requests must see the restriction.
          let reply = case method, reply {
            "thread/start", Ok(value) | "thread/fork", Ok(value) -> {
              case jsonx.field_string(value, ["thread", "id"]) {
                Ok(thread) ->
                  file_access.save(state.label, thread, access)
                  |> result.map(fn(_) { value })
                Error(_) -> Error("Backend did not return a session id")
              }
            }
            _, _ -> reply
          }
          let at = oauth.now()
          let state = case method {
            "account/read" | "account/rateLimits/read" -> {
              let waiters =
                dict.get(state.account_waiters, method) |> result.unwrap([])
              list.each(waiters, fn(subject) { process.send(subject, reply) })
              State(
                ..state,
                account_cache: case reply {
                  Ok(_) ->
                    dict.insert(state.account_cache, method, #(at, reply))
                  Error(_) ->
                    case method {
                      // A refresh failure is not a new usage reading. Keep the
                      // verified sample and its original timestamp; account
                      // limits still reject it after their freshness deadline.
                      "account/rateLimits/read" -> state.account_cache
                      _ -> dict.delete(state.account_cache, method)
                    }
                },
                account_waiters: dict.delete(state.account_waiters, method),
              )
            }
            _ -> state
          }
          diagnostics.record(state.label, at, "rpc_result", [
            #("id", json.int(id)),
            #("method", json.string(method)),
            #("elapsedSeconds", json.int(at - started_at)),
            #("ok", json.bool(result.is_ok(reply))),
            #(
              "errorCode",
              json.int(
                jsonx.field_int(msg, ["error", "code"]) |> result.unwrap(0),
              ),
            ),
          ])
          let state = case reply {
            Ok(value) -> {
              usage.response(state.label, method, value)
              usage.snapshot_response(state.label, id, method, value)
              State(
                ..state,
                activity: diagnostics.restore(state.activity, value, at),
              )
            }
            Error(_) -> {
              usage.snapshot_response(state.label, id, method, dynamic.nil())
              state
            }
          }
          let state = case reply_to {
            Caller(subject) -> {
              process.send(subject, reply)
              state
            }
            TrackedCaller(ticket, subject) -> {
              let result = case error {
                Ok(err) ->
                  Error(Rejected(
                    jsonx.field_int(err, ["code"]) |> result.unwrap(0),
                    jsonx.field_string(err, ["message"])
                      |> result.unwrap("codex error"),
                  ))
                Error(_) ->
                  Ok(
                    decode.run(msg, decode.at(["result"], decode.dynamic))
                    |> result.unwrap(dynamic.nil()),
                  )
              }
              process.send(subject, TrackedReply(generation, result))
              State(..state, tickets: dict.delete(state.tickets, ticket))
            }
            Discard -> state
          }
          let state = State(..state, pending: dict.delete(state.pending, id))
          track_resumed(state, method, thread, reply_to, reply)
          |> enforce_account_limits
        }
        // Most often the answer to a tracked request that already expired.
        Error(_) -> {
          diagnostics.record(state.label, oauth.now(), "late_response", [
            #("id", json.int(id)),
          ])
          state
        }
      }
  }
}

/// A persistent backend outlives yacwu, but a backend sends a thread's events
/// only to connections that started or resumed it, and a freshly started
/// manager has resumed nothing. Resume the threads still running there, so
/// their events flow again right after a yacwu restart, also for sessions no
/// page has open. Runs once per manager, outside the actor: it waits on
/// replies. The resumes go through `request`, so `track_resumed` keeps them
/// for later reconnects.
fn adopt_running_threads(codex: Codex) -> Nil {
  // Bounded: a backend that never answers must not keep these pending.
  let ask = fn(method, params) {
    request_tracked(codex, method, params, adopt_timeout_ms).result
  }
  let loaded =
    ask("thread/loaded/list", json.object([]))
    |> result.map(fn(reply) {
      decode.run(reply, decode.at(["data"], decode.list(decode.string)))
      |> result.unwrap([])
    })
    |> result.unwrap([])
  list.each(loaded, fn(thread_id) {
    let status =
      ask(
        "thread/read",
        json.object([
          #("threadId", json.string(thread_id)),
          #("includeTurns", json.bool(False)),
        ]),
      )
      |> result.map(jsonx.field_string(_, ["thread", "status", "type"]))
    case status {
      Ok(Ok("active")) -> {
        let _ =
          ask(
            "thread/resume",
            json.object([#("threadId", json.string(thread_id))]),
          )
        Nil
      }
      _ -> Nil
    }
  })
}

const adopt_timeout_ms = 30_000

/// Maintain the set of threads to re-resume after a reconnect.
fn track_resumed(
  state: State,
  method: String,
  thread: Option(String),
  reply_to: ReplyTo,
  reply: Reply,
) -> State {
  case reply {
    Ok(result) ->
      case method {
        "thread/start" | "thread/resume" | "thread/fork" ->
          case jsonx.field_string(result, ["thread", "id"]) {
            Ok(id) if id != "" ->
              case list.contains(state.resumed, id) {
                True -> state
                False -> State(..state, resumed: [id, ..state.resumed])
              }
            _ -> state
          }
        "thread/unsubscribe" | "thread/archive" ->
          case thread {
            Some(id) ->
              State(
                ..state,
                resumed: list.filter(state.resumed, fn(t) { t != id }),
              )
            None -> state
          }
        _ -> state
      }
    Error(_) ->
      // An automatic re-resume that fails (thread deleted, archived
      // elsewhere) must not retry forever.
      case method, reply_to, thread {
        "thread/resume", Discard, Some(id) ->
          State(..state, resumed: list.filter(state.resumed, fn(t) { t != id }))
        _, _, _ -> state
      }
  }
}

/// We run codex with approvalPolicy "never", so approvals shouldn't normally
/// be requested. If anything does come through, auto-accept so turns never
/// hang. Read-only sessions deny escalation. The request is also broadcast so
/// the UI can show what happened.
fn on_server_request(
  state: State,
  line: BitArray,
  msg: Dynamic,
  method: String,
) -> State {
  let id =
    decode.run(msg, decode.at(["id"], decode.dynamic))
    |> result.unwrap(dynamic.nil())
  case method {
    // A question for the user: it waits for their answer (answer_user_input).
    "item/tool/requestUserInput" ->
      case decode.run(msg, decode.at(["params", "itemId"], decode.string)) {
        Ok(item_id) ->
          broadcast(
            State(
              ..state,
              user_input: dict.insert(state.user_input, item_id, id),
            ),
            line,
          )
        Error(_) -> reply_server_request(state, line, id, json.object([]))
      }
    _ ->
      reply_server_request(
        state,
        line,
        id,
        file_access.approval(state.label, method, msg),
      )
  }
}

fn reply_server_request(
  state: State,
  line: BitArray,
  id: Dynamic,
  result: Json,
) -> State {
  case state.status {
    Running(conn) | Initializing(conn, _, _) ->
      write_line(
        conn,
        json.object([#("id", jsonx.to_json(id)), #("result", result)]),
      )
    _ -> Nil
  }
  broadcast(state, line)
}

fn broadcast(state: State, line: BitArray) -> State {
  case bit_array.to_string(line) {
    Ok(text) -> {
      list.each(state.subscribers, fn(s) { process.send(s.1, text) })
      state
    }
    Error(_) -> state
  }
}

fn stalled_notification(details: Json) -> String {
  json.to_string(
    json.object([
      #("method", json.string("yacwu/diagnostic/stalled")),
      #("params", details),
    ]),
  )
}

fn broadcast_stalled(state: State, details: Json) -> State {
  broadcast(state, bit_array.from_string(stalled_notification(details)))
}

fn replay_silent_alerts(
  state: State,
  subject: Subject(String),
  at: Int,
) -> State {
  diagnostics.silent_entries(state.activity, at)
  |> list.each(fn(entry) {
    process.send(subject, stalled_notification(entry.1))
  })
  state
}

/// Tell subscribers (the SSE stream) about remote connection transitions as a
/// synthetic notification. Local child restarts stay silent, as before.
fn broadcast_status(state: State, connection: String, error: String) -> State {
  diagnostics.record(state.label, oauth.now(), "connection", [
    #("state", json.string(connection)),
    #("hasError", json.bool(error != "")),
  ])
  case state.transport {
    Local(_) -> state
    _ ->
      broadcast(
        state,
        bit_array.from_string(
          json.to_string(
            json.object([
              #("method", json.string("yacwu/host/status")),
              #(
                "params",
                json.object([
                  #("host", json.string(state.label)),
                  #("state", json.string(connection)),
                  #("error", case error {
                    "" -> json.null()
                    _ -> json.string(error)
                  }),
                ]),
              ),
            ]),
          ),
        ),
      )
  }
}

// -- Disconnection ------------------------------------------------------------

/// The local child process exited.
fn on_child_exit(state: State, code: Int) -> actor.Next(State, Msg) {
  diagnostics.record(state.label, oauth.now(), "child_exit", [
    #("code", json.int(code)),
  ])
  io.println_error(
    "[codex "
    <> state.label
    <> "] app-server exited with code "
    <> int.to_string(code),
  )
  actor.continue(fail_all(state, "codex app-server exited"))
}

/// A trapped exit signal from something linked to this manager.
///
/// The child's port dying abnormally (`epipe` after the app-server exited
/// under a write) is a recoverable disconnect: fail in-flight work and let
/// the next request respawn. Other ports' exits are lifecycle noise handled
/// through their own messages. A linked *process* exiting abnormally — the
/// registry going down — keeps its pre-trapping meaning: this manager dies
/// with it, and the link tears the child port down too.
fn on_linked_exit(
  state: State,
  exit: process.ExitMessage,
) -> actor.Next(State, Msg) {
  let current_conn_port = case state.status {
    Running(PortConn(port)) | Initializing(PortConn(port), _, _) ->
      erl_same_term(exit.pid, port)
    _ -> False
  }
  case current_conn_port, exit.reason {
    True, _ -> {
      io.println_error(
        "[codex "
        <> state.label
        <> "] app-server connection failed: "
        <> exit_reason_text(exit.reason),
      )
      actor.continue(fail_all(state, "codex app-server exited"))
    }
    False, process.Normal -> actor.continue(state)
    False, _ ->
      case erl_is_port(exit.pid) {
        True -> actor.continue(state)
        False -> actor.stop_abnormal(exit_reason_text(exit.reason))
      }
  }
}

fn exit_reason_text(reason: process.ExitReason) -> String {
  case reason {
    process.Normal -> "normal"
    process.Killed -> "killed"
    process.Abnormal(reason) -> string.inspect(reason)
  }
}

/// What this manager talks to, for messages: alternative backends (such as
/// Claude) speak the same protocol but are not codex.
fn backend_name(state: State) -> String {
  case state.transport {
    LocalDaemon(_, [_, ..]) | Local([_, ..]) if state.label != "local" ->
      "the " <> state.label <> " backend"
    Ssh(host) -> "the codex app-server on " <> host
    _ -> "the codex app-server"
  }
}

/// The remote connection dropped: fail in-flight work, then reconnect with
/// backoff. The remote server keeps running — and keeps executing any
/// in-flight turns — so reconnecting re-attaches to live state.
fn on_disconnect(state: State, message: String) -> actor.Next(State, Msg) {
  io.println_error("[codex " <> state.label <> "] " <> message)
  case state.status {
    Running(SockConn(socket)) | Initializing(SockConn(socket), _, _) ->
      remote.close(socket)
    _ -> Nil
  }
  let state = fail_all(state, message)
  let state = State(..state, last_error: message, backoff: state.backoff + 1)
  let state = broadcast_status(state, "disconnected", message)
  schedule_reconnect(state)
  actor.continue(state)
}

fn fail_all(state: State, message: String) -> State {
  usage.record(state.label, "connectionLost", [])
  let at = oauth.now()
  diagnostics.record(state.label, at, "connection_lost", [
    #("snapshot", state_diagnostics(state, at)),
  ])
  let failure = Error(message)
  dict.each(state.account_waiters, fn(_, waiters) {
    list.each(waiters, fn(subject) { process.send(subject, failure) })
  })
  let state =
    State(
      ..state,
      account_waiters: dict.new(),
      account_cache: dict.new(),
      next_usage_at: 0,
    )
  dict.each(state.pending, fn(_, pending) {
    case pending.reply_to {
      Caller(subject) -> process.send(subject, failure)
      TrackedCaller(_, subject) ->
        process.send(
          subject,
          TrackedReply(pending.generation, Error(Lost(message))),
        )
      Discard -> Nil
    }
  })
  case state.status {
    Initializing(_, _, queued) | Connecting(queued) ->
      fail_queued(queued, message)
    _ -> Nil
  }
  case state.generation {
    0 -> Nil
    generation -> emit_lifecycle(state, Disconnected(state.label, generation))
  }
  State(
    ..state,
    status: NotRunning,
    pending: dict.new(),
    tickets: dict.new(),
    user_input: dict.new(),
    generation: 0,
    buffer: <<>>,
    decoder: ws.new_decoder(),
  )
}

/// Requests still waiting for a connection were never written.
fn fail_queued(queued: List(Queued), message: String) -> Nil {
  list.each(queued, fn(request) {
    case request.waiter {
      Plain(reply) -> process.send(reply, Error(message))
      Tracked(_, _, reply) ->
        process.send(reply, TrackedReply(0, Error(NotSent(message))))
    }
  })
}

fn close_conn(conn: Conn) -> Nil {
  case conn {
    PortConn(port) -> {
      // The port may already be gone (`port_close` on a closed port raises
      // `badarg`); closing a dead connection is a no-op, not a crash.
      let _ = exception.rescue(fn() { erl_port_close(port) })
      Nil
    }
    SockConn(socket) -> remote.close(socket)
  }
}

// -- Wire writing -------------------------------------------------------------

fn write_request(conn: Conn, id: Int, method: String, params: Json) -> Nil {
  write_line(
    conn,
    json.object([
      #("method", json.string(method)),
      #("id", json.int(id)),
      #("params", params),
    ]),
  )
}

fn write_notification(conn: Conn, method: String, params: Json) -> Nil {
  write_line(
    conn,
    json.object([#("method", json.string(method)), #("params", params)]),
  )
}

fn write_line(conn: Conn, message: Json) -> Nil {
  let text = json.to_string(message)
  case conn {
    PortConn(port) -> {
      // The child can exit at any moment, and `port_command` on a closed
      // port raises `badarg`. When that happens the port's exit is already
      // in our mailbox, so the write is safely dropped here and the pending
      // request fails cleanly when that message is processed.
      let _ =
        exception.rescue(fn() {
          erl_port_command(port, bit_array.from_string(text <> "\n"))
        })
      Nil
    }
    SockConn(socket) -> remote.send_text(socket, text)
  }
}
