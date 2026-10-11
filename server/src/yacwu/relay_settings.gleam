//// The relay's persisted state, kept in Yacwu's state directory: whether
//// sessions without their own choice accept direct messages (so a restart
//// cannot silently turn messages back on), and the messages not yet
//// delivered (so a restart does not lose them). Per-session choices stay in
//// memory.

import envoy
import filepath
import gleam/dynamic/decode
import gleam/json
import gleam/list
import gleam/result
import simplifile
import yacwu/relay
import yacwu/relay_core.{type Message}

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

/// Where the undelivered messages live, next to the settings file.
pub fn queue_path(settings_path: String) -> String {
  filepath.join(filepath.directory_name(settings_path), "relay-queue.json")
}

pub fn persistence(path: String) -> relay.Persistence {
  let queue = queue_path(path)
  relay.Persistence(
    load: fn() { load(path) },
    save: fn(accept) { save(path, accept) },
    load_open: fn() { load_open(queue) },
    save_open: fn(messages) { save_open(queue, messages) },
  )
}

/// Missing or unreadable means nothing was waiting.
pub fn load_open(path: String) -> List(Message) {
  simplifile.read(path)
  |> result.replace_error(Nil)
  |> result.try(fn(text) {
    json.parse(text, decode.at(["messages"], decode.list(saved_message())))
    |> result.replace_error(Nil)
  })
  |> result.unwrap([])
}

/// Written whole to a temporary file, then renamed: a crash mid-write
/// leaves the previous queue, never a truncated one.
pub fn save_open(path: String, messages: List(Message)) -> Nil {
  let _ = simplifile.create_directory_all(filepath.directory_name(path))
  let body =
    json.object([
      #(
        "messages",
        json.preprocessed_array(
          list.map(messages, fn(m) {
            json.object([
              #("message", relay.message_json(m)),
              #("fingerprint", json.string(m.fingerprint)),
            ])
          }),
        ),
      ),
    ])
  let temporary = path <> ".tmp"
  case simplifile.write(temporary, json.to_string(body)) {
    Ok(_) -> {
      let _ = simplifile.rename(at: temporary, to: path)
      Nil
    }
    Error(_) -> Nil
  }
}

fn saved_message() -> decode.Decoder(Message) {
  let address = {
    use host <- decode.field("host", decode.string)
    use thread <- decode.field("thread", decode.string)
    decode.success(relay_core.Address(host, thread))
  }
  use fingerprint <- decode.field("fingerprint", decode.string)
  use m <- decode.field("message", {
    use id <- decode.field("id", decode.string)
    use from <- decode.field("from", address)
    use to <- decode.field("to", address)
    use text <- decode.field("text", decode.string)
    use state <- decode.field("state", decode.string)
    use created_at <- decode.field("createdAt", decode.int)
    use ack <- decode.field("ack", decode.string)
    decode.success(relay_core.Message(
      id: id,
      from: from,
      to: to,
      text: text,
      fingerprint: "",
      created_at: created_at,
      state: case state {
        "queued" -> relay_core.Queued
        _ -> relay_core.Reserved
      },
      reason: "",
      submission: "",
      turn: "",
      generation: 0,
      provider: case ack {
        "adapterRecorded" -> relay_core.ClaudeAdapter
        _ -> relay_core.CodexBackend
      },
      version: 0,
    ))
  })
  decode.success(relay_core.Message(..m, fingerprint: fingerprint))
}
