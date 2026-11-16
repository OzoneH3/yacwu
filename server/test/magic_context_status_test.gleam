import gleam/dynamic/decode
import gleam/json
import gleeunit/should
import yacwu/router

pub fn magic_context_status_wraps_the_plugin_payload_test() {
  let assert Ok(payload) =
    json.parse("{\"usagePercentage\":13,\"inputTokens\":5}", decode.dynamic)
  let encoded = router.magic_context_status_body(payload) |> json.to_string
  let assert Ok(percent) =
    json.parse(encoded, decode.at(["status", "usagePercentage"], decode.int))
  let assert Ok(tokens) =
    json.parse(encoded, decode.at(["status", "inputTokens"], decode.int))
  percent |> should.equal(13)
  tokens |> should.equal(5)
}
