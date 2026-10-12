import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleeunit/should
import yacwu/task_recovery

fn read(text: String) {
  let assert Ok(value) = json.parse(text, decode.dynamic)
  value
}

/// Turns running when the host disconnected are handed out once, by host;
/// finished turns and other hosts are not.
pub fn disconnect_hands_out_running_turns_test() {
  let tracker =
    task_recovery.new()
    |> task_recovery.turn_started("claude", "a", "t1")
    |> task_recovery.turn_started("claude", "b", "t2")
    |> task_recovery.turn_completed("claude", "b")
    |> task_recovery.turn_started("local", "c", "t3")
    |> task_recovery.disconnected("claude")
  let #(tracker, orphans) = task_recovery.take_orphans(tracker, "claude")
  orphans |> should.equal([#("a", "t1")])
  task_recovery.take_orphans(tracker, "claude").1 |> should.equal([])
  // A turn that starts again before the check is no longer in question.
  let #(_, orphans) =
    task_recovery.new()
    |> task_recovery.turn_started("claude", "a", "t1")
    |> task_recovery.disconnected("claude")
    |> task_recovery.turn_started("claude", "a", "t9")
    |> task_recovery.take_orphans("claude")
  orphans |> should.equal([])
}

pub fn repeated_crashes_stop_being_continued_test() {
  let #(tracker, first) =
    task_recovery.allow_attempt(task_recovery.new(), "a", 1000)
  let #(tracker, second) = task_recovery.allow_attempt(tracker, "a", 1100)
  let #(tracker, third) = task_recovery.allow_attempt(tracker, "a", 1200)
  #(first, second, third) |> should.equal(#(True, True, False))
  // Later, outside the window, it may be continued again.
  task_recovery.allow_attempt(
    tracker,
    "a",
    1200 + task_recovery.attempt_window_seconds,
  ).1
  |> should.be_true
}

pub fn only_a_cut_off_latest_turn_is_continued_test() {
  let thread = fn(status, turn_status, extra) {
    read(
      "{\"thread\":{\"status\":{\"type\":\""
      <> status
      <> "\"},"
      <> extra
      <> "\"turns\":[{\"id\":\"t0\",\"status\":\"completed\"},{\"id\":\"t1\",\"status\":\""
      <> turn_status
      <> "\"}]}}",
    )
  }
  task_recovery.cut_off(thread("notLoaded", "inProgress", ""), "t1")
  |> should.be_true
  task_recovery.cut_off(thread("idle", "interrupted", ""), "t1")
  |> should.be_true
  task_recovery.cut_off(thread("idle", "failed", ""), "t1") |> should.be_true
  // Still running, finished normally, or a later turn: leave it.
  task_recovery.cut_off(thread("active", "inProgress", ""), "t1")
  |> should.be_false
  task_recovery.cut_off(thread("idle", "completed", ""), "t1")
  |> should.be_false
  task_recovery.cut_off(thread("notLoaded", "inProgress", ""), "t0")
  |> should.be_false
  // Agents are continued by the session that spawned them.
  task_recovery.cut_off(
    thread("notLoaded", "inProgress", "\"agentRole\":\"worker\","),
    "t1",
  )
  |> should.be_false
}

pub fn saved_turns_are_all_checked_after_a_restart_test() {
  let tracker =
    task_recovery.new()
    |> task_recovery.turn_started("claude", "a", "t1")
    |> task_recovery.turn_started("local", "b", "t2")
    |> task_recovery.disconnected("local")
  let restored = task_recovery.decode_saved(task_recovery.encode(tracker))
  task_recovery.take_orphans(restored, "claude").1
  |> should.equal([#("a", "t1")])
  task_recovery.take_orphans(restored, "local").1
  |> list.length
  |> should.equal(1)
  task_recovery.decode_saved("not json") |> should.equal(task_recovery.new())
}
