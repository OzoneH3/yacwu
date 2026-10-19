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

/// Opening already fetched history through read; resume only needs metadata.
pub fn resume_without_history(
  request: Request,
  params: List(#(String, Json)),
) -> Result(Dynamic, String) {
  request(
    "thread/resume",
    json.object([#("excludeTurns", json.bool(True)), ..params]),
  )
}

/// Read a bounded newest-first page and present it in transcript order.
pub fn page(
  request: Request,
  thread: String,
  cursor: String,
) -> Result(Json, String) {
  let params = [
    #("threadId", json.string(thread)),
    #("limit", json.int(3)),
    #("sortDirection", json.string("desc")),
    #("itemsView", json.string("full")),
  ]
  let params = case cursor {
    "" -> params
    _ -> [#("cursor", json.string(cursor)), ..params]
  }
  use response <- result.try(request("thread/turns/list", json.object(params)))
  use turns <- result.try(
    decode.run(response, decode.at(["data"], decode.list(decode.dynamic)))
    |> result.replace_error("Invalid history page"),
  )
  // Older adapters may ignore pagination. Use the full-history fallback.
  case list.length(turns) > 3 {
    True -> Error("Backend does not support bounded history pages")
    False ->
      Ok(
        json.object([
          #("turns", json.array(list.reverse(turns), jsonx.to_json)),
          #(
            "cursor",
            jsonx.field(response, ["nextCursor"])
              |> result.map(jsonx.to_json)
              |> result.unwrap(json.null()),
          ),
        ]),
      )
  }
}

pub fn recent(request: Request, thread: String) -> Result(Dynamic, String) {
  let recent = fn() {
    use metadata <- result.try(request(
      "thread/read",
      json.object([
        #("threadId", json.string(thread)),
        #("includeTurns", json.bool(False)),
      ]),
    ))
    use history <- result.try(page(request, thread, ""))
    use history <- result.try(
      json.parse(json.to_string(history), decode.dynamic)
      |> result.replace_error("Invalid history page"),
    )
    use thread_data <- result.try(
      jsonx.field(metadata, ["thread"])
      |> result.replace_error("Missing thread metadata"),
    )
    let turns =
      jsonx.field(history, ["turns"])
      |> result.map(jsonx.to_json)
      |> result.unwrap(json.array([], json.string))
    let cursor =
      jsonx.field(history, ["cursor"])
      |> result.map(jsonx.to_json)
      |> result.unwrap(json.null())
    jsonx.object_with(metadata, [
      #("thread", jsonx.object_with(thread_data, [#("turns", turns)])),
      #("historyCursor", cursor),
    ])
    |> json.to_string
    |> json.parse(decode.dynamic)
    |> result.replace_error("Invalid thread metadata")
  }
  case recent() {
    Ok(data) -> Ok(data)
    Error(_) -> read(request, thread)
  }
}
