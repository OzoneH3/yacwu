import gleam/dynamic/decode
import gleam/json
import gleam/result
import gleam/string
import gleeunit/should
import simplifile
import yacwu/usage

pub fn records_separate_five_hour_and_weekly_quota_windows_test() {
  let label = "usage-windows-unit-test"
  let assert Ok(limits) =
    json.parse(
      "{\"rateLimits\":{\"limitId\":\"claude-code\",\"primary\":{\"usedPercent\":12.5,\"windowDurationMins\":300,\"resetsAt\":500},\"secondary\":{\"usedPercent\":5,\"windowDurationMins\":10080,\"resetsAt\":1000}}}",
      decode.dynamic,
    )
  usage.response(label, "account/rateLimits/read", limits)
  let saved = usage.history(label) |> json.to_string
  json.parse(
    saved,
    decode.at(
      ["events"],
      decode.list(decode.at(["windowDurationMins"], decode.int)),
    ),
  )
  |> should.equal(Ok([300, 10_080]))
  string.contains(saved, "12.5") |> should.be_true
  let path =
    json.parse(saved, decode.at(["path"], decode.string)) |> result.unwrap("")
  simplifile.delete(path) |> should.be_ok
}

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
  let assert Ok(account) =
    json.parse(
      "{\"account\":{\"type\":\"chatgpt\",\"email\":\"private@example.invalid\",\"planType\":\"pro\"}}",
      decode.dynamic,
    )
  usage.response(label, "account/read", account)
  let saved = usage.history(label) |> json.to_string
  string.contains(saved, "private-prompt-must-not-be-recorded")
  |> should.be_false
  string.contains(saved, "cachedInputTokens") |> should.be_true
  string.contains(saved, "usedPercent") |> should.be_true
  string.contains(saved, "private@example.invalid") |> should.be_false
  string.contains(saved, "fingerprint") |> should.be_true
  usage.shared_history(label)
  |> json.to_string
  |> string.contains("usage-unit-test")
  |> should.be_true
  let path =
    json.parse(saved, decode.at(["path"], decode.string)) |> result.unwrap("")
  simplifile.delete(path) |> should.be_ok
}

pub fn records_spawn_creation_and_last_token_usage_test() {
  let label = "usage-spawn-unit-test"
  let assert Ok(spawn) =
    json.parse(
      "{\"params\":{\"threadId\":\"parent\",\"item\":{\"type\":\"collabAgentToolCall\",\"tool\":\"spawnAgent\",\"receiverThreadIds\":[\"child\"],\"model\":\"model\",\"reasoningEffort\":\"medium\",\"prompt\":\"private spawn prompt\"}}}",
      decode.dynamic,
    )
  usage.notification(label, "item/completed", spawn)
  let assert Ok(tokens) =
    json.parse(
      "{\"params\":{\"threadId\":\"child\",\"turnId\":\"turn\",\"tokenUsage\":{\"total\":{\"totalTokens\":50},\"last\":{\"totalTokens\":50}}}}",
      decode.dynamic,
    )
  usage.notification(label, "thread/tokenUsage/updated", tokens)
  let saved = usage.history(label) |> json.to_string
  string.contains(saved, "spawnedThread") |> should.be_true
  string.contains(saved, "parentThreadId") |> should.be_true
  string.contains(saved, "\"last\"") |> should.be_true
  string.contains(saved, "private spawn prompt") |> should.be_false
  let path =
    json.parse(saved, decode.at(["path"], decode.string)) |> result.unwrap("")
  simplifile.delete(path) |> should.be_ok
}

pub fn correlates_idle_snapshot_reads_without_recording_thread_content_test() {
  let label = "usage-snapshot-unit-test"
  usage.snapshot_request(
    label,
    7,
    "thread/resume",
    json.object([
      #("threadId", json.string("old-thread")),
      #("developerInstructions", json.string("private instructions")),
    ]),
  )
  let assert Ok(reply) =
    json.parse(
      "{\"thread\":{\"id\":\"old-thread\",\"status\":{\"type\":\"idle\"},\"turns\":[{\"items\":[{\"text\":\"private transcript\"}]}]}}",
      decode.dynamic,
    )
  usage.snapshot_response(label, 7, "thread/resume", reply)
  let saved = usage.history(label) |> json.to_string
  string.contains(saved, "snapshotReadStarted") |> should.be_true
  string.contains(saved, "snapshotReadCompleted") |> should.be_true
  string.contains(saved, "requestId") |> should.be_true
  string.contains(saved, "idle") |> should.be_true
  string.contains(saved, "private") |> should.be_false
  let path =
    json.parse(saved, decode.at(["path"], decode.string)) |> result.unwrap("")
  simplifile.delete(path) |> should.be_ok
}
