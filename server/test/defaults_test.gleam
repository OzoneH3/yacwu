import gleeunit/should
import yacwu/defaults

pub fn new_sessions_use_explicit_luna_test() {
  defaults.new_session_model |> should.equal("gpt-6-luna")
  defaults.new_copilot_session_model |> should.equal("copilot/gpt-6-luna")
}
