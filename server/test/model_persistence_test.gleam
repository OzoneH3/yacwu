import envoy
import filepath
import gleam/erlang/process
import gleam/int
import gleam/option.{Some}
import gleam/result
import gleeunit/should
import simplifile
import yacwu/model_state

fn test_path() -> String {
  filepath.join(
    envoy.get("TMPDIR") |> result.unwrap("."),
    "model-selection-" <> int.to_string(int.random(1_000_000_000)) <> ".json",
  )
}

pub fn selections_survive_a_fresh_store_test() {
  let path = test_path()
  let first = process.new_name("model_first")
  let assert Ok(_) = model_state.start(first, Some(path))
  let chosen = model_state.Settings("opus", "high")
  model_state.set_override(first, "research", chosen) |> should.equal(Ok(Nil))
  let restored = process.new_name("model_restored")
  let assert Ok(_) = model_state.start(restored, Some(path))
  model_state.get_override(restored, "research") |> should.equal(Ok(chosen))
  model_state.get_override(restored, "other") |> should.equal(Error(Nil))
  let _ = simplifile.delete(path)
}

pub fn failed_save_keeps_previous_selection_test() {
  let path = test_path()
  let name = process.new_name("model_write_failure")
  let assert Ok(_) = model_state.start(name, Some(path))
  let chosen = model_state.Settings("opus", "medium")
  model_state.set_override(name, "research", chosen) |> should.equal(Ok(Nil))
  let assert Ok(_) = simplifile.delete(path)
  let assert Ok(_) = simplifile.create_directory(path)
  model_state.set_override(
    name,
    "research",
    model_state.Settings("fable", "high"),
  )
  |> should.be_error
  model_state.get_override(name, "research") |> should.equal(Ok(chosen))
  let _ = simplifile.delete(path)
}

pub fn new_turns_use_saved_choice_and_steers_leave_model_unchanged_test() {
  let name = process.new_name("model_turn_settings")
  let assert Ok(_) = model_state.start(name, option.None)
  let chosen = model_state.Settings("opus", "high")
  model_state.set_override(name, "research", chosen) |> should.equal(Ok(Nil))
  let unavailable = fn() { Error("must not query backend") }
  model_state.turn_settings(name, "research", False, unavailable)
  |> should.equal(Ok(chosen))
  model_state.turn_settings(name, "research", True, unavailable)
  |> should.equal(Ok(model_state.Settings("", "")))
  let fallback = model_state.Settings("sonnet", "medium")
  model_state.turn_settings(name, "other", False, fn() { Ok(fallback) })
  |> should.equal(Ok(fallback))
  model_state.turn_settings(name, "other", False, unavailable)
  |> should.equal(Error("must not query backend"))
}

pub fn invalid_saved_settings_do_not_silently_reset_selection_test() {
  let path = test_path()
  let assert Ok(_) = simplifile.write(path, "{broken")
  model_state.start(process.new_name("model_corrupt"), Some(path))
  |> should.be_error
  let _ = simplifile.delete(path)
}
