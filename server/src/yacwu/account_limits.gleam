//// Server-wide account usage stops. Zero disables a provider's limit.

import envoy
import filepath
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import simplifile
import yacwu/jsonx

pub type Limits {
  Limits(codex_reserve_percent: Int, copilot_credit_limit: Int)
}

pub fn defaults() -> Limits {
  Limits(0, 0)
}

pub fn parse(data: Dynamic) -> Result(Limits, String) {
  case
    jsonx.field_int(data, ["codexReservePercent"]),
    jsonx.field_int(data, ["copilotCreditLimit"])
  {
    Ok(percent), Ok(credits)
      if percent >= 0
      && percent <= 100
      && credits >= 0
      && credits <= 1_000_000_000
    -> Ok(Limits(percent, credits))
    _, _ ->
      Error(
        "Codex reserve must be 0–100%; Copilot credits must be 0–1,000,000,000. Both must be whole numbers.",
      )
  }
}

pub fn encode(limits: Limits) -> Json {
  json.object([
    #("codexReservePercent", json.int(limits.codex_reserve_percent)),
    #("copilotCreditLimit", json.int(limits.copilot_credit_limit)),
  ])
}

pub fn path() -> String {
  let root =
    envoy.get("XDG_STATE_HOME")
    |> result.unwrap(filepath.join(
      envoy.get("HOME") |> result.unwrap("."),
      ".local/state",
    ))
  filepath.join(root, "yacwu/account-limits.json")
}

pub fn load(path: String) -> Limits {
  simplifile.read(path)
  |> result.replace_error("")
  |> result.try(fn(text) {
    json.parse(text, decode.dynamic) |> result.replace_error("")
  })
  |> result.try(parse)
  |> result.unwrap(defaults())
}

@external(erlang, "erlang", "unique_integer")
fn unique() -> Int

pub fn save(path: String, limits: Limits) -> Result(Nil, String) {
  let temp = path <> "." <> int.to_string(unique())
  let _ = simplifile.create_directory_all(filepath.directory_name(path))
  let result =
    simplifile.write(temp, json.to_string(encode(limits)))
    |> result.try(fn(_) { simplifile.rename(temp, path) })
    |> result.replace_error("Could not save account usage limits")
  let _ = simplifile.delete(temp)
  result
}

pub fn enabled(limits: Limits, provider: String) -> Bool {
  case provider {
    "codex" -> limits.codex_reserve_percent > 0
    "copilot" -> limits.copilot_credit_limit > 0
    _ -> False
  }
}

fn number(data: Dynamic, path: List(String)) -> Result(Float, Nil) {
  decode.run(
    data,
    decode.at(
      path,
      decode.one_of(decode.float, [decode.map(decode.int, int.to_float)]),
    ),
  )
  |> result.replace_error(Nil)
}

/// Only verified recent account readings can authorize more work. Context usage
/// and estimated task credits never stand in for account consumption.
pub fn reason(
  limits: Limits,
  provider: String,
  data: Dynamic,
  observed_at: Int,
  now: Int,
) -> Option(String) {
  let credit_limit = int.to_float(limits.copilot_credit_limit)
  let unknown =
    Some(
      "Account usage cannot be verified. Work is blocked while the configured "
      <> provider
      <> " account limit is enabled.",
    )
  case enabled(limits, provider), now - observed_at > 300 {
    False, _ -> None
    True, True -> unknown
    True, False ->
      case provider {
        "copilot" ->
          case number(data, ["rateLimits", "copilotUsage", "used"]) {
            Ok(used) if used >=. credit_limit ->
              Some(
                "Copilot account credit limit reached ("
                <> int.to_string(limits.copilot_credit_limit)
                <> " credits used this billing cycle).",
              )
            Ok(used) if used >=. 0.0 -> None
            _ -> unknown
          }
        _ -> {
          let windows =
            ["primary", "secondary"]
            |> list.filter_map(fn(key) {
              let reset =
                jsonx.field_int(data, ["rateLimits", key, "resetsAt"])
                |> result.unwrap(now + 1)
              case number(data, ["rateLimits", key, "usedPercent"]) {
                Ok(used) if used >=. 0.0 && reset > now -> Ok(used)
                _ -> Error(Nil)
              }
            })
          case windows {
            [] -> unknown
            _ ->
              case
                list.any(windows, fn(used) {
                  used >=. int.to_float(100 - limits.codex_reserve_percent)
                })
              {
                True ->
                  Some(
                    "Codex allowance reserve reached ("
                    <> int.to_string(limits.codex_reserve_percent)
                    <> "% remaining).",
                  )
                False -> None
              }
          }
        }
      }
  }
}
