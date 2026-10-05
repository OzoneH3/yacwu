import gleam/dict
import gleam/dynamic/decode
import gleam/erlang/process
import gleam/json
import gleam/string
import gleeunit/should
import simplifile
import yacwu/codex
import yacwu/diagnostics
import yacwu/jsonx

fn parsed(text: String) {
  let assert Ok(value) = json.parse(text, decode.dynamic)
  value
}

pub fn silence_tracks_events_and_completion_test() {
  let started =
    parsed(
      "{\"method\":\"turn/started\",\"params\":{\"threadId\":\"thread\",\"turn\":{\"id\":\"turn\"}}}",
    )
  let tracker = diagnostics.observe(dict.new(), started, 100)
  should.equal(diagnostics.is_silent(tracker, 219), False)
  should.equal(diagnostics.is_silent(tracker, 220), True)
  let delta =
    parsed(
      "{\"method\":\"item/agentMessage/delta\",\"params\":{\"threadId\":\"thread\",\"delta\":\"private output\"}}",
    )
  let tracker = diagnostics.observe(tracker, delta, 215)
  should.equal(diagnostics.is_silent(tracker, 220), False)
  let summary = diagnostics.snapshot(tracker, 220) |> json.to_string
  should.equal(string.contains(summary, "private output"), False)
  should.equal(string.contains(summary, "item/agentMessage/delta"), True)
  let completed =
    parsed(
      "{\"method\":\"turn/completed\",\"params\":{\"threadId\":\"thread\"}}",
    )
  should.equal(diagnostics.observe(tracker, completed, 230), dict.new())
}

pub fn reads_do_not_reset_silence_timer_test() {
  let reply =
    parsed(
      "{\"thread\":{\"id\":\"thread\",\"status\":{\"type\":\"active\"},\"turns\":[{\"id\":\"turn\",\"status\":\"inProgress\"}]}}",
    )
  let tracker = diagnostics.restore(dict.new(), reply, 100)
  let tracker = diagnostics.restore(tracker, reply, 219)
  should.equal(diagnostics.is_silent(tracker, 220), True)
  let assert Ok(activity) = dict.get(tracker, "thread")
  should.equal(activity.turn, "turn")
  let idle =
    parsed("{\"thread\":{\"id\":\"thread\",\"status\":{\"type\":\"idle\"}}}")
  should.equal(diagnostics.restore(tracker, idle, 230), dict.new())
}

const stub = [
  "bash",
  "-c",
  "
echo diagnostic-stderr-marker >&2
while IFS= read -r line; do
  case \"$line\" in
    *test/stall*) continue ;;
    *test/die*) exit 0 ;;
  esac
  id=$(printf '%s' \"$line\" | sed -n 's/.*\\\"id\\\":\\([0-9]*\\).*/\\1/p')
  if [ -n \"$id\" ]; then printf '{\"id\":%s,\"result\":{}}\\n' \"$id\"; fi
done
",
]

pub fn hung_rpc_keeps_diagnostics_available_and_captures_stderr_test() {
  let label = "diagnostic-stall-test"
  let name = process.new_name("codex_diagnostic_test")
  let assert Ok(_) = codex.start(name, label, codex.Local(stub))
  let assert Ok(_) = codex.request(name, "test/ping", json.object([]))
  let done = process.new_subject()
  let _ =
    process.spawn_unlinked(fn() {
      let reply =
        codex.request(
          name,
          "test/stall",
          json.object([
            #("threadId", json.string("thr-stall")),
            #("text", json.string("private-prompt-marker")),
          ]),
        )
      process.send(done, reply)
    })
  let assert Ok(snapshot) = await_pending(name, 100)
  should.equal(jsonx.field_string(snapshot, ["connection"]), Ok("connected"))
  let assert Ok(pid) = jsonx.field_int(snapshot, ["osPid"])
  let stats = diagnostics.process_stats(pid)
  should.equal(
    jsonx.field_string(stats, ["state"]) == Ok("S")
      || jsonx.field_string(stats, ["state"]) == Ok("R"),
    True,
  )
  let assert Ok(threads) = jsonx.field_int(stats, ["threads"])
  should.equal(threads > 0, True)
  let serialized = jsonx.to_json(snapshot) |> json.to_string
  should.equal(string.contains(serialized, "test/stall"), True)
  should.equal(string.contains(serialized, "thr-stall"), True)
  let #(events, stderr) = diagnostics.paths(label)
  let assert Ok(log) = simplifile.read(events)
  should.equal(string.contains(log, "rpc_sent"), True)
  should.equal(string.contains(log, "private-prompt-marker"), False)
  let assert Ok(log) = simplifile.read(stderr)
  should.equal(string.contains(log, "diagnostic-stderr-marker"), True)
  codex.notify(name, "test/die", json.object([]))
  let assert Ok(Error(_)) = process.receive(done, 3000)
  let _ = simplifile.delete(events)
  let _ = simplifile.delete(stderr)
  Nil
}

fn await_pending(name: codex.Codex, tries: Int) {
  let value = codex.diagnostic_snapshot(name) |> json.to_string
  case string.contains(value, "test/stall"), tries {
    True, _ -> Ok(parsed(value))
    False, 0 -> Error(Nil)
    _, _ -> {
      process.sleep(10)
      await_pending(name, tries - 1)
    }
  }
}

pub fn diagnostic_file_rotates_test() {
  let label = "diagnostic-rotation-test"
  let #(events, _) = diagnostics.paths(label)
  diagnostics.record(label, 100, "initial", [])
  let assert Ok(_) = simplifile.write(events, string.repeat("x", 5_242_880))
  diagnostics.record(label, 101, "rotated", [])
  let assert Ok(log) = simplifile.read(events)
  should.equal(string.contains(log, "rotated"), True)
  let assert Ok(old) = simplifile.read(events <> ".1")
  should.equal(string.length(old), 5_242_880)
  let _ = simplifile.delete(events)
  let _ = simplifile.delete(events <> ".1")
  Nil
}

pub fn stderr_rotation_preserves_append_path_test() {
  let label = "diagnostic-stderr-rotation-test"
  let #(_, path) = diagnostics.paths(label)
  should.equal(diagnostics.rotate_stderr(label), True)
  let assert Ok(_) = simplifile.write(path, string.repeat("x", 5_242_880))
  should.equal(diagnostics.rotate_stderr(label), True)
  let assert Ok(current) = simplifile.read(path)
  should.equal(current, "")
  let assert Ok(previous) = simplifile.read(path <> ".1")
  should.equal(string.length(previous), 5_242_880)
  let assert Ok(_) = simplifile.append(path, "after rotation")
  let assert Ok(current) = simplifile.read(path)
  should.equal(current, "after rotation")
  let _ = simplifile.delete(path)
  let _ = simplifile.delete(path <> ".1")
  Nil
}
