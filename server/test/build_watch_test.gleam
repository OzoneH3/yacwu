import gleeunit/should

@external(erlang, "yacwu_build_watch_test_ffi", "exercise")
fn exercise() -> Bool

pub fn shared_watcher_deduplicates_subscribers_and_cleans_up_test() {
  exercise() |> should.be_true
}
