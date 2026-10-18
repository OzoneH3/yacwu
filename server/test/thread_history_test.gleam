import gleam/dynamic/decode
import gleam/json
import gleam/string
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

pub fn running_status_never_requests_transcript_or_turn_items_test() {
  let request = fn(method, params) {
    method |> should.equal("thread/read")
    jsonx.field_bool(value(json.to_string(params)), ["includeTurns"])
    |> should.equal(Ok(False))
    Ok(value("{\"thread\":{\"id\":\"t\",\"status\":{\"type\":\"active\"}}}"))
  }
  let assert Ok(data) = thread_history.runtime(request, "t")
  jsonx.field_string(value(json.to_string(data)), ["thread", "status", "type"])
  |> should.equal(Ok("active"))
}

pub fn stopped_status_reads_only_latest_turn_and_preserves_error_test() {
  let request = fn(method, params) {
    let params = value(json.to_string(params))
    case method {
      "thread/read" -> {
        jsonx.field_bool(params, ["includeTurns"]) |> should.equal(Ok(False))
        Ok(value("{\"thread\":{\"id\":\"t\",\"status\":{\"type\":\"idle\"}}}"))
      }
      _ -> {
        method |> should.equal("thread/turns/list")
        jsonx.field_int(params, ["limit"]) |> should.equal(Ok(1))
        jsonx.field_string(params, ["itemsView"])
        |> should.equal(Ok("notLoaded"))
        Ok(value(
          "{\"data\":[{\"id\":\"last\",\"startedAt\":2,\"status\":\"failed\",\"error\":{\"message\":\"broken\"},\"items\":[{\"text\":\"huge transcript\"}]},{\"id\":\"old\",\"startedAt\":1,\"status\":\"completed\"}]}",
        ))
      }
    }
  }
  let assert Ok(data) = thread_history.runtime(request, "t")
  let text = json.to_string(data)
  string.contains(text, "huge transcript") |> should.be_false
  string.contains(text, "broken") |> should.be_true
  string.contains(text, "old") |> should.be_false
}

pub fn legacy_adapter_order_still_returns_latest_turn_test() {
  let request = fn(method, _) {
    case method {
      "thread/read" ->
        Ok(value("{\"thread\":{\"status\":{\"type\":\"idle\"}}}"))
      _ ->
        Ok(value(
          "{\"data\":[{\"id\":\"old\",\"startedAt\":1,\"status\":\"failed\"},{\"id\":\"new\",\"startedAt\":2,\"status\":\"completed\"}]}",
        ))
    }
  }
  let assert Ok(data) = thread_history.runtime(request, "t")
  string.contains(json.to_string(data), "new") |> should.be_true
  string.contains(json.to_string(data), "old") |> should.be_false
}
