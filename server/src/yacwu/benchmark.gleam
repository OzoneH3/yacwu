//// Explicit, bounded, text-only calibration runs. Never runs on application launch.

import gleam/dynamic/decode
import gleam/erlang/process
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import yacwu/benchmark_plan.{type Stage, Stage}
import yacwu/benchmark_settling
import yacwu/codex.{type Codex}
import yacwu/hosts
import yacwu/jsonx
import yacwu/model_state
import yacwu/oauth
import yacwu/usage

@external(erlang, "yacwu_benchmark", "launch")
fn launch(host: String, worker: fn() -> Nil) -> Bool

@external(erlang, "yacwu_benchmark", "update")
fn write_status(host: String, status: String) -> Nil

// Retain run identity, settings and counts when changing phases.
fn update(host: String, status: String) -> Nil {
  let merged = case
    json.parse(status_text(host), decode.dynamic),
    json.parse(status, decode.dynamic)
  {
    Ok(previous), Ok(next) ->
      jsonx.object_with(previous, [
        #("updatedAt", json.int(oauth.now())),
        ..list.map(jsonx.object_fields(next), fn(field) {
          #(field.0, jsonx.to_json(field.1))
        })
      ])
      |> json.to_string
    _, _ -> status
  }
  write_status(host, merged)
}

@external(erlang, "yacwu_benchmark", "finish")
fn finish(host: String, status: String) -> Nil

@external(erlang, "yacwu_benchmark", "status")
fn status_text(host: String) -> String

@external(erlang, "yacwu_benchmark", "cancel")
pub fn cancel(host: String) -> Nil

@external(erlang, "yacwu_benchmark", "cancelled")
fn cancelled(host: String) -> Bool

@external(erlang, "yacwu_benchmark", "check_due")
fn check_due() -> Bool

pub fn status(host: String) -> Json {
  case json.parse(status_text(host), decode.dynamic) {
    Error(_) -> json.null()
    Ok(data) -> {
      let running =
        list.contains(
          ["starting", "running", "settling"],
          jsonx.field_string(data, ["status"]) |> result.unwrap(""),
        )
      case running && cancelled(host) {
        True -> jsonx.object_with(data, [#("status", json.string("stopping"))])
        False -> jsonx.to_json(data)
      }
    }
  }
}

fn busy(registry: hosts.Registry, thread: String) -> Bool {
  hosts.running(registry)
  |> list.any(fn(manager) {
    let snapshot = codex.diagnostic_snapshot(manager.1) |> json.to_string
    let active =
      json.parse(
        snapshot,
        decode.at(["activeTurns"], decode.list(decode.dynamic)),
      )
      |> result.unwrap([])
    list.any(active, fn(turn) {
      jsonx.field_string(turn, ["threadId"]) != Ok(thread)
    })
  })
}

pub fn start(
  registry: hosts.Registry,
  host: String,
  cx: Codex,
  model: String,
  effort: String,
  target: Int,
  max_turns: Int,
  minutes: Int,
) -> Result(Nil, String) {
  case target >= 2 && target <= 5 {
    False -> Error("Choose a 2–5 percentage-point target")
    True ->
      start_plan(
        registry,
        host,
        cx,
        [Stage(model, effort, target)],
        max_turns,
        minutes,
      )
  }
}

pub fn start_batch(
  registry: hosts.Registry,
  host: String,
  cx: Codex,
  models: List(String),
  economical: Bool,
  max_turns: Int,
  minutes: Int,
) -> Result(Nil, String) {
  use stages <- result.try(benchmark_plan.batch(models, economical))
  start_plan(registry, host, cx, stages, max_turns, minutes)
}

fn start_plan(
  registry: hosts.Registry,
  host: String,
  cx: Codex,
  stages: List(Stage),
  max_turns: Int,
  minutes: Int,
) -> Result(Nil, String) {
  case max_turns >= 1 && max_turns <= 100 && minutes >= 3 && minutes <= 60 {
    False ->
      Error(
        "Choose 1–100 turns and 3–60 minutes per combination",
      )
    True -> {
      use catalog <- result.try(model_state.list_model_choices(cx))
      case
        list.all(stages, fn(stage) {
          list.any(catalog.models, fn(choice) {
            choice.id == stage.model
            && list.contains(choice.efforts, stage.effort)
          })
        })
      {
        False -> Error("Choose an available model and supported thinking level")
        True ->
          case busy(registry, "") {
            True -> Error("Pause other Yacwu tasks before starting a benchmark")
            False ->
              case
                launch(host, fn() {
                  update(
                    host,
                    json.to_string(
                      json.object([
                        #("batchStartedAt", json.int(oauth.now())),
                        #("stageTotal", json.int(list.length(stages))),
                        #(
                          "batchTargetPercent",
                          json.int(
                            list.fold(stages, 0, fn(sum, stage) {
                              sum + stage.target
                            }),
                          ),
                        ),
                        #("batchUsedPercent", json.int(0)),
                        #("results", json.preprocessed_array([])),
                        #(
                          "plan",
                          json.preprocessed_array(
                            list.map(stages, fn(stage) {
                              json.object([
                                #("model", json.string(stage.model)),
                                #("effort", json.string(stage.effort)),
                                #("targetPercent", json.int(stage.target)),
                              ])
                            }),
                          ),
                        ),
                      ]),
                    ),
                  )
                  let result =
                    run_plan(
                      registry,
                      host,
                      cx,
                      stages,
                      max_turns,
                      minutes,
                      None,
                      [],
                      0,
                    )
                  let final = case result {
                    Ok(details) -> details
                    Error(message) ->
                      case json.parse(status_text(host), decode.dynamic) {
                        Ok(previous) ->
                          jsonx.object_with(previous, [
                            #("status", json.string("stopped")),
                            #("message", json.string(message)),
                          ])
                        Error(_) ->
                          json.object([
                            #("status", json.string("stopped")),
                            #("message", json.string(message)),
                          ])
                      }
                  }
                  update(host, json.to_string(final))
                  let final = case
                    json.parse(status_text(host), decode.dynamic)
                  {
                    Ok(previous) ->
                      jsonx.object_with(previous, [
                        #("endedAt", json.int(oauth.now())),
                      ])
                    Error(_) -> final
                  }
                  usage.record(host, "benchmarkFinished", [#("summary", final)])
                  finish(host, json.to_string(final))
                })
              {
                True -> Ok(Nil)
                False ->
                  Error(
                    "A benchmark is already running; only one may run across all hosts",
                  )
              }
          }
      }
    }
  }
}

fn run_plan(
  registry: hosts.Registry,
  host: String,
  cx: Codex,
  stages: List(Stage),
  max_turns: Int,
  minutes: Int,
  boundary: Option(#(Int, Int)),
  results: List(Json),
  spent: Int,
) -> Result(Json, String) {
  case stages {
    [] ->
      Ok(
        json.object([
          #("status", json.string("completed")),
          #("message", json.string("All benchmark combinations completed")),
          #("batchUsedPercent", json.int(spent)),
          #("results", json.preprocessed_array(results)),
        ]),
      )
    [stage, ..rest] -> {
      use _ <- result.try(check(registry, host, "", oauth.now() + minutes * 60))
      update(
        host,
        json.to_string(
          json.object([
            #("status", json.string("starting")),
            #("stageIndex", json.int(list.length(results) + 1)),
          ]),
        ),
      )
      use details <- result.try(run(
        registry,
        host,
        cx,
        stage.model,
        stage.effort,
        stage.target,
        max_turns,
        oauth.now() + minutes * 60,
        boundary,
      ))
      let assert Ok(data) = json.parse(json.to_string(details), decode.dynamic)
      let reached = jsonx.field_bool(data, ["targetReached"]) == Ok(True)
      let used = jsonx.field_int(data, ["usedPercent"]) |> result.unwrap(0)
      let finished =
        jsonx.object_with(data, [#("endedAt", json.int(oauth.now()))])
      let results = list.append(results, [finished])
      update(
        host,
        json.to_string(
          json.object([
            #(
              "status",
              json.string(case reached && rest != [] {
                True -> "settling"
                False ->
                  case reached {
                    True -> "completed"
                    False -> "stopped"
                  }
              }),
            ),
            #("batchUsedPercent", json.int(spent + used)),
            #("results", json.preprocessed_array(results)),
          ]),
        ),
      )
      usage.record(host, "benchmarkStageFinished", [#("summary", finished)])
      case reached {
        False ->
          Error(
            "Combination did not reach its target; remaining batch stages were not started",
          )
        True -> {
          let assert Ok(final_used) =
            jsonx.field_int(data, ["finalUsedPercent"])
          let assert Ok(reset) = jsonx.field_int(data, ["resetsAt"])
          run_plan(
            registry,
            host,
            cx,
            rest,
            max_turns,
            minutes,
            Some(#(final_used, reset)),
            results,
            spent + used,
          )
        }
      }
    }
  }
}

fn weekly(cx: Codex) -> Result(#(Int, Int), String) {
  use response <- result.try(codex.request(
    cx,
    "account/rateLimits/read",
    json.object([]),
  ))
  let windows =
    ["primary", "secondary"]
    |> list.filter_map(fn(key) { jsonx.field(response, ["rateLimits", key]) })
  use window <- result.try(
    list.find(windows, fn(window) {
      jsonx.field_int(window, ["windowDurationMins"]) == Ok(10_080)
    })
    |> result.replace_error("Weekly allowance is unavailable"),
  )
  use used <- result.try(
    jsonx.field_int(window, ["usedPercent"])
    |> result.replace_error("Weekly allowance reading is unavailable"),
  )
  use reset <- result.try(
    jsonx.field_int(window, ["resetsAt"])
    |> result.replace_error("Weekly reset is unavailable"),
  )
  Ok(#(used, reset))
}

fn check(
  registry: hosts.Registry,
  host: String,
  thread: String,
  deadline: Int,
) -> Result(Nil, String) {
  case cancelled(host), oauth.now() >= deadline {
    True, _ -> Error("Stopped by user")
    _, True -> Error("Time limit reached")
    _, _ ->
      case check_due() && busy(registry, thread) {
        True -> Error("Other Yacwu work started; benchmark stopped")
        False -> Ok(Nil)
      }
  }
}

fn run(
  registry: hosts.Registry,
  host: String,
  cx: Codex,
  model: String,
  effort: String,
  target: Int,
  max_turns: Int,
  deadline: Int,
  boundary: Option(#(Int, Int)),
) -> Result(Json, String) {
  update(
    host,
    json.to_string(
      json.object([
        #("status", json.string("settling")),
        #("model", json.string(model)),
        #("effort", json.string(effort)),
        #("startedAt", json.int(oauth.now())),
        #("deadlineAt", json.int(deadline)),
        #("phase", json.string("baseline")),
        #("turns", json.int(0)),
        #("threadId", json.null()),
        #("usedPercent", json.int(0)),
        #("settleElapsedSeconds", json.int(0)),
        #("stableSeconds", json.int(0)),
        #("targetReached", json.bool(False)),
        #("settled", json.bool(False)),
        #("targetPercent", json.int(target)),
        #("workloadVersion", json.int(2)),
        #(
          "message",
          json.string(
            "Sampling the baseline until readings are stable for 60 seconds",
          ),
        ),
      ]),
    ),
  )
  let _ =
    codex.request(
      cx,
      "account/read",
      json.object([#("refreshToken", json.bool(False))]),
    )
  use initial <- result.try(case boundary {
    Some(reading) -> {
      use current <- result.try(weekly(cx))
      case current == reading {
        True -> Ok(reading)
        False ->
          Error(
            "Allowance changed during the model handoff; batch stopped to avoid misattributing usage",
          )
      }
    }
    None -> {
      use first <- result.try(weekly(cx))
      sample_settle(registry, host, cx, "", deadline, first, first.0, 60)
    }
  })
  use _ <- result.try(case boundary {
    Some(_) -> Ok(Nil)
    None -> {
      let required = case json.parse(status_text(host), decode.dynamic) {
        Ok(data) ->
          jsonx.field_int(data, ["batchTargetPercent"]) |> result.unwrap(target)
        Error(_) -> target
      }
      case initial.0 + required <= 100 {
        True -> Ok(Nil)
        False -> Error("Not enough weekly allowance for the full batch target")
      }
    }
  })
  case initial.0 + target <= 100 {
    False -> Error("Not enough weekly allowance for the selected target")
    True -> {
      use created <- result.try(codex.request(
        cx,
        "thread/start",
        json.object([
          #("model", json.string(model)),
          #("approvalPolicy", json.string("never")),
          #("sandbox", json.string("read-only")),
          #(
            "developerInstructions",
            json.string(
              "This is a text-only usage benchmark. Never call tools, read files, write files, browse, or spawn agents. Answer only with generated text.",
            ),
          ),
        ]),
      ))
      use thread <- result.try(
        jsonx.field_string(created, ["thread", "id"])
        |> result.replace_error("No benchmark thread returned"),
      )
      hosts.record_threads(registry, host, [thread])
      let _ =
        codex.request(
          cx,
          "thread/name/set",
          json.object([
            #("threadId", json.string(thread)),
            #("name", json.string("Benchmark " <> model <> " / " <> effort)),
          ]),
        )
      usage.record(host, "benchmark", [
        #("threadId", json.string(thread)),
        #("model", json.string(model)),
        #("effort", json.string(effort)),
        #("workloadVersion", json.int(2)),
      ])
      usage.record(host, "benchmarkBoundary", [
        #("threadId", json.string(thread)),
        #("model", json.string(model)),
        #("effort", json.string(effort)),
        #("usedPercent", json.int(initial.0)),
        #("resetsAt", json.int(initial.1)),
      ])
      let subject = process.new_subject()
      codex.subscribe(cx, process.self(), subject)
      rounds(
        registry,
        host,
        cx,
        subject,
        thread,
        model,
        effort,
        initial,
        initial,
        target,
        max_turns,
        deadline,
        0,
      )
    }
  }
}

fn rounds(
  registry: hosts.Registry,
  host: String,
  cx: Codex,
  subject: process.Subject(String),
  thread: String,
  model: String,
  effort: String,
  initial: #(Int, Int),
  current: #(Int, Int),
  target: Int,
  max_turns: Int,
  deadline: Int,
  completed: Int,
) -> Result(Json, String) {
  use _ <- result.try(check(registry, host, thread, deadline))
  use _ <- result.try(case current.1 == initial.1 {
    True -> Ok(Nil)
    False -> Error("Weekly allowance reset; benchmark stopped")
  })
  let used = current.0 - initial.0
  let done = used >= target || completed >= max_turns
  let details =
    json.object([
      #(
        "status",
        json.string(case used >= target, done {
          True, _ -> "completed"
          _, True -> "stopped"
          _, _ -> "running"
        }),
      ),
      #("model", json.string(model)),
      #("effort", json.string(effort)),
      #("threadId", json.string(thread)),
      #("turns", json.int(completed)),
      #("usedPercent", json.int(used)),
      #("targetPercent", json.int(target)),
      #(
        "phase",
        json.string(case done {
          True -> "finished"
          False -> "workload"
        }),
      ),
      #("targetReached", json.bool(used >= target)),
      #("baselineUsedPercent", json.int(initial.0)),
      #("finalUsedPercent", json.int(current.0)),
      #("resetsAt", json.int(current.1)),
      #("settled", json.bool(done)),
      #(
        "message",
        json.string(case used >= target {
          True -> "Target reached"
          False ->
            case done {
              True ->
                "Turn limit reached before target; partial calibration only"
              False -> "Generating benchmark workload"
            }
        }),
      ),
    ])
  // Only the plan coordinator publishes a terminal status for the whole batch.
  let assert Ok(details_data) =
    json.parse(json.to_string(details), decode.dynamic)
  update(
    host,
    json.to_string(
      jsonx.object_with(details_data, [
        #(
          "status",
          json.string(case done {
            True -> "settling"
            False -> "running"
          }),
        ),
      ]),
    ),
  )
  case current.1 != initial.1 {
    True -> Error("Weekly allowance reset; benchmark stopped")
    False ->
      case done {
        True -> {
          usage.record(host, "benchmarkBoundaryEnd", [
            #("threadId", json.string(thread)),
            #("usedPercent", json.int(current.0)),
            #("resetsAt", json.int(current.1)),
          ])
          Ok(details)
        }
        False -> {
          let prompt = workload(completed)
          use reply <- result.try(codex.request(
            cx,
            "turn/start",
            json.object([
              #("threadId", json.string(thread)),
              #("model", json.string(model)),
              #("effort", json.string(effort)),
              #("approvalPolicy", json.string("never")),
              #(
                "sandboxPolicy",
                json.object([#("type", json.string("readOnly"))]),
              ),
              #(
                "input",
                json.preprocessed_array([
                  json.object([
                    #("type", json.string("text")),
                    #("text", json.string(prompt)),
                  ]),
                ]),
              ),
            ]),
          ))
          use turn <- result.try(
            jsonx.field_string(reply, ["turn", "id"])
            |> result.replace_error("No benchmark turn returned"),
          )
          case wait_turn(registry, host, subject, thread, turn, deadline) {
            Error(message) -> {
              let _ =
                codex.request(
                  cx,
                  "turn/interrupt",
                  json.object([
                    #("threadId", json.string(thread)),
                    #("turnId", json.string(turn)),
                  ]),
                )
              Error(message)
            }
            Ok(_) -> {
              update(
                host,
                json.to_string(
                  json.object([
                    #("status", json.string("settling")),
                    #("threadId", json.string(thread)),
                    #("turns", json.int(completed + 1)),
                    #("usedPercent", json.int(used)),
                    #("targetPercent", json.int(target)),
                    #("phase", json.string("post-turn")),
                    #(
                      "message",
                      json.string(
                        "Sampling allowance after the turn until readings stabilize",
                      ),
                    ),
                  ]),
                ),
              )
              use settled <- result.try(sample_settle(
                registry,
                host,
                cx,
                thread,
                deadline,
                initial,
                current.0,
                90,
              ))
              rounds(
                registry,
                host,
                cx,
                subject,
                thread,
                model,
                effort,
                initial,
                settled,
                target,
                max_turns,
                deadline,
                completed + 1,
              )
            }
          }
        }
      }
  }
}

fn wait_turn(
  registry: hosts.Registry,
  host: String,
  subject: process.Subject(String),
  thread: String,
  turn: String,
  deadline: Int,
) -> Result(Nil, String) {
  use _ <- result.try(check(registry, host, thread, deadline))
  case process.receive(subject, 1000) {
    Error(_) -> wait_turn(registry, host, subject, thread, turn, deadline)
    Ok(line) -> {
      let message = json.parse(line, decode.dynamic)
      case message {
        Ok(data) ->
          case
            jsonx.field_string(data, ["method"]) == Ok("turn/completed")
            && jsonx.field_string(data, ["params", "threadId"]) == Ok(thread)
            && jsonx.field_string(data, ["params", "turn", "id"]) == Ok(turn)
          {
            True ->
              case jsonx.field_string(data, ["params", "turn", "status"]) {
                Ok("completed") -> Ok(Nil)
                _ -> Error("Benchmark turn failed or was interrupted")
              }
            False -> wait_turn(registry, host, subject, thread, turn, deadline)
          }
        Error(_) -> wait_turn(registry, host, subject, thread, turn, deadline)
      }
    }
  }
}

fn sample_settle(
  registry: hosts.Registry,
  host: String,
  cx: Codex,
  thread: String,
  deadline: Int,
  reference: #(Int, Int),
  previous_used: Int,
  minimum: Int,
) -> Result(#(Int, Int), String) {
  use _ <- result.try(check(registry, host, thread, deadline))
  use first <- result.try(weekly(cx))
  case first.1 != reference.1 {
    True -> Error("Weekly allowance reset; benchmark stopped")
    False ->
      sample_until_stable(
        registry,
        host,
        cx,
        thread,
        deadline,
        reference,
        benchmark_settling.start(
          oauth.now(),
          int.max(first.0, previous_used),
          first.1,
        ),
        minimum,
      )
  }
}

fn sample_until_stable(
  registry: hosts.Registry,
  host: String,
  cx: Codex,
  thread: String,
  deadline: Int,
  reference: #(Int, Int),
  reading: benchmark_settling.Reading,
  minimum: Int,
) -> Result(#(Int, Int), String) {
  use _ <- result.try(check(registry, host, thread, deadline))
  use current <- result.try(weekly(cx))
  let now = oauth.now()
  use next <- result.try(benchmark_settling.observe(
    reading,
    now,
    current.0,
    current.1,
  ))
  let stable = benchmark_settling.ready(next, now, minimum)
  let fields = [
    #(
      "usedPercent",
      json.int(case thread {
        "" -> 0
        _ -> int.max(0, current.0 - reference.0)
      }),
    ),
    #("sampledUsedPercent", json.int(current.0)),
    #("sampledAt", json.int(now)),
    #("settleElapsedSeconds", json.int(now - next.started)),
    #("stableSeconds", json.int(now - next.changed)),
    #("settled", json.bool(stable)),
  ]
  update(host, json.to_string(json.object(fields)))
  usage.record(host, "benchmarkSample", [
    #("threadId", json.string(thread)),
    ..fields
  ])
  case stable, now - next.started >= 300 {
    True, _ -> Ok(current)
    _, True ->
      Error(
        "Allowance readings did not stabilize within 5 minutes; no further workload started",
      )
    _, _ -> {
      use _ <- result.try(settle(registry, host, thread, deadline, 10))
      sample_until_stable(
        registry,
        host,
        cx,
        thread,
        deadline,
        reference,
        next,
        minimum,
      )
    }
  }
}

fn settle(
  registry: hosts.Registry,
  host: String,
  thread: String,
  deadline: Int,
  seconds: Int,
) -> Result(Nil, String) {
  use _ <- result.try(check(registry, host, thread, deadline))
  case seconds <= 0 {
    True -> Ok(Nil)
    False -> {
      process.sleep(1000)
      settle(registry, host, thread, deadline, seconds - 1)
    }
  }
}

fn workload(round: Int) -> String {
  let common =
    "Text-only benchmark, round "
    <> int.to_string(round + 1)
    <> ". Do not use tools or access files. Use declarative statements; do not ask user questions or use question marks. "
  common
  <> case round % 3 {
    0 ->
      "Produce a self-contained 1800-word technical explanation of a deterministic scheduling system. Use tasks A(duration 3), B(duration 5, depends on A), C(duration 2, depends on A), D(duration 4, depends on B and C), two workers, and alphabetical tie-breaking. Include a worked example, invariants and tradeoffs."
    1 ->
      "Write a 600-word specification for a bounded FIFO job queue with capacity 8, two workers, at most two retries per job, and idempotent job identifiers. Derive 30 detailed edge cases with expected outcomes, covering cancellation, duplicate submissions, retries and shutdown. Explain the reasoning in text. This specification must stand on its own."
    _ ->
      "Analyze a scheduler with tasks A(duration 3), B(duration 5, depends on A), C(duration 2, depends on A), D(duration 4, depends on B and C). Derive completion times and invariants with one and two workers, alphabetical tie-breaking, and a single failure in each task. Provide worked timelines and pseudocode, then analyze complexity and 20 boundary cases in about 2200 words."
  }
}
