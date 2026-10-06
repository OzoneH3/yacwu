import gleam/dynamic/decode
import gleam/json
import gleam/result
import gleam/string
import gleeunit/should
import simplifile
import yacwu/usage

pub fn persists_usage_without_conversation_content_test() {
  let label = "usage-unit-test"
  usage.request(
    label,
    "turn/start",
    json.object([
      #("threadId", json.string("thread")),
      #("model", json.string("model")),
      #("effort", json.string("high")),
      #("input", json.string("private-prompt-must-not-be-recorded")),
    ]),
  )
  let assert Ok(notification) =
    json.parse(
      "{\"params\":{\"threadId\":\"thread\",\"turnId\":\"turn\",\"tokenUsage\":{\"total\":{\"totalTokens\":500,\"cachedInputTokens\":200}}}}",
      decode.dynamic,
    )
  usage.notification(label, "thread/tokenUsage/updated", notification)
  let assert Ok(limits) =
    json.parse(
      "{\"rateLimits\":{\"limitId\":\"codex\",\"secondary\":{\"usedPercent\":17,\"windowDurationMins\":10080,\"resetsAt\":1000}}}",
      decode.dynamic,
    )
  usage.response(label, "account/rateLimits/read", limits)
  let saved = usage.history(label) |> json.to_string
  string.contains(saved, "private-prompt-must-not-be-recorded")
  |> should.be_false
  string.contains(saved, "cachedInputTokens") |> should.be_true
  string.contains(saved, "usedPercent") |> should.be_true
  let path =
    json.parse(saved, decode.at(["path"], decode.string)) |> result.unwrap("")
  simplifile.delete(path) |> should.be_ok
}
