import gleam/int
import gleeunit/should
import simplifile
import yacwu/relay_settings

@external(erlang, "erlang", "unique_integer")
fn unique() -> Int

pub fn default_is_accept_and_choice_round_trips_test() {
  let path =
    "/tmp/yacwu-relay-settings-"
    <> int.to_string(int.absolute_value(unique()))
    <> "/nested/relay-settings.json"
  relay_settings.load(path) |> should.be_true
  relay_settings.save(path, False)
  relay_settings.load(path) |> should.be_false
  relay_settings.save(path, True)
  relay_settings.load(path) |> should.be_true
  let assert Ok(_) = simplifile.write(path, "not json")
  relay_settings.load(path) |> should.be_true
}
