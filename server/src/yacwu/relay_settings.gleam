//// The relay's persisted preference: whether sessions without their own
//// choice accept direct messages. Kept in Yacwu's state directory so a
//// restart cannot silently turn messages back on. Per-session choices stay
//// in memory.

import envoy
import filepath
import gleam/dynamic/decode
import gleam/json
import gleam/result
import simplifile
import yacwu/relay

pub fn path() -> String {
  let state = case envoy.get("XDG_STATE_HOME") {
    Ok(dir) if dir != "" -> dir
    _ ->
      filepath.join(envoy.get("HOME") |> result.unwrap("/tmp"), ".local/state")
  }
  filepath.join(state, "yacwu/relay-settings.json")
}

/// Missing or unreadable settings mean the built-in default: accept.
pub fn load(path: String) -> Bool {
  simplifile.read(path)
  |> result.replace_error(Nil)
  |> result.try(fn(text) {
    json.parse(text, decode.at(["acceptByDefault"], decode.bool))
    |> result.replace_error(Nil)
  })
  |> result.unwrap(True)
}

pub fn save(path: String, accept: Bool) -> Nil {
  let _ = simplifile.create_directory_all(filepath.directory_name(path))
  let _ =
    simplifile.write(
      path,
      json.to_string(json.object([#("acceptByDefault", json.bool(accept))])),
    )
  Nil
}

pub fn persistence(path: String) -> relay.Persistence {
  relay.Persistence(load: fn() { load(path) }, save: fn(accept) {
    save(path, accept)
  })
}
