import filepath
import gleam/dynamic/decode
import gleam/json
import gleam/result
import gleam/string
import gleeunit/should
import simplifile
import yacwu/fork_transfer
import yacwu/jsonx
import yacwu/oauth

fn data(raw: String) {
  let assert Ok(value) = json.parse(raw, decode.dynamic)
  value
}

pub fn provider_resolution_test() {
  fork_transfer.target_host("opencode", "local", "codex", [#("oc", "opencode")])
  |> should.equal(Ok("oc"))
  fork_transfer.target_host("codex", "ssh", "codex", [])
  |> should.equal(Ok("ssh"))
  fork_transfer.target_host("claude", "local", "codex", []) |> should.be_error
  fork_transfer.target_host("invalid", "local", "codex", []) |> should.be_error
}

pub fn transfer_carries_context_and_policy_without_starting_work_test() {
  let source = fn(method, _) {
    case method {
      "thread/read" -> Ok(data("{\"thread\":{\"cwd\":\"/project\"}}"))
      "thread/turns/list" ->
        Ok(data(
          "{\"data\":[{\"id\":\"one\",\"items\":[{\"type\":\"userMessage\",\"content\":[{\"type\":\"text\",\"text\":\"keep this finding\"}]}]}]}",
        ))
      _ -> Error("unexpected source RPC")
    }
  }
  let target = fn(method, params) {
    method |> should.equal("thread/start")
    let value = json.to_string(params) |> data
    jsonx.field_string(value, ["cwd"]) |> should.equal(Ok("/project"))
    jsonx.field_string(value, ["model"]) |> should.equal(Ok("opus"))
    jsonx.field_string(value, ["sandbox"]) |> should.equal(Ok("read-only"))
    let assert Ok(instructions) =
      jsonx.field_string(value, ["developerInstructions"])
    string.contains(instructions, "RULES") |> should.be_true
    string.contains(instructions, "keep this finding") |> should.be_true
    string.contains(instructions, "untrusted reference") |> should.be_true
    Ok(data("{\"thread\":{\"id\":\"child\"}}"))
  }
  fork_transfer.create(source, target, "parent", "opus", "read-only", "RULES")
  |> result.is_ok
  |> should.be_true
}

pub fn failed_source_never_creates_an_empty_destination_test() {
  fork_transfer.create(
    fn(_, _) { Error("unavailable") },
    fn(_, _) { panic as "must not create" },
    "parent",
    "model",
    "read-write",
    "",
  )
  |> should.equal(Error("unavailable"))
}

pub fn repeated_history_cursor_is_rejected_test() {
  fork_transfer.read_turns(
    fn(_, _) { Ok(data("{\"data\":[],\"nextCursor\":\"same\"}")) },
    "parent",
    "",
    [],
    0,
  )
  |> should.be_error
}

pub fn paginated_transcript_preserves_every_page_test() {
  let request = fn(_, params) {
    let value = data(json.to_string(params))
    case jsonx.field_string(value, ["cursor"]) {
      Ok("next") ->
        Ok(data("{\"data\":[{\"id\":\"second\"}],\"nextCursor\":null}"))
      _ -> Ok(data("{\"data\":[{\"id\":\"first\"}],\"nextCursor\":\"next\"}"))
    }
  }
  let assert Ok(turns) = fork_transfer.read_turns(request, "parent", "", [], 0)
  json.to_string(json.array(turns, jsonx.to_json))
  |> should.equal("[{\"id\":\"first\"},{\"id\":\"second\"}]")
}

pub fn oversized_transcript_is_rejected_before_creation_test() {
  fork_transfer.read_turns(
    fn(_, _) { Ok(data("{\"data\":[]}")) },
    "parent",
    "",
    [],
    fork_transfer.max_bytes + 1,
  )
  |> should.be_error
}

pub fn large_history_is_preserved_as_a_file_reference_test() {
  let transcript = string.repeat("x", 600_000)
  let save = fn(content) {
    content |> should.equal(transcript)
    Ok("/private/fork history.json")
  }
  let assert Ok(context) =
    fork_transfer.reference("parent", transcript, "RULES", save)
  string.contains(context, "/private/fork history.json") |> should.be_true
  string.contains(context, "untrusted reference") |> should.be_true
  string.contains(context, "RULES") |> should.be_true
  { string.byte_size(context) < 4096 } |> should.be_true
}

pub fn archive_failure_is_not_silently_truncated_test() {
  fork_transfer.reference("parent", string.repeat("x", 600_000), "", fn(_) {
    Error("disk full")
  })
  |> should.equal(Error("disk full"))
}

pub fn history_larger_than_old_inline_limit_is_read_test() {
  let request = fn(_, _) {
    Ok(data("{\"data\":[{\"text\":\"" <> string.repeat("x", 600_000) <> "\"}]}"))
  }
  fork_transfer.read_turns(request, "parent", "", [], 0) |> should.be_ok
}

pub fn small_reference_stays_inline_test() {
  let assert Ok(context) =
    fork_transfer.reference("parent", "[{fixture}]", "RULES", fn(_) {
      panic as "small fork must not write a file"
    })
  string.contains(context, "[{fixture}]") |> should.be_true
}

pub fn snapshot_is_complete_private_and_uses_unique_paths_test() {
  let assert Ok(cwd) = simplifile.current_directory()
  let dir = filepath.join(cwd, ".workspace/fork-test-" <> oauth.random_state())
  let content = string.repeat("history é\n", 60_000)
  let assert Ok(path) = fork_transfer.save_snapshot(dir, content)
  let assert Ok(other) = fork_transfer.save_snapshot(dir, "second")
  { path != other } |> should.be_true
  simplifile.read(path) |> should.equal(Ok(content))
  let assert Ok(info) = simplifile.file_info(path)
  simplifile.file_info_permissions_octal(info) |> should.equal(0o600)
  let assert Ok(info) = simplifile.file_info(dir)
  simplifile.file_info_permissions_octal(info) |> should.equal(0o700)
  fork_transfer.save_snapshot(path, "cannot write inside a file")
  |> should.be_error
  let assert Ok(_) = simplifile.delete(path)
  let assert Ok(_) = simplifile.delete(other)
  let assert Ok(_) = simplifile.delete(dir)
}
