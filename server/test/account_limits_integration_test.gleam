import envoy
import exception
import filepath
import gleam/dynamic/decode
import gleam/erlang/process
import gleam/json
import gleam/list
import gleam/result
import gleam/string
import gleeunit/should
import yacwu/account_limits
import yacwu/codex
import yacwu/jsonx

pub fn all_running_turns_stop_and_new_work_is_rejected_test() {
  let path = account_limits.path()
  let previous = account_limits.load(path)
  let assert Ok(_) = account_limits.save(path, account_limits.Limits(10, 2000))
  let fixture =
    filepath.join(
      envoy.get("PWD") |> result.unwrap("."),
      "../tests/fixtures/account-limit-server.mjs",
    )
  let outcome =
    exception.rescue(fn() {
      check_provider("codex", fixture)
      check_provider("copilot", fixture)
    })
  let assert Ok(_) = account_limits.save(path, previous)
  outcome |> should.be_ok
  Nil
}

fn check_provider(provider, fixture) {
  let name = process.new_name("account_guard_" <> provider)
  let assert Ok(_) =
    codex.start(name, provider, codex.Local(["node", fixture, provider]))
  // A verified account sample permits both sessions to start.
  let assert Ok(_) =
    codex.request(name, "account/rateLimits/read", json.object([]))
  let start = fn(thread) {
    codex.request(
      name,
      "turn/start",
      json.object([#("threadId", json.string(thread))]),
    )
  }
  start("one") |> should.be_ok
  start("two") |> should.be_ok
  let assert Ok(_) = codex.request(name, "test/exhaust", json.object([]))
  let assert Ok(_) = codex.request(name, "test/stats", json.object([]))
  // The stop requests have been sent before the next barrier round-trip.
  let assert Ok(stats) = codex.request(name, "test/stats", json.object([]))
  let assert Ok(interrupted) =
    decode.run(stats, decode.at(["interrupted"], decode.list(decode.string)))
  interrupted |> list.sort(string.compare) |> should.equal(["one", "two"])
  start("three") |> should.be_error
  codex.request(
    name,
    "turn/steer",
    json.object([#("threadId", json.string("one"))]),
  )
  |> should.be_error
  let assert Ok(stats) = codex.request(name, "test/stats", json.object([]))
  jsonx.field_int(stats, ["starts"]) |> should.equal(Ok(2))
  jsonx.field_int(stats, ["steers"]) |> should.equal(Ok(0))
}
