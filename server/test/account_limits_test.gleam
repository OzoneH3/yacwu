import gleam/dynamic
import gleam/dynamic/decode
import gleam/json
import gleam/option.{None}
import gleeunit/should
import yacwu/account_limits

fn data(text) {
  let assert Ok(value) = json.parse(text, decode.dynamic)
  value
}

pub fn settings_validation_test() {
  account_limits.defaults() |> should.equal(account_limits.Limits(0, 0))
  account_limits.parse(data(
    "{\"codexReservePercent\":15,\"copilotCreditLimit\":2000}",
  ))
  |> should.equal(Ok(account_limits.Limits(15, 2000)))
  account_limits.parse(data(
    "{\"codexReservePercent\":101,\"copilotCreditLimit\":2000}",
  ))
  |> should.be_error
  account_limits.parse(data(
    "{\"codexReservePercent\":0,\"copilotCreditLimit\":-1}",
  ))
  |> should.be_error
}

pub fn account_usage_thresholds_test() {
  let limits = account_limits.Limits(10, 2000)
  let usage =
    data(
      "{\"rateLimits\":{\"primary\":{\"usedPercent\":89},\"secondary\":{\"usedPercent\":90,\"resetsAt\":2000}}}",
    )
  account_limits.reason(limits, "codex", usage, 1000, 1000)
  |> should.not_equal(None)
  account_limits.reason(account_limits.defaults(), "codex", usage, 1000, 1000)
  |> should.equal(None)
  account_limits.reason(limits, "claude", usage, 1000, 1000)
  |> should.equal(None)
  account_limits.reason(
    limits,
    "codex",
    data("{\"rateLimits\":{\"primary\":{\"usedPercent\":89}}}"),
    1000,
    1000,
  )
  |> should.equal(None)
  account_limits.reason(limits, "codex", dynamic.nil(), 0, 1000)
  |> should.not_equal(None)
  let credits = data("{\"rateLimits\":{\"copilotUsage\":{\"used\":1999}}}")
  account_limits.reason(limits, "copilot", credits, 1000, 1000)
  |> should.equal(None)
  account_limits.reason(limits, "copilot", credits, 1000, 1400)
  |> should.not_equal(None)
  account_limits.reason(
    limits,
    "copilot",
    data("{\"rateLimits\":{\"copilotUsage\":{\"used\":2000}}}"),
    1000,
    1000,
  )
  |> should.not_equal(None)
  account_limits.reason(
    limits,
    "copilot",
    data("{\"rateLimits\":{\"copilotUsage\":null}}"),
    1000,
    1000,
  )
  |> should.not_equal(None)
}

pub fn preserved_quota_still_expires_and_blocks_at_reserve_test() {
  let limits = account_limits.Limits(5, 0)
  let below = data("{\"rateLimits\":{\"primary\":{\"usedPercent\":7}}}")
  account_limits.reason(limits, "codex", below, 1000, 1300)
  |> should.equal(None)
  account_limits.reason(limits, "codex", below, 1000, 1301)
  |> should.not_equal(None)
  let reached = data("{\"rateLimits\":{\"primary\":{\"usedPercent\":95}}}")
  account_limits.reason(limits, "codex", reached, 1000, 1000)
  |> should.not_equal(None)
}
