//// Use the rest of a week's Codex allowance before an announced global
//// reset wipes it: while a reset is announced and has not landed, nothing
//// else runs and enough allowance is left, benchmark the model and thinking
//// combinations Yacwu has not measured yet, most costly first. The week's
//// leftover allowance would be lost anyway; the measurements are not.
////
//// YACWU_RESET_BENCHMARK=off turns it off.

import envoy
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/regexp
import gleam/result
import gleam/string
import yacwu/reset_feed.{type Entry}

/// Only with at least this much of the week left (percent).
pub const min_remaining = 10

/// Combinations per run; later checks continue with the rest.
pub const max_stages = 6

pub fn enabled() -> Bool {
  envoy.get("YACWU_RESET_BENCHMARK") != Ok("off")
}

@external(erlang, "yacwu_time", "rfc3339_seconds")
fn seconds(text: String) -> Result(Int, Nil)

fn matches(pattern: String, text: String) -> Bool {
  case
    regexp.compile(
      pattern,
      regexp.Options(case_insensitive: True, multi_line: False),
    )
  {
    Ok(re) -> regexp.check(re, text)
    Error(_) -> False
  }
}

/// The announcement of a reset still to come, as the page judges it: a
/// reset preview that talks about a reset and not about one being done,
/// under a day old, after the latest landed reset and after the current week
/// began (a reset announced before then has landed).
pub fn pending(
  entries: List(Entry),
  now: Int,
  week_started: Int,
) -> Result(Entry, Nil) {
  let dated =
    list.filter_map(entries, fn(entry) {
      seconds(entry.at) |> result.map(fn(at) { #(entry, at) })
    })
  let landed =
    dated
    |> list.filter(fn(item) { { item.0 }.kind == "reset" })
    |> list.map(fn(item) { item.1 })
    |> list.fold(0, int.max)
  dated
  |> list.filter(fn(item) {
    let #(entry, at) = item
    entry.kind == "reset_preview"
    && matches("\\breset\\b", entry.text)
    && !matches(
      "\\b(it'?s done|done\\b|landed|propagated|in the bag|is live|went live)",
      entry.text,
    )
    && at > landed
    && at > week_started
    && now - at < 86_400
  })
  |> list.sort(fn(a, b) { int.compare(b.1, a.1) })
  |> list.first
  |> result.map(fn(item) { item.0 })
}

fn effort_rank(effort: String) -> Int {
  case effort {
    "ultra" -> 7
    "max" -> 6
    "xhigh" -> 5
    "high" -> 4
    "medium" -> 3
    "low" -> 2
    "minimal" -> 1
    _ -> 0
  }
}

/// Combinations not measured yet, most costly first: models in catalog
/// order (the flagship first), each from its highest thinking level down.
pub fn plan(
  catalog: List(#(String, List(String))),
  measured: List(#(String, String)),
) -> List(#(String, String)) {
  catalog
  |> list.flat_map(fn(model) {
    model.1
    |> list.sort(fn(a, b) { int.compare(effort_rank(b), effort_rank(a)) })
    |> list.map(fn(effort) { #(model.0, effort) })
  })
  |> list.filter(fn(combination) { !list.contains(measured, combination) })
  |> list.take(max_stages)
}

/// Combinations with a completed benchmark stage in a host's journal.
pub fn measured(journal: String) -> List(#(String, String)) {
  let events =
    string.split(journal, "\n")
    |> list.filter_map(fn(line) {
      json.parse(line, {
        use event <- decode.field("event", decode.string)
        use thread <- decode.optional_field("threadId", "", decode.string)
        use model <- decode.optional_field("model", "", decode.string)
        use effort <- decode.optional_field("effort", "", decode.string)
        decode.success(#(event, thread, model, effort))
      })
    })
  let ended =
    events
    |> list.filter(fn(event) { event.0 == "benchmarkBoundaryEnd" })
    |> list.map(fn(event) { event.1 })
  events
  |> list.filter(fn(event) {
    event.0 == "benchmarkBoundary" && list.contains(ended, event.1)
  })
  |> list.map(fn(event) { #(event.2, event.3) })
  |> list.unique
}
