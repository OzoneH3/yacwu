import gleam/dynamic/decode
import gleam/json
import gleam/result
import gleam/string
import gleeunit/should
import yacwu/fork_transfer
import yacwu/jsonx

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
