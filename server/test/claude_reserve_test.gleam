import gleam/dynamic/decode
import gleam/json
import gleam/option.{Some}
import gleeunit/should
import yacwu/claude_reserve

pub fn validates_shared_reserve_test() {
  let assert Ok(data) = json.parse("{\"reserve\":8}", decode.dynamic)
  claude_reserve.parse(data) |> should.equal(Ok(8))
  let assert Ok(invalid) = json.parse("{\"reserve\":51}", decode.dynamic)
  claude_reserve.parse(invalid) |> should.be_error
  let assert Ok(decoded) =
    json.parse(json.to_string(claude_reserve.encode(Some(0))), decode.dynamic)
  claude_reserve.parse(decoded) |> should.equal(Ok(0))
}
