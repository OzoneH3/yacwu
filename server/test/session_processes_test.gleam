import gleam/int
import gleam/list
import gleam/string
import gleeunit/should

type Port

@external(erlang, "yacwu_procs_test_ffi", "start_tagged_sleep")
fn start_tagged_sleep(thread: String) -> Port

@external(erlang, "yacwu_procs_test_ffi", "stop")
fn stop(port: Port) -> Nil

@external(erlang, "yacwu_procs", "tagged")
fn tagged(thread: String) -> List(#(Int, Int, String, Int, Int))

/// A session's commands are found by the thread tag they inherit, and only
/// that session's.
pub fn finds_processes_tagged_with_the_thread_test() {
  let thread = "procs-test-" <> int.to_string(int.random(1_000_000_000))
  let port = start_tagged_sleep(thread)
  wait_for_snapshot()
  let found = tagged(thread)
  stop(port)
  found
  |> list.map(fn(process) { process.2 })
  |> list.any(fn(command) { string.contains(command, "sleep 30") })
  |> should.be_true
  tagged(thread <> "-other") |> should.equal([])
}

@external(erlang, "yacwu_procs_test_ffi", "shared_snapshot")
fn shared_snapshot() -> Bool

pub fn shares_snapshot_until_expiry_test() {
  shared_snapshot() |> should.be_true
}

@external(erlang, "yacwu_procs_test_ffi", "wait_for_snapshot")
fn wait_for_snapshot() -> Nil
