//// Stability is an observation rule, not a guarantee of upstream finality.

import gleam/int

pub type Reading {
  Reading(started: Int, changed: Int, used: Int, highest: Int, reset: Int)
}

pub fn start(now: Int, used: Int, reset: Int) -> Reading {
  Reading(now, now, used, used, reset)
}

pub fn observe(
  previous: Reading,
  now: Int,
  used: Int,
  reset: Int,
) -> Result(Reading, String) {
  // The upstream reset timestamp moves by a second between reads even within
  // the same allowance window. A real weekly reset is days away, so tolerate
  // small timestamp jitter while still rejecting an actual window change.
  case int.max(reset, previous.reset) - int.min(reset, previous.reset) > 60 {
    True -> Error("Weekly allowance reset during sampling; benchmark stopped")
    False ->
      Ok(
        Reading(
          ..previous,
          changed: case used == previous.used {
            True -> previous.changed
            False -> now
          },
          used: used,
          highest: int.max(previous.highest, used),
        ),
      )
  }
}

pub fn ready(reading: Reading, now: Int, minimum: Int) -> Bool {
  now - reading.started >= minimum
  && now - reading.changed >= 60
  && reading.used == reading.highest
}
