//// Opening an ephemeral thread must not require a persisted rollout.

import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/json.{type Json}
import gleam/list
import gleam/result
import yacwu/jsonx

type Request =
  fn(String, Json) -> Result(Dynamic, String)

pub fn read(request: Request, thread: String) -> Result(Dynamic, String) {
  let params = fn(include) {
    json.object([
      #("threadId", json.string(thread)),
      #("includeTurns", json.bool(include)),
    ])
  }
  case request("thread/read", params(True)) {
    Ok(value) -> Ok(value)
    Error(original) -> {
      // Current Codex cannot read turns from ephemeral sessions. Metadata is
      // available while loaded; the browser retains its streamed items.
      use metadata <- result.try(request("thread/read", params(False)))
      case jsonx.field_bool(metadata, ["thread", "ephemeral"]) {
        Ok(True) -> Ok(metadata)
        _ -> Error(original)
      }
    }
  }
}

/// Poll metadata only while active. After a stop, request one turn without its
/// items so interruption reasons remain available without a transcript transfer.
pub fn runtime(request: Request, thread: String) -> Result(Json, String) {
  use metadata <- result.try(request(
    "thread/read",
    json.object([
      #("threadId", json.string(thread)),
      #("includeTurns", json.bool(False)),
    ]),
  ))
  let status = jsonx.field_string(metadata, ["thread", "status", "type"])
  let status_json =
    jsonx.field(metadata, ["thread", "status"])
    |> result.map(jsonx.to_json)
    |> result.unwrap(json.null())
  let turns = case status {
    Ok("idle") | Ok("notLoaded") -> {
      use page <- result.try(request(
        "thread/turns/list",
        json.object([
          #("threadId", json.string(thread)),
          #("limit", json.int(1)),
          #("sortDirection", json.string("desc")),
          #("itemsView", json.string("notLoaded")),
        ]),
      ))
      let entries =
        decode.run(page, decode.at(["data"], decode.list(decode.dynamic)))
        |> result.unwrap([])
      Ok(case entries {
        [] -> []
        [first, ..rest] -> {
          // Older adapters ignore limit/sortDirection and return oldest first.
          let latest =
            list.fold(rest, first, fn(best, candidate) {
              let a = jsonx.field_int(best, ["startedAt"]) |> result.unwrap(0)
              let b =
                jsonx.field_int(candidate, ["startedAt"]) |> result.unwrap(0)
              case b >= a {
                True -> candidate
                False -> best
              }
            })
          [
            json.object(
              list.map(["id", "status", "error"], fn(key) {
                #(
                  key,
                  jsonx.field(latest, [key])
                    |> result.map(jsonx.to_json)
                    |> result.unwrap(json.null()),
                )
              }),
            ),
          ]
        }
      })
    }
    _ -> Ok([])
  }
  use turns <- result.try(turns)
  Ok(
    json.object([
      #(
        "thread",
        json.object([
          #("id", json.string(thread)),
          #("status", status_json),
          #("turns", json.preprocessed_array(turns)),
        ]),
      ),
    ]),
  )
}
