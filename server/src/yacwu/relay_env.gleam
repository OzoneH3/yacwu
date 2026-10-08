//// What agents need to reach the session relay, set up once at start and
//// exported to every backend child through the environment:
////
//// - `YACWU_RELAY_URL`: `http://127.0.0.1:<port>`, or `unix:<path>` when
////   serving on a Unix socket.
//// - `YACWU_RELAY_AUTH_FILE`: a 0600 file holding the shared credential.
////   Codex strips variables whose names contain KEY, SECRET or TOKEN from
////   shell tools, so the secret itself is never put in the environment.
//// - `YACWU_RELAY_CLI`: the absolute path of `scripts/yacwu-relay.mjs`.
////
//// The credential is shared by every local agent: it keeps other users and
//// unrelated local processes out, not one session from another.

import envoy
import filepath
import gleam/bit_array
import gleam/crypto
import gleam/int
import gleam/io
import gleam/option.{None, Some}
import gleam/result
import gleam/string
import simplifile
import yacwu/config

/// Create the credential and export the environment. Returns the
/// credential, or "" (relay agent routes disabled) if it cannot be stored.
pub fn setup(conf: config.Config) -> String {
  let credential =
    crypto.strong_random_bytes(32)
    |> bit_array.base16_encode
    |> string.lowercase
  let name = case conf.unix {
    Some(path) ->
      "relay-unix-"
      <> {
        crypto.hash(crypto.Sha256, bit_array.from_string(path))
        |> bit_array.base16_encode
        |> string.lowercase
        |> string.slice(0, 12)
      }
      <> ".auth"
    None -> "relay-" <> int.to_string(conf.port) <> ".auth"
  }
  case store(state_dir(), name, credential) {
    Error(reason) -> {
      io.println_error(
        "yacwu: session relay disabled, cannot store its credential: " <> reason,
      )
      ""
    }
    Ok(path) -> {
      envoy.set("YACWU_RELAY_AUTH_FILE", path)
      envoy.set("YACWU_RELAY_URL", url(conf))
      let cli =
        filepath.join(
          envoy.get("YACWU_BACKEND_ROOT")
            |> result.lazy_or(fn() { envoy.get("PWD") })
            |> result.unwrap("."),
          "scripts/yacwu-relay.mjs",
        )
      case simplifile.is_file(cli) {
        Ok(True) -> envoy.set("YACWU_RELAY_CLI", cli)
        _ -> envoy.unset("YACWU_RELAY_CLI")
      }
      credential
    }
  }
}

pub fn url(conf: config.Config) -> String {
  case conf.unix {
    Some(path) -> "unix:" <> path
    None -> {
      let host = case conf.host {
        "0.0.0.0" | "::" | "" -> "127.0.0.1"
        host ->
          case string.contains(host, ":") {
            True -> "[" <> host <> "]"
            False -> host
          }
      }
      "http://" <> host <> ":" <> int.to_string(conf.port)
    }
  }
}

fn state_dir() -> String {
  case envoy.get("XDG_RUNTIME_DIR") {
    Ok(dir) if dir != "" -> filepath.join(dir, "yacwu")
    _ ->
      filepath.join(
        envoy.get("HOME") |> result.unwrap("/tmp"),
        ".local/state/yacwu",
      )
  }
}

/// Write the credential so it is never readable by others, not even
/// briefly: the empty file is restricted before the secret goes in.
fn store(
  dir: String,
  name: String,
  credential: String,
) -> Result(String, String) {
  let path = filepath.join(dir, name)
  let describe = fn(error) { simplifile.describe_error(error) }
  use _ <- result.try(
    simplifile.create_directory_all(dir) |> result.map_error(describe),
  )
  use _ <- result.try(
    simplifile.set_permissions_octal(dir, 0o700) |> result.map_error(describe),
  )
  let _ = simplifile.delete(path)
  use _ <- result.try(
    simplifile.create_file(path) |> result.map_error(describe),
  )
  use _ <- result.try(
    simplifile.set_permissions_octal(path, 0o600) |> result.map_error(describe),
  )
  use _ <- result.try(
    simplifile.write(path, credential) |> result.map_error(describe),
  )
  Ok(path)
}
