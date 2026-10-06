//// Explicit, bounded, text-only calibration runs. Never runs on application launch.

import gleam/dynamic/decode
import gleam/erlang/process
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/result
import yacwu/codex.{type Codex}
import yacwu/hosts
import yacwu/jsonx
import yacwu/model_state
import yacwu/oauth
import yacwu/usage

@external(erlang, "yacwu_benchmark", "launch")
fn launch(host: String, worker: fn() -> Nil) -> Bool

@external(erlang, "yacwu_benchmark", "update")
fn update(host: String, status: String) -> Nil

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
  case
    target >= 1
    && target <= 5
    && max_turns >= 1
    && max_turns <= 100
    && minutes >= 1
    && minutes <= 60
  {
    False -> Error("Choose a 1–5% target, 1–100 turns and 1–60 minutes")
    True -> {
      use catalog <- result.try(model_state.list_model_choices(cx))
      case
        list.any(catalog.models, fn(choice) {
          choice.id == model && list.contains(choice.efforts, effort)
        })
      {
        False -> Error("Choose an available model and supported thinking level")
        True ->
          case busy(registry, "") {
            True -> Error("Pause other Yacwu tasks before starting a benchmark")
            False ->
              case
                launch(host, fn() {
                  let result =
                    run(
                      registry,
                      host,
                      cx,
                      model,
                      effort,
                      target,
                      max_turns,
                      oauth.now() + minutes * 60,
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
                  usage.record(host, "benchmarkFinished", [#("summary", final)])
                  finish(host, json.to_string(final))
                })
              {
                True -> Ok(Nil)
                False -> Error("A benchmark is already running on this host")
              }
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
) -> Result(Json, String) {
  update(
    host,
    json.to_string(
      json.object([
        #("status", json.string("settling")),
        #("model", json.string(model)),
        #("effort", json.string(effort)),
        #(
          "message",
          json.string("Waiting 60 seconds for the baseline allowance to settle"),
        ),
      ]),
    ),
  )
  use _ <- result.try(settle(registry, host, "", deadline, 60))
  let _ =
    codex.request(
      cx,
      "account/read",
      json.object([#("refreshToken", json.bool(False))]),
    )
  use initial <- result.try(weekly(cx))
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
  target: Int,
  max_turns: Int,
  deadline: Int,
  completed: Int,
) -> Result(Json, String) {
  use _ <- result.try(check(registry, host, thread, deadline))
  use current <- result.try(weekly(cx))
  let used = current.0 - initial.0
  let done = used >= target || completed >= max_turns
  let details =
    json.object([
      #(
        "status",
        json.string(case done {
          True -> "completed"
          False -> "running"
        }),
      ),
      #("model", json.string(model)),
      #("effort", json.string(effort)),
      #("threadId", json.string(thread)),
      #("turns", json.int(completed)),
      #("usedPercent", json.int(used)),
      #("targetPercent", json.int(target)),
      #(
        "message",
        json.string(case used >= target {
          True -> "Target reached"
          False ->
            case done {
              True -> "Turn limit reached"
              False -> "Generating benchmark workload"
            }
        }),
      ),
    ])
  update(host, json.to_string(details))
  case current.1 != initial.1 {
    True -> Error("Weekly allowance reset; benchmark stopped")
    False ->
      case done {
        True -> Ok(details)
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
                    #(
                      "message",
                      json.string("Waiting 90 seconds for allowance readings"),
                    ),
                  ]),
                ),
              )
              use _ <- result.try(settle(registry, host, thread, deadline, 90))
              rounds(
                registry,
                host,
                cx,
                subject,
                thread,
                model,
                effort,
                initial,
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
      "Produce a self-contained 1800-word technical explanation of a fictional deterministic scheduling system. Include a worked example, invariants and tradeoffs; invent fresh task names and numbers."
    1 ->
      "Rework the preceding explanation into a 600-word specification and derive 30 detailed edge cases with expected outcomes. Explain the reasoning in text."
    _ ->
      "Generate 50 distinct mathematical scheduling puzzles with fully worked short solutions. Keep the answer around 2200 words and avoid repeating the preceding cases."
  }
}
