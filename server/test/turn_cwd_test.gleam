import gleam/option.{None, Some}
import gleeunit/should
import yacwu/router

fn check(raw: String) -> Result(String, String) {
  case raw {
    "/missing" -> Error("Directory does not exist: /missing")
    _ -> Ok("/resolved" <> raw)
  }
}

pub fn new_turn_carries_a_checked_folder_test() {
  router.turn_cwd(None, Some(" /work "), check)
  |> should.equal(Ok(Some("/resolved/work")))
}

pub fn invalid_folder_rejects_the_message_test() {
  router.turn_cwd(None, Some("/missing"), check)
  |> should.equal(Error("Directory does not exist: /missing"))
}

pub fn steer_and_blank_folders_change_nothing_test() {
  router.turn_cwd(Some("turn-1"), Some("/missing"), check)
  |> should.equal(Ok(None))
  router.turn_cwd(None, Some("  "), check) |> should.equal(Ok(None))
  router.turn_cwd(None, None, check) |> should.equal(Ok(None))
}
