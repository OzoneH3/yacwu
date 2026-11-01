//// Shared Claude reserve; absent until migrated from a browser preference.

import filepath
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/json
import gleam/option.{type Option, None, Some}
import gleam/result
import simplifile
import yacwu/account_limits
import yacwu/jsonx

pub fn path() -> String {
  filepath.join(
    filepath.directory_name(account_limits.path()),
    "claude-reserve.json",
  )
}

pub fn parse(data: Dynamic) -> Result(Int, String) {
  case jsonx.field_int(data, ["reserve"]) {
    Ok(value) if value >= 0 && value <= 50 -> Ok(value)
    _ -> Error("Claude reserve must be a whole number from 0 to 50.")
  }
}

pub fn encode(reserve: Option(Int)) -> json.Json {
  json.object([
    #("reserve", case reserve {
      Some(value) -> json.int(value)
      None -> json.null()
    }),
  ])
}

pub fn load(path: String) -> Result(Option(Int), String) {
  case simplifile.read(path) {
    Error(simplifile.Enoent) -> Ok(None)
    Error(_) -> Error("Could not read Claude reserve settings")
    Ok(text) ->
      json.parse(text, decode.dynamic)
      |> result.replace_error("Invalid Claude reserve settings")
      |> result.try(parse)
      |> result.map(Some)
  }
}
