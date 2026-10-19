//// Persistent file access for sessions. Missing records preserve legacy access;
//// unreadable records fail closed. Only Codex exposes an enforced sandbox.

import envoy
import filepath
import gleam/bit_array
import gleam/crypto
import gleam/dynamic.{type Dynamic}
import gleam/dynamic/decode
import gleam/int
import gleam/json.{type Json}
import gleam/list
import gleam/result
import gleam/string
import simplifile
import yacwu/jsonx

pub const read_only = "read-only"

pub const read_write = "read-write"

pub fn valid(mode: String) -> Bool {
  mode == read_only || mode == read_write
}

pub fn path(host: String, thread: String) -> String {
  let root =
    envoy.get("XDG_STATE_HOME")
    |> result.unwrap(filepath.join(
      envoy.get("HOME") |> result.unwrap("."),
      ".local/state",
    ))
  let key =
    crypto.hash(crypto.Sha256, bit_array.from_string(host <> "\n" <> thread))
    |> bit_array.base16_encode
  filepath.join(root, "yacwu/file-access/" <> key)
}

pub fn load(host: String, thread: String) -> Result(String, String) {
  case simplifile.read(path(host, thread)) {
    Error(simplifile.Enoent) -> Ok(read_write)
    Ok(mode) ->
      case valid(mode) {
        True -> Ok(mode)
        False -> Error("Session file access record is invalid")
      }
    Error(_) -> Error("Could not read session file access")
  }
}

@external(erlang, "erlang", "unique_integer")
fn unique() -> Int

pub fn save(host: String, thread: String, mode: String) -> Result(Nil, String) {
  case valid(mode) {
    False -> Error("File access must be read-only or read-write")
    True -> {
      let target = path(host, thread)
      let temp = target <> "." <> int.to_string(unique())
      let _ = simplifile.create_directory_all(filepath.directory_name(target))
      let saved =
        simplifile.write(temp, mode)
        |> result.try(fn(_) { simplifile.rename(temp, target) })
        |> result.replace_error("Could not save session file access")
      let _ = simplifile.delete(temp)
      saved
    }
  }
}

pub fn state(mode: String, provider: String) -> Json {
  json.object([
    #("mode", json.string(mode)),
    #("readOnlySupported", json.bool(provider == "codex")),
  ])
}

pub fn dynamic(params: Json) -> Dynamic {
  let assert Ok(value) = json.parse(json.to_string(params), decode.dynamic)
  value
}

/// Always override caller/profile defaults at the final RPC boundary. Steers
/// have no policy field and retain the running turn's policy.
pub fn apply(params: Json, method: String, mode: String) -> Json {
  let fields = case method {
    "thread/start" | "thread/resume" | "thread/fork" -> [
      #(
        "sandbox",
        json.string(case mode {
          "read-only" -> "read-only"
          _ -> "danger-full-access"
        }),
      ),
      #("approvalPolicy", json.string("never")),
    ]
    "turn/start" -> [
      #(
        "sandboxPolicy",
        json.object([
          #(
            "type",
            json.string(case mode {
              "read-only" -> "readOnly"
              _ -> "dangerFullAccess"
            }),
          ),
        ]),
      ),
      #("approvalPolicy", json.string("never")),
    ]
    _ -> []
  }
  case fields {
    [] -> params
    _ -> {
      // Permission profiles can supersede legacy sandbox fields. Do not pass
      // a profile capable of widening this session's saved restriction.
      let value = dynamic(params)
      let kept =
        jsonx.object_fields(value)
        |> list.filter(fn(entry) {
          entry.0 != "permissions"
          && entry.0 != "permissionProfile"
          && entry.0 != "permissionProfileId"
        })
        |> list.map(fn(entry) { #(entry.0, jsonx.to_json(entry.1)) })
        |> json.object
        |> dynamic
      jsonx.object_with(kept, fields)
    }
  }
}

pub fn prepare(
  host: String,
  provider: String,
  method: String,
  params: Json,
) -> Result(Json, String) {
  case method {
    "thread/start" -> {
      let mode = case jsonx.field_string(dynamic(params), ["sandbox"]) {
        Ok("read-only") -> read_only
        _ -> read_write
      }
      authorize(provider, mode)
      |> result.map(fn(_) { apply(params, method, mode) })
    }
    "thread/resume" | "thread/fork" | "turn/start" | "thread/shellCommand" -> {
      let thread =
        jsonx.field_string(dynamic(params), ["threadId"]) |> result.unwrap("")
      use mode <- result.try(load(host, thread))
      use _ <- result.try(authorize(provider, mode))
      case method, mode {
        "thread/shellCommand", "read-only" ->
          Error(
            "Shell shortcuts are disabled for read-only sessions; ask the agent to run a sandboxed read command",
          )
        _, _ -> Ok(apply(params, method, mode))
      }
    }
    _ -> Ok(params)
  }
}

pub fn authorize(provider: String, mode: String) -> Result(Nil, String) {
  case valid(mode), mode, provider {
    False, _, _ -> Error("File access must be read-only or read-write")
    True, "read-only", provider if provider != "codex" ->
      Error(
        "Enforced read-only file access is currently supported by Codex only",
      )
    _, _, _ -> Ok(Nil)
  }
}

/// Spawned Codex agents inherit the native sandbox. Remember the same bound
/// here so later UI requests and approval responses also retain it.
pub fn inherit_agents(host: String, notification: Dynamic) -> Nil {
  case jsonx.field_string(notification, ["params", "item", "tool"]) {
    Ok("spawnAgent") -> {
      let parent =
        jsonx.field_string(notification, ["params", "threadId"])
        |> result.unwrap("")
      case load(host, parent) {
        Ok("read-only") -> {
          let children =
            decode.run(
              notification,
              decode.at(
                ["params", "item", "receiverThreadIds"],
                decode.list(decode.string),
              ),
            )
            |> result.unwrap([])
          list.each(children, fn(child) {
            let _ = save(host, child, read_only)
            Nil
          })
        }
        _ -> Nil
      }
    }
    _ -> Nil
  }
}

/// An approval must never lift a read-only bound, including on old protocols.
pub fn approval(host: String, method: String, message: Dynamic) -> Json {
  let thread =
    jsonx.field_string(message, ["params", "threadId"])
    |> result.unwrap(
      jsonx.field_string(message, ["params", "conversationId"])
      |> result.unwrap(""),
    )
  let restricted = load(host, thread) != Ok(read_write)
  case method, restricted {
    "item/permissions/requestApproval", _ ->
      json.object([
        #("permissions", json.object([])),
        #("scope", json.string("turn")),
      ])
    "item/commandExecution/requestApproval", True
    | "item/fileChange/requestApproval", True
    -> json.object([#("decision", json.string("decline"))])
    "execCommandApproval", True | "applyPatchApproval", True ->
      json.object([#("decision", json.string("abort"))])
    _, _ ->
      case string.contains(method, "requestApproval") {
        True -> json.object([#("decision", json.string("accept"))])
        False -> json.object([])
      }
  }
}
