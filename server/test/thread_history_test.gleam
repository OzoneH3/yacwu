import gleam/dynamic/decode
import gleam/json
import gleeunit/should
import yacwu/jsonx
import yacwu/thread_history

fn value(text) {
  let assert Ok(data) = json.parse(text, decode.dynamic)
  data
}

pub fn persisted_history_is_returned_without_fallback_test() {
  let data = value("{\"thread\":{\"id\":\"parent\",\"turns\":[]}}")
  thread_history.read(fn(_, _) { Ok(data) }, "parent") |> should.equal(Ok(data))
}

pub fn ephemeral_open_falls_back_to_live_metadata_test() {
  let metadata =
    value("{\"thread\":{\"id\":\"side\",\"ephemeral\":true,\"turns\":[]}}")
  let request = fn(method, params) {
    method |> should.equal("thread/read")
    case jsonx.field_bool(value(json.to_string(params)), ["includeTurns"]) {
      Ok(True) -> Error("ephemeral threads do not support includeTurns")
      _ -> Ok(metadata)
    }
  }
  thread_history.read(request, "side") |> should.equal(Ok(metadata))
}

pub fn ordinary_errors_are_not_hidden_by_metadata_test() {
  let request = fn(_, params) {
    case jsonx.field_bool(value(json.to_string(params)), ["includeTurns"]) {
      Ok(True) -> Error("cannot read persisted history")
      _ -> Ok(value("{\"thread\":{\"ephemeral\":false}}"))
    }
  }
  thread_history.read(request, "parent")
  |> should.equal(Error("cannot read persisted history"))
}
