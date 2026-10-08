//// Persistent usage metadata, independent of browser connections.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/result
import gleam/string
import yacwu/jsonx

@external(erlang, "yacwu_usage", "now")
fn now() -> Int

@external(erlang, "yacwu_usage", "append")
fn append(label: String, line: String) -> Bool

@external(erlang, "yacwu_usage", "read")
fn read(label: String) -> String

@external(erlang, "yacwu_usage", "path")
fn path(label: String) -> String

@external(erlang, "yacwu_usage", "read_all")
fn read_all() -> String

@external(erlang, "yacwu_usage", "fingerprint")
fn fingerprint(value: String) -> String

pub fn record(
  label: String,
  event: String,
  fields: List(#(String, Json)),
) -> Nil {
  let _ =
    append(
      label,
      json.to_string(
        json.object([
          #("at", json.int(now())),
          #("host", json.string(label)),
          #("event", json.string(event)),
          ..fields
        ]),
      ),
    )
  Nil
}

fn value(data: Dynamic, keys: List(String)) -> Json {
  jsonx.field(data, keys)
  |> result.map(jsonx.to_json)
  |> result.unwrap(json.null())
}

/// Correlate token notifications emitted while loading stored thread state.
/// A confirmed idle read can establish a baseline without claiming new usage.
pub fn snapshot_request(
  label: String,
  id: Int,
  method: String,
  params: Json,
) -> Nil {
  case method {
    "thread/read" | "thread/resume" -> {
      case json.parse(json.to_string(params), decode.dynamic) {
        Ok(data) ->
          record(label, "snapshotReadStarted", [
            #("requestId", json.int(id)),
            #("threadId", value(data, ["threadId"])),
          ])
        Error(_) -> Nil
      }
    }
    _ -> Nil
  }
}

pub fn snapshot_response(
  label: String,
  id: Int,
  method: String,
  data: Dynamic,
) -> Nil {
  case method {
    "thread/read" | "thread/resume" ->
      record(label, "snapshotReadCompleted", [
        #("requestId", json.int(id)),
        #("threadId", value(data, ["thread", "id"])),
        #("status", value(data, ["thread", "status", "type"])),
      ])
    _ -> Nil
  }
}

pub fn request(label: String, method: String, params: Json) -> Nil {
  case method {
    "turn/start" -> {
      case json.parse(json.to_string(params), decode.dynamic) {
        Ok(data) ->
          record(label, "settings", [
            #("threadId", value(data, ["threadId"])),
            #("model", value(data, ["model"])),
            #("effort", value(data, ["effort"])),
          ])
        Error(_) -> Nil
      }
    }
    _ -> Nil
  }
}

pub fn response(label: String, method: String, data: Dynamic) -> Nil {
  case method {
    "account/read" -> {
      let email =
        jsonx.field_string(data, ["account", "email"]) |> result.unwrap("")
      let id =
        jsonx.field_string(data, ["account", "chatgptAccountId"])
        |> result.unwrap(email)
      let plan =
        jsonx.field_string(data, ["account", "planType"]) |> result.unwrap("")
      let kind =
        jsonx.field_string(data, ["account", "type"]) |> result.unwrap("")
      case id {
        "" -> record(label, "account", [#("fingerprint", json.null())])
        _ ->
          record(label, "account", [
            #(
              "fingerprint",
              json.string(fingerprint(id <> ":" <> kind <> ":" <> plan)),
            ),
          ])
      }
    }
    "account/rateLimits/read" -> quota(label, data)
    "thread/start" -> {
      metadata(label, data, ["thread"])
      record(label, "newThread", [#("threadId", value(data, ["thread", "id"]))])
    }
    "thread/resume" | "thread/read" -> {
      metadata(label, data, ["thread"])
      let turns =
        decode.run(
          data,
          decode.at(["thread", "turns"], decode.list(decode.dynamic)),
        )
        |> result.unwrap([])
      list.each(turns, fn(turn) {
        case jsonx.field_string(turn, ["status"]) {
          Ok("inProgress") ->
            record(label, "turn/started", [
              #("threadId", value(data, ["thread", "id"])),
              #("turnId", value(turn, ["id"])),
            ])
          _ -> Nil
        }
      })
    }
    _ -> Nil
  }
}

fn metadata(label: String, data: Dynamic, prefix: List(String)) -> Nil {
  let thread = value(data, list.append(prefix, ["id"]))
  record(label, "metadata", [
    #("threadId", thread),
    #("model", value(data, list.append(prefix, ["model"]))),
    #("effort", value(data, list.append(prefix, ["reasoningEffort"]))),
    #("parentThreadId", value(data, list.append(prefix, ["parentThreadId"]))),
  ])
}

pub fn notification(label: String, method: String, msg: Dynamic) -> Nil {
  case jsonx.field(msg, ["params"]) {
    Error(_) -> Nil
    Ok(data) ->
      case method {
        "thread/started" -> metadata(label, data, ["thread"])
        "account/rateLimits/updated" -> quota(label, data)
        "item/started" | "item/completed" -> {
          case
            jsonx.field_string(data, ["item", "type"]),
            jsonx.field_string(data, ["item", "tool"])
          {
            Ok("collabAgentToolCall"), Ok("spawnAgent") -> {
              let receivers =
                decode.run(
                  data,
                  decode.at(
                    ["item", "receiverThreadIds"],
                    decode.list(decode.string),
                  ),
                )
                |> result.unwrap([])
              list.each(receivers, fn(thread) {
                // This proves creation even when Codex only reports the
                // receiver after the child's first turn has completed.
                record(label, "spawnedThread", [
                  #("threadId", json.string(thread)),
                  #("parentThreadId", value(data, ["threadId"])),
                  #("model", value(data, ["item", "model"])),
                  #("effort", value(data, ["item", "reasoningEffort"])),
                ])
              })
            }
            _, _ -> Nil
          }
        }
        "thread/tokenUsage/updated" ->
          record(label, "tokens", [
            #("threadId", value(data, ["threadId"])),
            #("turnId", value(data, ["turnId"])),
            #("total", value(data, ["tokenUsage", "total"])),
            #("last", value(data, ["tokenUsage", "last"])),
          ])
        "turn/started" | "turn/completed" ->
          record(label, method, [
            #("threadId", value(data, ["threadId"])),
            #("turnId", value(data, ["turn", "id"])),
            #("status", value(data, ["turn", "status"])),
          ])
        _ -> Nil
      }
  }
}

fn quota(label: String, data: Dynamic) -> Nil {
  case jsonx.field(data, ["rateLimits"]) {
    Error(_) -> Nil
    Ok(limits) -> {
      list.each(["primary", "secondary"], fn(key) {
        case jsonx.field(limits, [key]) {
          Ok(window) ->
            case jsonx.field_int(window, ["windowDurationMins"]) {
              Ok(300) | Ok(10_080) ->
                record(label, "quota", [
                  #("windowDurationMins", value(window, ["windowDurationMins"])),
                  #("usedPercent", value(window, ["usedPercent"])),
                  #("resetsAt", value(window, ["resetsAt"])),
                  #("limitId", value(limits, ["limitId"])),
                  #("planType", value(limits, ["planType"])),
                ])
              _ -> Nil
            }
          Error(_) -> Nil
        }
      })
    }
  }
}

pub fn history(label: String) -> Json {
  let events =
    read(label)
    |> string.split("\n")
    |> list.filter_map(fn(line) {
      json.parse(line, decode.dynamic) |> result.map(jsonx.to_json)
    })
  json.object([
    #("host", json.string(label)),
    #("path", json.string(path(label))),
    #("events", json.preprocessed_array(events)),
  ])
}

/// Historical sources are included even when their remote connection is offline.
pub fn shared_history(label: String) -> Json {
  let events =
    read_all()
    |> string.split("\n")
    |> list.filter_map(fn(line) {
      json.parse(line, decode.dynamic) |> result.map(jsonx.to_json)
    })
  json.object([
    #("host", json.string(label)),
    #("events", json.preprocessed_array(events)),
  ])
}
