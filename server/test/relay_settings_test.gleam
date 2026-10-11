import gleam/int
import gleeunit/should
import simplifile
import yacwu/relay_core
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

pub fn undelivered_messages_round_trip_test() {
  let path =
    "/tmp/yacwu-relay-queue-"
    <> int.to_string(int.absolute_value(unique()))
    <> "/relay-queue.json"
  relay_settings.load_open(path) |> should.equal([])
  let message = fn(id, state) {
    relay_core.Message(
      id: id,
      from: relay_core.Address("local", "thr-a"),
      to: relay_core.Address("claude", "thr-b"),
      text: "hello\nthere",
      fingerprint: "f-" <> id,
      created_at: 1000,
      state: state,
      reason: "",
      submission: "",
      turn: "",
      generation: 0,
      provider: relay_core.ClaudeAdapter,
      version: 0,
    )
  }
  let saved = [
    message("m1", relay_core.Reserved),
    message("m2", relay_core.Queued),
  ]
  relay_settings.save_open(path, saved)
  relay_settings.load_open(path) |> should.equal(saved)
  relay_settings.save_open(path, [])
  relay_settings.load_open(path) |> should.equal([])
  let assert Ok(_) = simplifile.write(path, "not json")
  relay_settings.load_open(path) |> should.equal([])
}
