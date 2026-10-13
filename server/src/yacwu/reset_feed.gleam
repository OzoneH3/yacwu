//// Announced Codex limit resets, from the public willreset.com feed (it
//// classifies the Codex lead's posts: reset_preview, reset, banked, boost).
//// OpenAI resets everyone's limits now and then, usually announced hours
//// before; knowing lets you use what is left of the old allowance first.
////
//// Fetched at most every ten minutes and cached on disk. No account data is
//// sent. YACWU_RESET_FEED=off turns it off.

import envoy
import filepath
import gleam/http/request
import gleam/httpc
import gleam/json.{type Json}
import gleam/list
import gleam/result
import gleam/string
import simplifile

pub const url = "https://willreset.com/feed.xml"

const max_age_seconds = 600

pub type Entry {
  Entry(kind: String, text: String, url: String, at: String)
}

pub fn enabled() -> Bool {
  envoy.get("YACWU_RESET_FEED") != Ok("off")
}

fn cache_path() -> String {
  let state = case envoy.get("XDG_STATE_HOME") {
    Ok(dir) if dir != "" -> dir
    _ ->
      filepath.join(envoy.get("HOME") |> result.unwrap("/tmp"), ".local/state")
  }
  filepath.join(state, "yacwu/reset-feed.xml")
}

/// The feed's entries, newest first: from the cache while it is fresh,
/// otherwise fetched (falling back to a stale cache when the site is down).
pub fn entries(now: Int) -> List(Entry) {
  let path = cache_path()
  let cached = simplifile.read(path)
  let fresh = case simplifile.file_info(path) {
    Ok(info) -> now - info.mtime_seconds < max_age_seconds
    Error(_) -> False
  }
  let text = case fresh, cached {
    True, Ok(text) -> Ok(text)
    _, _ ->
      case fetch() {
        Ok(text) -> {
          let _ = simplifile.create_directory_all(filepath.directory_name(path))
          let _ = simplifile.write(path, text)
          Ok(text)
        }
        Error(_) -> cached |> result.replace_error(Nil)
      }
  }
  text |> result.map(parse) |> result.unwrap([])
}

fn fetch() -> Result(String, Nil) {
  use req <- result.try(request.to(url) |> result.replace_error(Nil))
  case httpc.send(req |> request.prepend_header("user-agent", "yacwu")) {
    Ok(resp) if resp.status == 200 -> Ok(resp.body)
    _ -> Error(Nil)
  }
}

fn between(text: String, open: String, close: String) -> String {
  case string.split_once(text, open) {
    Ok(#(_, rest)) ->
      case string.split_once(rest, close) {
        Ok(#(value, _)) -> value
        Error(_) -> ""
      }
    Error(_) -> ""
  }
}

fn unescape(text: String) -> String {
  text
  |> string.replace("&lt;", "<")
  |> string.replace("&gt;", ">")
  |> string.replace("&quot;", "\"")
  |> string.replace("&#39;", "'")
  |> string.replace("&apos;", "'")
  |> string.replace("&amp;", "&")
}

/// Atom entries whose title reads "<kind>: <text>".
pub fn parse(feed: String) -> List(Entry) {
  string.split(feed, "<entry>")
  |> list.drop(1)
  |> list.filter_map(fn(entry) {
    let title = unescape(between(entry, "<title>", "</title>"))
    case string.split_once(title, ": ") {
      Ok(#(kind, text)) ->
        Ok(Entry(
          kind: kind,
          text: text,
          url: unescape(between(entry, "<link href=\"", "\"")),
          at: between(entry, "<updated>", "</updated>"),
        ))
      Error(_) -> Error(Nil)
    }
  })
}

pub fn to_json(entries: List(Entry)) -> Json {
  json.object([
    #("source", json.string(url)),
    #(
      "entries",
      json.array(entries, fn(entry) {
        json.object([
          #("kind", json.string(entry.kind)),
          #("text", json.string(entry.text)),
          #("url", json.string(entry.url)),
          #("at", json.string(entry.at)),
        ])
      }),
    ),
  ])
}
