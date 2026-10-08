//// Bounded metadata diagnostics; never records JSON-RPC bodies or deltas.

import gleam/dict.{type Dict}
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/result
import yacwu/jsonx

pub type Activity {
  Activity(
    turn: String,
    last_at: Int,
    method: String,
    item_type: String,
    effort: String,
    tools: List(String),
  )
}

pub fn quiet_threshold(effort: String, running_tool: Bool) -> Int {
  let seconds = case effort {
    "none" | "minimal" | "low" -> 120
    "medium" -> 240
    "high" -> 360
    "xhigh" -> 600
    "max" -> 900
    "ultra" -> 1200
    _ -> 240
  }
  case running_tool && seconds < 600 {
    True -> 600
    False -> seconds
  }
}

/// Capture requested effort once, before turn/started; steering/settings are ignored.
pub fn request(
  tracker: Tracker,
  method: String,
  params: Json,
  at: Int,
) -> Tracker {
  case method, json.parse(json.to_string(params), decode.dynamic) {
    "turn/start", Ok(data) -> {
      let thread = jsonx.field_string(data, ["threadId"]) |> result.unwrap("")
      let effort = jsonx.field_string(data, ["effort"]) |> result.unwrap("")
      case thread, dict.get(tracker, thread) {
        "", _ -> tracker
        _, Ok(activity) if activity.turn != "" -> tracker
        _, _ ->
          dict.insert(
            tracker,
            thread,
            Activity("", at, "turn/requested", "", effort, []),
          )
      }
    }
    _, _ -> tracker
  }
}

fn confirmed_tool(item: Dynamic) -> Bool {
  let kind = jsonx.field_string(item, ["type"]) |> result.unwrap("")
  jsonx.field_string(item, ["status"]) == Ok("inProgress")
  && {
    kind == "commandExecution"
    || kind == "mcpToolCall"
    || {
      kind == "collabAgentToolCall"
      && jsonx.field_string(item, ["tool"]) == Ok("wait")
    }
  }
}

fn spawned_efforts(tracker: Tracker, msg: Dynamic, at: Int) -> Tracker {
  let effort =
    jsonx.field_string(msg, ["params", "item", "reasoningEffort"])
    |> result.unwrap("")
  case jsonx.field_string(msg, ["params", "item", "tool"]), effort {
    Ok("spawnAgent"), effort if effort != "" -> {
      let receivers =
        decode.run(
          msg,
          decode.at(
            ["params", "item", "receiverThreadIds"],
            decode.list(decode.string),
          ),
        )
        |> result.unwrap([])
      list.fold(receivers, tracker, fn(tracker, thread) {
        case dict.get(tracker, thread) {
          Ok(previous) if previous.effort != "" -> tracker
          Ok(previous) ->
            dict.insert(tracker, thread, Activity(..previous, effort: effort))
          Error(_) ->
            dict.insert(
              tracker,
              thread,
              Activity("", at, "agent/spawn", "", effort, []),
            )
        }
      })
    }
    _, _ -> tracker
  }
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
  let tracker = case method {
    "item/started" | "item/completed" -> spawned_efforts(tracker, msg, at)
    _ -> tracker
  }
  case method, thread {
    _, "" -> tracker
    "turn/completed", _ -> dict.delete(tracker, thread)
    "turn/started", _ -> {
      let cached_effort = case dict.get(tracker, thread) {
        Ok(previous) -> previous.effort
        Error(_) -> ""
      }
      let effort =
        jsonx.field_string(msg, ["params", "turn", "reasoningEffort"])
        |> result.unwrap(cached_effort)
      dict.insert(tracker, thread, Activity(turn, at, method, item, effort, []))
    }
    _, _ ->
      case dict.get(tracker, thread) {
        Ok(previous) -> {
          let id =
            jsonx.field_string(msg, ["params", "item", "id"])
            |> result.unwrap("")
          let tools = case method, id, jsonx.field(msg, ["params", "item"]) {
            "item/started", id, Ok(data) if id != "" ->
              case confirmed_tool(data) {
                True -> [
                  id,
                  ..list.filter(previous.tools, fn(tool) { tool != id })
                ]
                False -> previous.tools
              }
            "item/completed", id, _ if id != "" ->
              list.filter(previous.tools, fn(tool) { tool != id })
            _, _, _ -> previous.tools
          }
          dict.insert(
            tracker,
            thread,
            Activity(
              ..previous,
              last_at: at,
              method: method,
              item_type: case item {
                "" -> previous.item_type
                _ -> item
              },
              tools: tools,
            ),
          )
        }
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
      let active_turn =
        turns
        |> list.filter(fn(t) {
          jsonx.field_string(t, ["status"]) == Ok("inProgress")
        })
        |> list.last
        |> result.unwrap(dynamic.nil())
      let turn = jsonx.field_string(active_turn, ["id"]) |> result.unwrap("")
      let tools =
        decode.run(
          active_turn,
          decode.at(["items"], decode.list(decode.dynamic)),
        )
        |> result.unwrap([])
        |> list.filter(confirmed_tool)
        |> list.filter_map(fn(item) { jsonx.field_string(item, ["id"]) })
      let previous = dict.get(tracker, thread)
      let cached_effort = case previous {
        Ok(activity) -> activity.effort
        Error(_) -> ""
      }
      case previous {
        Ok(activity) if activity.turn != "" -> tracker
        _ ->
          dict.insert(
            tracker,
            thread,
            Activity(
              turn,
              at,
              "thread/restored",
              "",
              jsonx.field_string(reply, ["reasoningEffort"])
                |> result.unwrap(
                  jsonx.field_string(active_turn, ["reasoningEffort"])
                  |> result.unwrap(
                    jsonx.field_string(active_turn, ["effort"])
                    |> result.unwrap(
                      jsonx.field_string(reply, ["thread", "reasoningEffort"])
                      |> result.unwrap(cached_effort),
                    ),
                  ),
                ),
              tools,
            ),
          )
      }
    }
    _, _ -> tracker
  }
}

pub fn snapshot(tracker: Tracker, at: Int) -> Json {
  json.preprocessed_array(
    dict.to_list(tracker)
    |> list.filter(fn(entry) { entry.1.turn != "" })
    |> list.map(fn(entry) {
      let #(thread, activity) = entry
      json.object([
        #("threadId", json.string(thread)),
        #("turnId", json.string(activity.turn)),
        #("lastEventAt", json.int(activity.last_at)),
        #("silentSeconds", json.int(at - activity.last_at)),
        #("lastMethod", json.string(activity.method)),
        #("lastItemType", json.string(activity.item_type)),
        #("thinkingLevel", json.string(activity.effort)),
        #(
          "quietThresholdSeconds",
          json.int(quiet_threshold(activity.effort, activity.tools != [])),
        ),
      ])
    }),
  )
}

pub fn is_silent(tracker: Tracker, at: Int) -> Bool {
  silent_entries(tracker, at) != []
}

/// Active per-thread alerts, including only bounded metadata safe for the UI.
pub fn silent_entries(tracker: Tracker, at: Int) -> List(#(String, Json)) {
  dict.to_list(tracker)
  |> list.filter_map(fn(entry) {
    let #(thread, activity) = entry
    let silent_seconds = at - activity.last_at
    let threshold = quiet_threshold(activity.effort, activity.tools != [])
    case activity.turn != "" && silent_seconds >= threshold {
      True ->
        Ok(#(
          thread,
          json.object([
            #("threadId", json.string(thread)),
            #("turnId", json.string(activity.turn)),
            #("silentSeconds", json.int(silent_seconds)),
            #("lastMethod", json.string(activity.method)),
            #("lastItemType", json.string(activity.item_type)),
            #("thinkingLevel", json.string(activity.effort)),
            #("quietThresholdSeconds", json.int(threshold)),
          ]),
        ))
      False -> Error(Nil)
    }
  })
}
