import gleeunit/should
import yacwu/router

pub fn local_path_kinds_test() {
  router.local_path_kind("test") |> should.equal("dir")
  router.local_path_kind("gleam.toml") |> should.equal("file")
  router.local_path_kind("no-such-path") |> should.equal("missing")
}
