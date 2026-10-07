import gleam/erlang/process
import gleam/json
import gleam/list
import gleeunit/should
import yacwu/benchmark
import yacwu/benchmark_plan
import yacwu/benchmark_settling

@external(erlang, "yacwu_benchmark", "launch")
fn launch(label: String, worker: fn() -> Nil) -> Bool

@external(erlang, "yacwu_benchmark", "cancelled")
fn cancelled(label: String) -> Bool

@external(erlang, "yacwu_benchmark", "finish")
fn finish(label: String, status: String) -> Nil

pub fn batch_plan_targets_and_order_test() {
  let combinations = [
    #("a", "low"),
    #("a", "medium"),
    #("b", "low"),
    #("b", "medium"),
    #("c", "low"),
    #("c", "medium"),
  ]
  let assert Ok(stages) = benchmark_plan.batch(combinations, True)
  list.map(stages, fn(stage) { #(stage.model, stage.effort, stage.target) })
  |> should.equal([
    #("a", "low", 2),
    #("a", "medium", 1),
    #("b", "low", 1),
    #("b", "medium", 1),
    #("c", "low", 1),
    #("c", "medium", 1),
  ])
  let assert Ok(conservative) = benchmark_plan.batch(combinations, False)
  list.map(conservative, fn(stage) { stage.target })
  |> should.equal([2, 2, 2, 2, 2, 2])
}

pub fn invalid_batch_plan_is_rejected_before_codex_work_test() {
  let registry = process.new_name("unused_batch_registry")
  let cx = process.new_name("unused_batch_codex")
  list.each(
    [[], [#("", "low")], [#("a", "low"), #("a", "low")], [#("a", "high")]],
    fn(stages) {
      benchmark.start_batch(registry, "test", cx, stages, True, 12, 20)
      |> should.be_error
    },
  )
}

pub fn benchmark_limits_are_checked_before_any_codex_work_test() {
  let registry = process.new_name("unused_benchmark_registry")
  let cx = process.new_name("unused_benchmark_codex")
  benchmark.start(registry, "test", cx, "model", "medium", 0, 12, 20)
  |> should.be_error
  benchmark.start(registry, "test", cx, "model", "medium", 1, 12, 20)
  |> should.be_error
  benchmark.start(registry, "test", cx, "model", "medium", 6, 12, 20)
  |> should.be_error
  benchmark.start(registry, "test", cx, "model", "medium", 2, 101, 20)
  |> should.be_error
  benchmark.start(registry, "test", cx, "model", "medium", 2, 12, 61)
  |> should.be_error
  benchmark.start(registry, "test", cx, "model", "medium", 2, 12, 2)
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
  launch("different-host", fn() { Nil }) |> should.be_false
  benchmark.cancel(label)
  cancelled(label) |> should.be_true
  benchmark.status(label)
  |> json.to_string
  |> should.equal("{\"status\":\"stopping\"}")
  process.send(release, Nil)
  process.receive(done, 5000) |> should.be_ok
}

pub fn delayed_and_backwards_quota_readings_must_settle_test() {
  let first = benchmark_settling.start(0, 80, 1000)
  benchmark_settling.ready(first, 60, 90) |> should.be_false
  let assert Ok(rise) = benchmark_settling.observe(first, 85, 81, 1000)
  benchmark_settling.ready(rise, 90, 90) |> should.be_false
  let assert Ok(stale) = benchmark_settling.observe(rise, 100, 80, 1000)
  benchmark_settling.ready(stale, 170, 90) |> should.be_false
  let assert Ok(recovered) = benchmark_settling.observe(stale, 175, 81, 1000)
  benchmark_settling.ready(recovered, 234, 90) |> should.be_false
  benchmark_settling.ready(recovered, 235, 90) |> should.be_true
  benchmark_settling.observe(recovered, 240, 0, 2000) |> should.be_error
  benchmark_settling.observe(recovered, 240, 81, 1001) |> should.be_ok
  benchmark_settling.observe(recovered, 240, 81, 1061) |> should.be_error
}
