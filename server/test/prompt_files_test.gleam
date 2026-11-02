import gleeunit/should
import yacwu/router

pub fn prompt_extensions_use_the_allowlist_format_test() {
  router.prompt_file_extension("Mother_of_Learning.txt") |> should.equal("txt")
  router.prompt_file_extension("NOTES.TXT") |> should.equal("txt")
  router.prompt_file_extension("report.pdf") |> should.equal("pdf")
  router.prompt_file_extension("archive.notes.md") |> should.equal("md")
  router.prompt_file_extension("component.tsx") |> should.equal("tsx")
  router.prompt_file_extension("Dockerfile") |> should.equal("dockerfile")
  router.prompt_file_extension("Makefile") |> should.equal("makefile")
  router.prompt_file_extension("no-extension") |> should.equal("")
}
