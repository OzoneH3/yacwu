import gleam/json
import gleam/option.{None, Some}
import gleeunit/should
import yacwu/reset_feed.{Entry}

pub fn public_api_completed_resets_are_parsed_test() {
  reset_feed.parse(
    "{\"data\":[{\"reset_type\":\"regular\",\"text\":\"Done\",\"announced_at\":\"2026-10-22T17:00:00Z\",\"source\":{\"url\":\"https://x.com/thsottiaux/status/123\"}},{\"reset_type\":\"banked\",\"text\":\"Granted\",\"announced_at\":\"2026-10-21T00:00:00Z\",\"source\":{\"type\":\"observed\"}}]}",
  )
  |> should.equal(
    Ok([
      Entry(
        "reset",
        "Done",
        "https://x.com/thsottiaux/status/123",
        "2026-10-22T17:00:00Z",
        None,
      ),
      Entry(
        "banked",
        "Granted",
        "https://codex-resets.com",
        "2026-10-21T00:00:00Z",
        None,
      ),
    ]),
  )
  reset_feed.parse("{\"error\":\"unavailable\"}") |> should.be_error
  reset_feed.parse("<html>error</html>") |> should.be_error
}

pub fn scheduled_api_reset_keeps_its_expected_time_test() {
  reset_feed.parse_status(
    "{\"data\":{\"scheduled_reset\":{\"status\":\"scheduled\",\"reset_type\":\"regular\",\"text\":\"Landing tomorrow\",\"announced_at\":\"2026-10-23T04:47:34Z\",\"scheduled_for\":\"2026-10-23T17:00:00Z\",\"source\":{\"url\":\"https://x.com/thsottiaux/status/456\"}}}}",
  )
  |> should.equal(
    Ok([
      Entry(
        "reset_preview",
        "Reset announced: Landing tomorrow",
        "https://x.com/thsottiaux/status/456",
        "2026-10-23T04:47:34Z",
        Some("2026-10-23T17:00:00Z"),
      ),
    ]),
  )
  reset_feed.parse_status("{\"data\":{\"scheduled_reset\":null}}")
  |> should.equal(Ok([]))
  reset_feed.parse_status("{\"error\":\"unavailable\"}") |> should.be_error
}

pub fn normalized_cache_round_trips_expected_time_test() {
  let entries = [
    Entry(
      "reset_preview",
      "Reset announced",
      "https://x.com/a",
      "2026-10-23T04:00:00Z",
      Some("2026-10-23T17:00:00Z"),
    ),
  ]
  entries
  |> reset_feed.to_json
  |> json.to_string
  |> reset_feed.parse_cache
  |> should.equal(Ok(entries))
}
