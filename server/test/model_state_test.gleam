import gleam/dynamic/decode
import gleam/json
import gleam/option.{None, Some}
import gleam/string
import gleeunit/should
import simplifile
import yacwu/model_state

fn with_rollout(content: String, run: fn(String) -> a) -> a {
  let dir = "/tmp/yacwu-model-test"
  let _ = simplifile.create_directory_all(dir)
  let path = dir <> "/rollout.jsonl"
  let assert Ok(_) = simplifile.write(path, content)
  let result = run(path)
  let _ = simplifile.delete(path)
  result
}

pub fn reads_model_and_effort_from_latest_turn_context_test() {
  let filler =
    "{\"type\":\"event_msg\",\"payload\":{\"value\":\""
    <> string.repeat("x", 70_000)
    <> "\"}}"
  let content =
    string.join(
      [
        "{\"type\":\"turn_context\",\"payload\":{\"model\":\"old\",\"effort\":\"low\"}}",
        filler,
        "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.4\",\"effort\":\"high\"}}",
        "",
      ],
      "\n",
    )
  use path <- with_rollout(content)
  assert model_state.read_latest_turn_model(path)
    == Ok(model_state.Persisted(model: Some("gpt-5.4"), effort: Some("high")))
}

pub fn reads_turn_context_with_large_unicode_payload_test() {
  let content =
    "{\"type\":\"turn_context\",\"payload\":{\"model\":\"gpt-5.4\",\"effort\":\"xhigh\",\"developer_instructions\":\"unicode → "
    <> string.repeat("x", 70_000)
    <> "\"}}"
  use path <- with_rollout(content)
  assert model_state.read_latest_turn_model(path)
    == Ok(model_state.Persisted(model: Some("gpt-5.4"), effort: Some("xhigh")))
}

pub fn reads_reasoning_effort_fallback_field_test() {
  let content =
    "{\"type\":\"turn_context\",\"payload\":{\"reasoning_effort\":\"low\"}}"
  use path <- with_rollout(content)
  assert model_state.read_latest_turn_model(path)
    == Ok(model_state.Persisted(model: None, effort: Some("low")))
}

pub fn ignores_non_turn_context_lines_test() {
  let content = "{\"type\":\"event_msg\",\"payload\":{}}\n{\"broken json"
  use path <- with_rollout(content)
  assert model_state.read_latest_turn_model(path) == Error(Nil)
}

pub fn missing_rollout_returns_error_test() {
  assert model_state.read_latest_turn_model(
      "/definitely/missing/yacwu-rollout.jsonl",
    )
    == Error(Nil)
}

pub fn reads_selected_model_from_alternative_backend_thread_read_test() {
  let assert Ok(read) =
    json.parse(
      "{\"thread\":{\"path\":null},\"model\":\"claude-opus-5-5\",\"reasoningEffort\":\"high\"}",
      decode.dynamic,
    )
  model_state.thread_read_settings(read)
  |> should.equal(model_state.Persisted(
    model: Some("claude-opus-5-5"),
    effort: Some("high"),
  ))
}

pub fn backend_settings_fill_only_missing_rollout_values_test() {
  model_state.merge_persisted_settings(
    model_state.Persisted(model: Some("claude-opus-5-5"), effort: None),
    model_state.Persisted(model: Some("default"), effort: Some("high")),
  )
  |> should.equal(model_state.Persisted(
    model: Some("claude-opus-5-5"),
    effort: Some("high"),
  ))
}
