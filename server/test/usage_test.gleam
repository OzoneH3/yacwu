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
  let shared = usage.shared_history(label)
  string.contains(shared, "usage-unit-test") |> should.be_true
  // Passed through as written, it is still one valid JSON document.
  json.parse(shared, decode.at(["events"], decode.list(decode.dynamic)))
  |> result.is_ok
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

/// A line cut short by a crash mid-write is left out; the rest still reads.
pub fn shared_history_skips_a_torn_line_test() {
  let label = "usage-torn-unit-test"
  usage.record(label, "collectorStarted", [])
  let assert Ok(path) =
    json.parse(
      usage.history(label) |> json.to_string,
      decode.at(["path"], decode.string),
    )
  let assert Ok(Nil) =
    simplifile.append(path, "{\"event\":\"tokens\",\"total\":{\"a\":1}\n")
  usage.record(label, "collectorStarted", [])
  let shared = usage.shared_history(label)
  let assert Ok(events) =
    json.parse(shared, decode.at(["events"], decode.list(decode.dynamic)))
  { events != [] } |> should.be_true
  string.contains(shared, "\"total\":{\"a\":1}") |> should.be_false
  simplifile.delete(path) |> should.be_ok
}

pub fn incremental_journal_sends_only_new_complete_records_and_resets_on_rotation_test() {
  let label = "usage-delta-regression-test"
  usage.record(label, "first", [])
  let first = usage.shared_delta(label, "")
  let assert Ok(cursor) =
    json.parse(first, decode.at(["cursor"], decode.string))
  json.parse(first, decode.at(["reset"], decode.bool)) |> should.equal(Ok(True))
  string.contains(first, "usage-delta-regression-test") |> should.be_true
  let unchanged = usage.shared_delta(label, cursor)
  json.parse(unchanged, decode.at(["events"], decode.list(decode.dynamic)))
  |> should.equal(Ok([]))
  let path =
    usage.history(label)
    |> json.to_string
    |> json.parse(decode.at(["path"], decode.string))
    |> result.unwrap("")
  let assert Ok(before) = simplifile.read(path)
  simplifile.write(
    path,
    before <> "{\"host\":\"usage-delta-regression-test\",\"event\":\"partial\"}",
  )
  |> should.be_ok
  let partial = usage.shared_delta(label, cursor)
  string.contains(partial, "partial") |> should.be_false
  let assert Ok(partial_cursor) =
    json.parse(partial, decode.at(["cursor"], decode.string))
  simplifile.write(
    path,
    before
      <> "{\"host\":\"usage-delta-regression-test\",\"event\":\"partial\"}\n",
  )
  |> should.be_ok
  let completed = usage.shared_delta(label, partial_cursor)
  string.contains(completed, "partial") |> should.be_true
  string.contains(completed, "first") |> should.be_false
  let assert Ok(completed_cursor) =
    json.parse(completed, decode.at(["cursor"], decode.string))
  simplifile.rename(path, path <> ".1") |> should.be_ok
  usage.record(label, "afterRotation", [])
  let rotated = usage.shared_delta(label, completed_cursor)
  json.parse(rotated, decode.at(["reset"], decode.bool))
  |> should.equal(Ok(True))
  string.contains(rotated, "first") |> should.be_true
  string.contains(rotated, "afterRotation") |> should.be_true
  json.parse(
    usage.shared_delta(label, "invalid cursor"),
    decode.at(["reset"], decode.bool),
  )
  |> should.equal(Ok(True))
  simplifile.delete(path) |> should.be_ok
  simplifile.delete(path <> ".1") |> should.be_ok
}
