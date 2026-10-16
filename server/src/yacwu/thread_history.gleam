//// Opening an ephemeral thread must not require a persisted rollout.

import gleam/dynamic.{type Dynamic}
import gleam/json.{type Json}
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
