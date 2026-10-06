import gleam/erlang/process
import gleam/json
import gleeunit/should
import yacwu/benchmark

@external(erlang, "yacwu_benchmark", "launch")
fn launch(label: String, worker: fn() -> Nil) -> Bool

@external(erlang, "yacwu_benchmark", "cancelled")
fn cancelled(label: String) -> Bool

@external(erlang, "yacwu_benchmark", "finish")
fn finish(label: String, status: String) -> Nil

pub fn benchmark_limits_are_checked_before_any_codex_work_test() {
  let registry = process.new_name("unused_benchmark_registry")
  let cx = process.new_name("unused_benchmark_codex")
  benchmark.start(registry, "test", cx, "model", "medium", 0, 12, 20)
  |> should.be_error
  benchmark.start(registry, "test", cx, "model", "medium", 6, 12, 20)
  |> should.be_error
  benchmark.start(registry, "test", cx, "model", "medium", 2, 101, 20)
  |> should.be_error
  benchmark.start(registry, "test", cx, "model", "medium", 2, 12, 61)
  |> should.be_error
}

pub fn benchmark_reservation_and_manual_cancel_test() {
  let label = "benchmark-unit-control"
  let ready = process.new_subject()
  let done = process.new_subject()
  launch(label, fn() {
    let release = process.new_subject()
    process.send(ready, release)
    let _ = process.receive(release, 5000)
    finish(label, "{\"status\":\"stopped\"}")
    process.send(done, Nil)
  })
  |> should.be_true
  let assert Ok(release) = process.receive(ready, 1000)
  launch(label, fn() { Nil }) |> should.be_false
  benchmark.cancel(label)
  cancelled(label) |> should.be_true
  benchmark.status(label)
  |> json.to_string
  |> should.equal("{\"status\":\"stopping\"}")
  process.send(release, Nil)
  process.receive(done, 5000) |> should.be_ok
}
