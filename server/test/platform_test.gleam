import gleam/list
import gleeunit/should
import simplifile
import yacwu/files
import yacwu/platform
import yacwu/relay_settings

pub fn windows_roots_test() {
  list.each(
    ["C:/", "D:\\My project\\日本", "//server/share/folder", "\\\\server\\share"],
    fn(p) { platform.windows_absolute(p) |> should.be_true },
  )
  list.each(
    [
      "C:relative",
      "/relative-to-drive",
      "\\relative",
      "//server",
      "//?/C:/device",
      "//./pipe/name",
      "C:/bad\u{0000}",
    ],
    fn(p) { platform.windows_absolute(p) |> should.be_false },
  )
}

pub fn native_files_and_state_test() {
  let root = platform.resolve("../.workspace/portable-files/My project 日本", ".")
  let assert Ok(_) = simplifile.create_directory_all(root)
  let path = files.resolve(root, "hello.txt")
  let assert Ok(_) = simplifile.write(path, "hello")
  files.read_file(path) |> should.equal(files.Text(5, "hello"))
  let assert Ok(_) = files.list_directory(root)
  platform.is_absolute(root) |> should.be_true
  let state = root <> "/state.json"
  relay_settings.save(state, False)
  relay_settings.load(state) |> should.be_false
  relay_settings.save(state, True)
  relay_settings.load(state) |> should.be_true
}

pub fn windows_relative_paths_test() {
  case platform.is_windows() {
    True ->
      list.each(
        [
          "C:/escape",
          "C:escape",
          "file.txt:stream",
          "/escape",
          "../escape",
          "dir/../../escape",
          "dir\\file",
        ],
        fn(p) { files.sanitize(p) |> should.be_error },
      )
    False -> Nil
  }
}

pub fn relay_permissions_test() {
  let root = platform.resolve("../.workspace/portable-relay", ".")
  let assert Ok(_) = simplifile.create_directory_all(root)
  platform.restrict(root, True) |> should.equal(Ok(Nil))
  let path = root <> "/credential"
  let assert Ok(_) = simplifile.write(path, "")
  platform.restrict(path, False) |> should.equal(Ok(Nil))
  let assert Ok(_) = simplifile.write(path, "test-credential")
  simplifile.read(path) |> should.equal(Ok("test-credential"))
}

pub fn windows_names_test() {
  list.each(
    [
      "a.txt:stream",
      ".. /escape",
      "CON",
      "nul.txt",
      "dir/trailing.",
      "dir/ending ",
    ],
    fn(p) { platform.windows_relative(p) |> should.be_false },
  )
  platform.windows_relative("My project/日本.txt") |> should.be_true
  files.sanitize("dir//../../escape") |> should.be_error
}
