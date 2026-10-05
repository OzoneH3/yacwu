//// Bounded metadata diagnostics; never records JSON-RPC bodies or deltas.

import gleam/dict.{type Dict}
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/result
import yacwu/jsonx

pub type Activity {
  Activity(turn: String, last_at: Int, method: String, item_type: String)
}

pub type Tracker =
  Dict(String, Activity)

@external(erlang, "yacwu_diagnostics", "write")
fn write(label: String, line: String) -> Bool

@external(erlang, "yacwu_diagnostics", "paths")
pub fn paths(label: String) -> #(String, String)

@external(erlang, "yacwu_diagnostics", "rotate_stderr")
pub fn rotate_stderr(label: String) -> Bool

@external(erlang, "yacwu_diagnostics", "process_stats")
pub fn process_stats(pid: Int) -> Dynamic

pub fn record(
  label: String,
  at: Int,
  event: String,
  fields: List(#(String, Json)),
) -> Nil {
  let _ =
    write(
      label,
      json.to_string(
        json.object([
          #("at", json.int(at)),
          #("host", json.string(label)),
          #("event", json.string(event)),
          ..fields
        ]),
      ),
    )
  Nil
}

pub fn observe(tracker: Tracker, msg: Dynamic, at: Int) -> Tracker {
  let method = jsonx.field_string(msg, ["method"]) |> result.unwrap("")
  let thread =
    jsonx.field_string(msg, ["params", "threadId"]) |> result.unwrap("")
  let turn =
    jsonx.field_string(msg, ["params", "turn", "id"])
    |> result.unwrap(
      jsonx.field_string(msg, ["params", "turnId"]) |> result.unwrap(""),
    )
  let item =
    jsonx.field_string(msg, ["params", "item", "type"]) |> result.unwrap("")
  case method, thread {
    _, "" -> tracker
    "turn/completed", _ -> dict.delete(tracker, thread)
    "turn/started", _ ->
      dict.insert(tracker, thread, Activity(turn, at, method, item))
    _, _ ->
      case dict.get(tracker, thread) {
        Ok(previous) ->
          dict.insert(
            tracker,
            thread,
            Activity(previous.turn, at, method, case item {
              "" -> previous.item_type
              _ -> item
            }),
          )
        Error(_) -> tracker
      }
  }
}

/// A read/resume after reload may be our first sight of an already active turn.
pub fn restore(tracker: Tracker, reply: Dynamic, at: Int) -> Tracker {
  let thread = jsonx.field_string(reply, ["thread", "id"]) |> result.unwrap("")
  let status =
    jsonx.field_string(reply, ["thread", "status", "type"]) |> result.unwrap("")
  case thread, status {
    "", _ -> tracker
    _, "idle" | _, "notLoaded" -> dict.delete(tracker, thread)
    _, "active" -> {
      let turns =
        decode.run(
          reply,
          decode.at(["thread", "turns"], decode.list(decode.dynamic)),
        )
        |> result.unwrap([])
      let turn =
        turns
        |> list.filter(fn(t) {
          jsonx.field_string(t, ["status"]) == Ok("inProgress")
        })
        |> list.last
        |> result.map(fn(t) {
          jsonx.field_string(t, ["id"]) |> result.unwrap("")
        })
        |> result.unwrap("")
      case dict.get(tracker, thread) {
        Ok(_) -> tracker
        Error(_) ->
          dict.insert(
            tracker,
            thread,
            Activity(turn, at, "thread/restored", ""),
          )
      }
    }
    _, _ -> tracker
  }
}

pub fn snapshot(tracker: Tracker, at: Int) -> Json {
  json.preprocessed_array(
    dict.to_list(tracker)
    |> list.map(fn(entry) {
      let #(thread, activity) = entry
      json.object([
        #("threadId", json.string(thread)),
        #("turnId", json.string(activity.turn)),
        #("lastEventAt", json.int(activity.last_at)),
        #("silentSeconds", json.int(at - activity.last_at)),
        #("lastMethod", json.string(activity.method)),
        #("lastItemType", json.string(activity.item_type)),
      ])
    }),
  )
}

pub fn is_silent(tracker: Tracker, at: Int) -> Bool {
  dict.values(tracker)
  |> list.any(fn(activity) { at - activity.last_at >= 120 })
}
