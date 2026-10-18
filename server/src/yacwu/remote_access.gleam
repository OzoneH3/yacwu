//// Dedicated expiring SSH identities. Passwords never enter the state file.

import envoy
import filepath
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json
import gleam/list
import gleam/result
import simplifile
import yacwu/jsonx
import yacwu/oauth

@external(erlang, "yacwu_ssh_access", "host_id")
fn host_id(host: String) -> String

@external(erlang, "yacwu_ssh_access", "run")
fn run(script: String, input: String) -> Result(String, String)

pub fn root() -> String {
  let home = envoy.get("HOME") |> result.unwrap(".")
  let state =
    envoy.get("XDG_STATE_HOME")
    |> result.unwrap(filepath.join(home, ".local/state"))
  filepath.join(state, "yacwu/ssh-access")
}

pub fn entry(host: String) -> Result(Dynamic, Nil) {
  simplifile.read(filepath.join(root(), host_id(host) <> "/entry.json"))
  |> result.replace_error(Nil)
  |> result.try(fn(text) {
    json.parse(text, decode.dynamic) |> result.replace_error(Nil)
  })
}

pub fn discover() -> List(String) {
  simplifile.read_directory(root())
  |> result.unwrap([])
  |> list.filter_map(fn(name) {
    simplifile.read(filepath.join(root(), name <> "/entry.json"))
    |> result.replace_error(Nil)
    |> result.try(fn(text) {
      json.parse(text, decode.dynamic) |> result.replace_error(Nil)
    })
    |> result.try(jsonx.field_string(_, ["host"]))
  })
}

pub fn expires_at(host: String) -> Int {
  entry(host)
  |> result.try(jsonx.field_int(_, ["expiresAt"]))
  |> result.unwrap(0)
}

pub fn check(host: String) -> Result(Nil, String) {
  case entry(host) {
    Error(_) ->
      case
        simplifile.exists(
          filepath.join(root(), host_id(host) <> "/entry.json"),
          follow_links: False,
        )
      {
        Ok(False) -> Ok(Nil)
        _ ->
          Error(
            "SSH access record cannot be read. Repair or remove it before reconnecting.",
          )
      }
    Ok(data) -> {
      let expires = jsonx.field_int(data, ["expiresAt"]) |> result.unwrap(0)
      case
        expires <= oauth.now() * 1000,
        jsonx.field_bool(data, ["cleanupRequired"])
      {
        True, _ ->
          Error("Temporary SSH access expired. Remove it and set up a new key.")
        _, Ok(True) ->
          Error("SSH setup needs cleanup. Use Remove access before retrying.")
        _, _ -> Ok(Nil)
      }
    }
  }
}

/// These identities use explicit connection fields and no per-host SSH config;
/// existing ~/.ssh/config aliases continue to use their usual settings.
pub fn arguments(host: String) -> List(String) {
  case entry(host) {
    Error(_) -> []
    Ok(data) -> {
      let hostname = jsonx.field_string(data, ["hostname"]) |> result.unwrap("")
      let username = jsonx.field_string(data, ["username"]) |> result.unwrap("")
      let port = jsonx.field_int(data, ["port"]) |> result.unwrap(22)
      let key = filepath.join(root(), host_id(host) <> "/id_ed25519")
      [
        "-F",
        "/dev/null",
        "-oHostName=" <> hostname,
        "-l",
        username,
        "-p",
        int.to_string(port),
        "-i",
        key,
        "-oIdentitiesOnly=yes",
        "-oIdentityAgent=none",
        "-oStrictHostKeyChecking=yes",
        "-oControlMaster=no",
        "-oControlPath=none",
      ]
    }
  }
}

/// Close an already-authenticated forwarding connection when the key expires.
/// Remote app-servers remain detached and keep their running turns.
pub fn tunnel_wrapper(host: String) -> String {
  let expires = expires_at(host)
  let ttl = int.max(1, expires / 1000 - oauth.now())
  let timer = case expires > 0 {
    True ->
      "( sleep "
      <> int.to_string(ttl)
      <> " & s=$!; trap 'kill \"$s\" 2>/dev/null; exit' TERM INT HUP; wait \"$s\"; kill \"$p\" 2>/dev/null ) & t=$!; "
    False -> "t=; "
  }
  "ssh \"$@\" & p=$!; "
  <> timer
  <> "cat >/dev/null; kill \"$p\" 2>/dev/null; [ -z \"$t\" ] || kill \"$t\" 2>/dev/null"
}

pub fn operation(input: Dynamic, action: String) -> Result(Dynamic, String) {
  let root =
    envoy.get("YACWU_BACKEND_ROOT")
    |> result.lazy_or(fn() { envoy.get("PWD") })
    |> result.unwrap(".")
  let direct = filepath.join(root, "scripts/ssh-access.mjs")
  let script = case simplifile.is_file(direct) {
    Ok(True) -> direct
    _ -> filepath.join(root, "../scripts/ssh-access.mjs")
  }
  // Whitelist fields; caller-supplied action or internal paths cannot override us.
  let fields =
    [
      "hostname",
      "username",
      "port",
      "hours",
      "password",
      "confirmedFingerprint",
      "host",
    ]
    |> list.filter_map(fn(key) {
      jsonx.field(input, [key])
      |> result.map(fn(value) { #(key, jsonx.to_json(value)) })
    })
  use text <- result.try(run(
    script,
    json.to_string(json.object([#("action", json.string(action)), ..fields])),
  ))
  json.parse(text, decode.dynamic)
  |> result.replace_error("Invalid SSH setup response")
}
