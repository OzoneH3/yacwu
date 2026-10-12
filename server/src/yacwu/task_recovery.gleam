//// Restarting tasks a crashed backend cut off. Turns that were running when a
//// host's connection was lost are checked once it is back: a turn the
//// backend no longer runs, or ended as interrupted or failed, is continued
//// with the same prompt as Yacwu's "Continue interrupted task". Turns that
//// survived (persistent backends keep running) are left alone.
////
//// Running turns are saved to disk, so a crash of Yacwu itself is covered:
//// they are checked when each host first connects after a restart.

import envoy
import filepath
import gleam/dict.{type Dict}
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/result
import simplifile

pub const continuation_prompt = "The previous task was interrupted by an app restart. Continue from the current state: first inspect what is already complete, then finish only the remaining work."

/// At most this many automatic continues per thread within
/// `attempt_window_seconds`,
/// so a task that crashes its backend every time cannot loop.
pub const max_attempts = 2

pub const attempt_window_seconds = 1800

pub type Tracker {
  Tracker(
    /// host -> thread -> turn running there now.
    running: Dict(String, Dict(String, String)),
    /// host -> thread -> turn that was running when the host disconnected
    /// (or when Yacwu last stopped), to check once it is connected again.
    orphans: Dict(String, Dict(String, String)),
    /// thread -> times of automatic continues.
    attempts: Dict(String, List(Int)),
  )
}

pub fn new() -> Tracker {
  Tracker(dict.new(), dict.new(), dict.new())
}

fn threads_of(
  hosts: Dict(String, Dict(String, String)),
  host: String,
) -> Dict(String, String) {
  dict.get(hosts, host) |> result.unwrap(dict.new())
}

pub fn turn_started(
  tracker: Tracker,
  host: String,
  thread: String,
  turn: String,
) -> Tracker {
  let running = dict.insert(threads_of(tracker.running, host), thread, turn)
  let orphans = dict.delete(threads_of(tracker.orphans, host), thread)
  Tracker(
    ..tracker,
    running: dict.insert(tracker.running, host, running),
    orphans: dict.insert(tracker.orphans, host, orphans),
  )
}

pub fn turn_completed(
  tracker: Tracker,
  host: String,
  thread: String,
) -> Tracker {
  Tracker(
    ..tracker,
    running: dict.insert(
      tracker.running,
      host,
      dict.delete(threads_of(tracker.running, host), thread),
    ),
  )
}

/// The host's connection is gone: its running turns are now in question.
pub fn disconnected(tracker: Tracker, host: String) -> Tracker {
  let orphans =
    dict.merge(
      threads_of(tracker.orphans, host),
      threads_of(tracker.running, host),
    )
  Tracker(
    ..tracker,
    running: dict.delete(tracker.running, host),
    orphans: dict.insert(tracker.orphans, host, orphans),
  )
}

/// The host is connected again: hand out its turns to check.
pub fn take_orphans(
  tracker: Tracker,
  host: String,
) -> #(Tracker, List(#(String, String))) {
  let orphans = threads_of(tracker.orphans, host) |> dict.to_list
  #(Tracker(..tracker, orphans: dict.delete(tracker.orphans, host)), orphans)
}

/// Whether another automatic continue of `thread` is allowed now; if so, it
/// is counted.
pub fn allow_attempt(
  tracker: Tracker,
  thread: String,
  now: Int,
) -> #(Tracker, Bool) {
  let recent =
    dict.get(tracker.attempts, thread)
    |> result.unwrap([])
    |> list.filter(fn(at) { now - at < attempt_window_seconds })
  case list.length(recent) < max_attempts {
    True -> #(
      Tracker(
        ..tracker,
        attempts: dict.insert(tracker.attempts, thread, [now, ..recent]),
      ),
      True,
    )
    False -> #(
      Tracker(
        ..tracker,
        attempts: dict.insert(tracker.attempts, thread, recent),
      ),
      False,
    )
  }
}

/// Whether `turn` of a thread (a thread/read result with turns) was cut off:
/// still in progress on a backend that no longer runs the thread, or ended as
/// interrupted or failed. Only the thread's latest turn counts, and agent
/// threads are left to the session that spawned them.
pub fn cut_off(read: Dynamic, turn: String) -> Bool {
  let present = fn(path) {
    case decode.run(read, decode.at(path, decode.string)) {
      Ok(value) -> value != ""
      Error(_) -> False
    }
  }
  let is_agent =
    present(["thread", "agentRole"])
    || present(["thread", "agentNickname"])
    || decode.run(read, decode.at(["thread", "ephemeral"], decode.bool))
    == Ok(True)
  let status =
    decode.run(read, decode.at(["thread", "status", "type"], decode.string))
    |> result.unwrap("")
  let latest =
    decode.run(
      read,
      decode.at(
        ["thread", "turns"],
        decode.list({
          use id <- decode.field("id", decode.string)
          use turn_status <- decode.field("status", decode.string)
          decode.success(#(id, turn_status))
        }),
      ),
    )
    |> result.unwrap([])
    |> list.last
  case is_agent, latest {
    False, Ok(#(id, turn_status)) if id == turn ->
      case status, turn_status {
        "notLoaded", "inProgress" -> True
        "idle", "interrupted"
        | "idle", "failed"
        | "notLoaded", "interrupted"
        | "notLoaded", "failed"
        -> True
        _, _ -> False
      }
    _, _ -> False
  }
}

// -- Persistence ----------------------------------------------------------------

pub fn path() -> String {
  let state = case envoy.get("XDG_STATE_HOME") {
    Ok(dir) if dir != "" -> dir
    _ ->
      filepath.join(envoy.get("HOME") |> result.unwrap("/tmp"), ".local/state")
  }
  filepath.join(state, "yacwu/running-turns.json")
}

pub fn encode(tracker: Tracker) -> String {
  let hosts = fn(hosts: Dict(String, Dict(String, String))) {
    json.dict(hosts, fn(host) { host }, fn(threads) {
      json.dict(threads, fn(thread) { thread }, json.string)
    })
  }
  // Both running and orphaned turns still need a check after a restart.
  json.to_string(
    json.object([
      #("running", hosts(tracker.running)),
      #("orphans", hosts(tracker.orphans)),
    ]),
  )
}

/// After a restart every saved turn is in question.
pub fn decode_saved(text: String) -> Tracker {
  let hosts =
    decode.dict(decode.string, decode.dict(decode.string, decode.string))
  let saved =
    json.parse(text, {
      use running <- decode.optional_field("running", dict.new(), hosts)
      use orphans <- decode.optional_field("orphans", dict.new(), hosts)
      decode.success(#(running, orphans))
    })
  case saved {
    Ok(#(running, orphans)) -> {
      let merged = dict.combine(orphans, running, fn(a, b) { dict.merge(a, b) })
      Tracker(dict.new(), merged, dict.new())
    }
    Error(_) -> new()
  }
}

pub fn load(path: String) -> Tracker {
  simplifile.read(path) |> result.map(decode_saved) |> result.unwrap(new())
}

pub fn save(path: String, tracker: Tracker) -> Nil {
  let _ = simplifile.create_directory_all(filepath.directory_name(path))
  let temp = path <> ".tmp"
  let _ =
    simplifile.write(temp, encode(tracker))
    |> result.try(fn(_) { simplifile.rename(temp, path) })
  Nil
}
