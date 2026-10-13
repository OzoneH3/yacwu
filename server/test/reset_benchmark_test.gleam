import gleeunit/should
import yacwu/reset_benchmark
import yacwu/reset_feed.{Entry}

// 2026-10-13T06:00:00Z
const now = 1_791_871_200

pub fn an_announced_reset_is_pending_until_the_week_restarts_test() {
  let announced =
    Entry(
      "reset_preview",
      "Global reset by EOD PST",
      "u1",
      "2026-10-13T01:03:59Z",
    )
  let earlier_landed =
    Entry("reset", "Put the reset in the bag.", "u0", "2026-10-11T04:01:09Z")
  // The week began on 11 Oct, before the announcement.
  reset_benchmark.pending([announced, earlier_landed], now, 1_791_697_478)
  |> should.equal(Ok(announced))
  // The week began after it: the reset has landed.
  reset_benchmark.pending([announced], now, 1_791_870_572)
  |> should.equal(Error(Nil))
  // Done, chatter, or a day old: not an announcement.
  reset_benchmark.pending(
    [
      Entry(
        "reset_preview",
        "Your side of reset? It's done.",
        "u2",
        "2026-10-13T05:06:06Z",
      ),
      Entry(
        "reset_preview",
        "Mashed @poteto on the house.",
        "u3",
        "2026-10-13T05:06:10Z",
      ),
    ],
    now,
    0,
  )
  |> should.equal(Error(Nil))
  reset_benchmark.pending([announced], now + 90_000, 0)
  |> should.equal(Error(Nil))
}

pub fn plans_unmeasured_combinations_most_costly_first_test() {
  let catalog = [
    #("gpt-6.1-sol", ["low", "medium", "high", "xhigh"]),
    #("gpt-6-luna", ["low", "medium"]),
  ]
  reset_benchmark.plan(catalog, [#("gpt-6.1-sol", "high")])
  |> should.equal([
    #("gpt-6.1-sol", "xhigh"),
    #("gpt-6.1-sol", "medium"),
    #("gpt-6.1-sol", "low"),
    #("gpt-6-luna", "medium"),
    #("gpt-6-luna", "low"),
  ])
}

pub fn only_completed_stages_count_as_measured_test() {
  let journal =
    "{\"event\":\"benchmarkBoundary\",\"threadId\":\"a\",\"model\":\"m\",\"effort\":\"high\"}\n"
    <> "{\"event\":\"benchmarkBoundaryEnd\",\"threadId\":\"a\"}\n"
    <> "{\"event\":\"benchmarkBoundary\",\"threadId\":\"b\",\"model\":\"m\",\"effort\":\"low\"}\n"
    <> "not json\n"
  reset_benchmark.measured(journal) |> should.equal([#("m", "high")])
}
