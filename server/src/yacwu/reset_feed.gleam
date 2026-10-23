//// Public Codex reset reports from codex-resets.com, cached for ten minutes.
//// Completed resets and scheduled announcements are separate API records.
//// No account data is sent. YACWU_RESET_FEED=off turns it off.

import envoy
import filepath
import gleam/dynamic/decode
import gleam/http/request
import gleam/httpc
import gleam/json.{type Json}
import gleam/list
import gleam/option.{type Option, None, Some}
import gleam/result
import simplifile

pub const url = "https://codex-resets.com/api/v1/resets?limit=100"

const status_url = "https://codex-resets.com/api/v1/status"

const source_url = "https://codex-resets.com"

const max_age_seconds = 600

pub type Entry {
  Entry(
    kind: String,
    text: String,
    url: String,
    at: String,
    expected_at: Option(String),
  )
}

pub fn enabled() -> Bool {
  envoy.get("YACWU_RESET_FEED") != Ok("off")
}

fn cache_path() -> String {
  let state = case envoy.get("XDG_STATE_HOME") {
    Ok(dir) if dir != "" -> dir
    _ -> filepath.join(envoy.get("HOME") |> result.unwrap("."), ".local/state")
  }
  // Separate from the retired XML source: never mix in its stale records.
  filepath.join(state, "yacwu/reset-feed-v2.json")
}

pub fn entries(now: Int) -> List(Entry) {
  let path = cache_path()
  let cached =
    simplifile.read(path)
    |> result.replace_error(Nil)
    |> result.try(parse_cache)
  let fresh = case simplifile.file_info(path) {
    Ok(info) -> now - info.mtime_seconds < max_age_seconds
    Error(_) -> False
  }
  case fresh, cached {
    True, Ok(entries) -> entries
    _, _ ->
      case fetch() {
        Ok(entries) -> {
          let _ = simplifile.create_directory_all(filepath.directory_name(path))
          let _ = simplifile.write(path, json.to_string(to_json(entries)))
          entries
        }
        Error(_) -> result.unwrap(cached, [])
      }
  }
}

fn get(url: String) -> Result(String, Nil) {
  use req <- result.try(request.to(url) |> result.replace_error(Nil))
  case
    httpc.configure()
    |> httpc.timeout(3500)
    |> httpc.dispatch(request.prepend_header(req, "user-agent", "yacwu"))
  {
    Ok(resp) if resp.status == 200 -> Ok(resp.body)
    _ -> Error(Nil)
  }
}

fn fetch() -> Result(List(Entry), Nil) {
  use text <- result.try(get(url))
  use completed <- result.try(parse(text))
  // If schedule data is unavailable, still show verified history, but never
  // invent an announcement or turn a missed schedule into a completed reset.
  let scheduled =
    get(status_url) |> result.try(parse_status) |> result.unwrap([])
  Ok(list.append(scheduled, completed))
}

fn public_entry() -> decode.Decoder(Entry) {
  use kind <- decode.field("reset_type", decode.string)
  use text <- decode.field("text", decode.string)
  use at <- decode.field("announced_at", decode.string)
  use url <- decode.then(decode.optionally_at(
    ["source", "url"],
    source_url,
    decode.string,
  ))
  decode.success(Entry(
    case kind {
      "regular" -> "reset"
      "banked" -> "banked"
      _ -> "unknown"
    },
    text,
    url,
    at,
    None,
  ))
}

pub fn parse(text: String) -> Result(List(Entry), Nil) {
  json.parse(text, decode.at(["data"], decode.list(public_entry())))
  |> result.replace_error(Nil)
}

pub fn parse_status(text: String) -> Result(List(Entry), Nil) {
  let scheduled = {
    use status <- decode.field("status", decode.string)
    use entry <- decode.then(public_entry())
    use due <- decode.field("scheduled_for", decode.optional(decode.string))
    decode.success(case status, entry.kind {
      "scheduled", "reset" -> [
        Entry(
          "reset_preview",
          "Reset announced: " <> entry.text,
          entry.url,
          entry.at,
          due,
        ),
      ]
      _, _ -> []
    })
  }
  json.parse(
    text,
    decode.at(["data", "scheduled_reset"], decode.optional(scheduled)),
  )
  |> result.map(fn(value) { option_entries(value) })
  |> result.replace_error(Nil)
}

fn option_entries(value: Option(List(Entry))) -> List(Entry) {
  case value {
    Some(entries) -> entries
    None -> []
  }
}

pub fn parse_cache(text: String) -> Result(List(Entry), Nil) {
  let entry = {
    use kind <- decode.field("kind", decode.string)
    use text <- decode.field("text", decode.string)
    use url <- decode.field("url", decode.string)
    use at <- decode.field("at", decode.string)
    use expected <- decode.field("expectedAt", decode.optional(decode.string))
    decode.success(Entry(kind, text, url, at, expected))
  }
  json.parse(text, decode.at(["entries"], decode.list(entry)))
  |> result.replace_error(Nil)
}

pub fn to_json(entries: List(Entry)) -> Json {
  json.object([
    #("source", json.string(source_url)),
    #(
      "entries",
      json.array(entries, fn(entry) {
        json.object([
          #("kind", json.string(entry.kind)),
          #("text", json.string(entry.text)),
          #("url", json.string(entry.url)),
          #("at", json.string(entry.at)),
          #("expectedAt", case entry.expected_at {
            Some(at) -> json.string(at)
            None -> json.null()
          }),
        ])
      }),
    ),
  ])
}
