import gleeunit/should
import yacwu/reset_feed.{Entry}

pub fn parses_kind_text_link_and_time_test() {
  reset_feed.parse(
    "<feed><title>Will Codex Reset</title>"
    <> "<entry><title>reset_preview: Global reset landing by EOD PST &amp; enjoy</title><link href=\"https://willreset.com/r/1\"/><id>x</id><updated>2026-10-13T01:03:59Z</updated></entry>"
    <> "<entry><title>no kind here</title></entry>"
    <> "<entry><title>reset: It&#39;s done.</title><link href=\"https://willreset.com/r/2\"/><updated>2026-10-13T05:06:06Z</updated></entry></feed>",
  )
  |> should.equal([
    Entry(
      "reset_preview",
      "Global reset landing by EOD PST & enjoy",
      "https://willreset.com/r/1",
      "2026-10-13T01:03:59Z",
    ),
    Entry(
      "reset",
      "It's done.",
      "https://willreset.com/r/2",
      "2026-10-13T05:06:06Z",
    ),
  ])
}
