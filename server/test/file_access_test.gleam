import envoy
import filepath
import gleam/dynamic/decode
import gleam/erlang/process
import gleam/int
import gleam/json
import gleam/list
import gleam/result
import gleeunit/should
import simplifile
import yacwu/codex
import yacwu/file_access
import yacwu/jsonx

@external(erlang, "erlang", "unique_integer")
fn unique() -> Int

pub fn policies_survive_opens_forks_and_manager_recreation_test() {
  let label = "access-test-" <> int.to_string(unique())
  let fixture =
    filepath.join(
      envoy.get("PWD") |> result.unwrap("."),
      "../tests/fixtures/file-access-server.mjs",
    )
  let name = process.new_name(label)
  let assert Ok(_) = codex.start(name, label, codex.Local(["node", fixture]))
  let ask = fn(method, fields) {
    codex.request(name, method, json.object(fields))
  }
  let assert Ok(created) =
    ask("thread/start", [#("sandbox", json.string("read-only"))])
  let assert Ok(thread) = jsonx.field_string(created, ["thread", "id"])
  file_access.load(label, thread) |> should.equal(Ok("read-only"))
  let tid = #("threadId", json.string(thread))
  // A resume's full-access defaults and profile must not widen the saved mode.
  let assert Ok(_) =
    ask("thread/resume", [
      tid,
      #("sandbox", json.string("danger-full-access")),
      #("permissions", json.string("full-access")),
      #("permissionProfile", json.string("full-access")),
    ])
  let assert Ok(forked) = ask("thread/fork", [tid])
  let assert Ok(child) = jsonx.field_string(forked, ["thread", "id"])
  file_access.load(label, child) |> should.equal(Ok("read-only"))
  ask("thread/shellCommand", [tid, #("command", json.string("touch forbidden"))])
  |> should.be_error
  let assert Ok(_) =
    ask("turn/start", [
      tid,
      #(
        "sandboxPolicy",
        json.object([#("type", json.string("dangerFullAccess"))]),
      ),
    ])
  ask("yacwu/fileAccess/set", [tid, #("mode", json.string("read-write"))])
  |> should.be_error
  let assert Ok(_) = ask("turn/interrupt", [tid])
  let assert Ok(seen) = ask("test/seen", [])
  let assert Ok(requests) =
    decode.run(seen, decode.at(["seen"], decode.list(decode.dynamic)))
  let resume =
    requests
    |> list.find(fn(r) {
      jsonx.field_string(r, ["method"]) == Ok("thread/resume")
    })
  let assert Ok(resume) = resume
  jsonx.field_string(resume, ["params", "sandbox"])
  |> should.equal(Ok("read-only"))
  jsonx.field(resume, ["params", "permissionProfile"]) |> should.be_error
  jsonx.field(resume, ["params", "permissions"]) |> should.be_error
  let assert Ok(turn) =
    list.find(requests, fn(r) {
      jsonx.field_string(r, ["method"]) == Ok("turn/start")
    })
  jsonx.field_string(turn, ["params", "sandboxPolicy", "type"])
  |> should.equal(Ok("readOnly"))
  let reopened = process.new_name(label <> "-reopened")
  let assert Ok(_) =
    codex.start(reopened, label, codex.Local(["node", fixture]))
  let assert Ok(access) =
    codex.request(reopened, "yacwu/fileAccess/read", json.object([tid]))
  jsonx.field_string(access, ["mode"]) |> should.equal(Ok("read-only"))
  let assert Ok(_) =
    ask("yacwu/fileAccess/set", [tid, #("mode", json.string("read-write"))])
  file_access.load(label, thread) |> should.equal(Ok("read-write"))
  let assert Ok(_) = ask("turn/start", [tid])
  let assert Ok(seen) = ask("test/seen", [])
  let assert Ok(requests) =
    decode.run(seen, decode.at(["seen"], decode.list(decode.dynamic)))
  let assert Ok(last) =
    requests
    |> list.filter(fn(r) {
      jsonx.field_string(r, ["method"]) == Ok("turn/start")
    })
    |> list.last
  jsonx.field_string(last, ["params", "sandboxPolicy", "type"])
  |> should.equal(Ok("dangerFullAccess"))
}

pub fn unsupported_providers_and_invalid_records_fail_closed_test() {
  file_access.authorize("claude", "read-only") |> should.be_error
  file_access.authorize("copilot", "read-only") |> should.be_error
  file_access.authorize("codex", "typo") |> should.be_error
  let host = "corrupt-access-" <> int.to_string(unique())
  file_access.load(host, "../session") |> should.equal(Ok("read-write"))
  let assert Ok(_) = file_access.save(host, "../session", "read-only")
  let assert Ok(_) =
    simplifile.write(file_access.path(host, "../session"), "broken")
  file_access.prepare(
    host,
    "codex",
    "turn/start",
    json.object([#("threadId", json.string("../session"))]),
  )
  |> should.be_error
}

pub fn spawned_agents_and_approval_requests_retain_read_only_access_test() {
  let host = "approval-access-" <> int.to_string(unique())
  let assert Ok(_) = file_access.save(host, "parent", "read-only")
  let notification =
    file_access.dynamic(
      json.object([
        #(
          "params",
          json.object([
            #("threadId", json.string("parent")),
            #(
              "item",
              json.object([
                #("tool", json.string("spawnAgent")),
                #("receiverThreadIds", json.array(["child"], json.string)),
              ]),
            ),
          ]),
        ),
      ]),
    )
  file_access.inherit_agents(host, notification)
  file_access.load(host, "child") |> should.equal(Ok("read-only"))
  let request =
    file_access.dynamic(
      json.object([
        #("params", json.object([#("threadId", json.string("child"))])),
      ]),
    )
  file_access.approval(host, "item/commandExecution/requestApproval", request)
  |> file_access.dynamic
  |> jsonx.field_string(["decision"])
  |> should.equal(Ok("decline"))
  file_access.approval(host, "item/fileChange/requestApproval", request)
  |> file_access.dynamic
  |> jsonx.field_string(["decision"])
  |> should.equal(Ok("decline"))
  file_access.approval(host, "item/permissions/requestApproval", request)
  |> json.to_string
  |> should.equal("{\"permissions\":{},\"scope\":\"turn\"}")
}

pub fn claude_read_only_requires_the_backend_capability_test() {
  let fixture =
    filepath.join(
      envoy.get("PWD") |> result.unwrap("."),
      "../tests/fixtures/file-access-server.mjs",
    )
  let ready = process.new_name("claude_ready")
  let old = process.new_name("claude_old")
  let label = "claude-access-" <> int.to_string(unique())
  let assert Ok(_) =
    codex.start(ready, label, codex.Local(["node", fixture, "read-only-ready"]))
  let assert Ok(_) =
    codex.start(old, label <> "-old", codex.Local(["node", fixture]))
  // Initialize both processes before querying their advertised capabilities.
  let assert Ok(_) = codex.request(ready, "test/seen", json.object([]))
  let assert Ok(_) = codex.request(old, "test/seen", json.object([]))
  let params = json.object([#("threadId", json.string("existing"))])
  let assert Ok(ready_state) =
    codex.request(ready, "yacwu/fileAccess/read", params)
  jsonx.field_bool(ready_state, ["readOnlySupported"]) |> should.equal(Ok(True))
  jsonx.field_string(ready_state, ["readOnlyKind"]) |> should.equal(Ok("tools"))
  let assert Ok(old_state) = codex.request(old, "yacwu/fileAccess/read", params)
  jsonx.field_bool(old_state, ["readOnlySupported"]) |> should.equal(Ok(False))
  jsonx.field_string(old_state, ["readOnlyReason"])
  |> should.equal(Ok(
    "Restart the Claude backend daemon to enable read-only file access.",
  ))
  let create = json.object([#("sandbox", json.string("read-only"))])
  codex.request(old, "thread/start", create) |> should.be_error
  let assert Ok(created) = codex.request(ready, "thread/start", create)
  let assert Ok(thread) = jsonx.field_string(created, ["thread", "id"])
  file_access.load(label, thread) |> should.equal(Ok("read-only"))
  let assert Ok(_) =
    codex.request(
      ready,
      "turn/start",
      json.object([#("threadId", json.string(thread))]),
    )
  let assert Ok(seen) = codex.request(ready, "test/seen", json.object([]))
  let assert Ok(requests) =
    decode.run(seen, decode.at(["seen"], decode.list(decode.dynamic)))
  let assert Ok(turn) =
    list.find(requests, fn(r) {
      jsonx.field_string(r, ["method"]) == Ok("turn/start")
    })
  jsonx.field_string(turn, ["params", "sandboxPolicy", "type"])
  |> should.equal(Ok("readOnly"))
}
