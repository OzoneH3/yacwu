//// Project steering: one editable rule set per project, shared by every
//// worktree of a repository and every backend on this machine. Rules reach
//// a thread once, as developer instructions when it starts, and the version
//// each thread loaded is kept on record so Yacwu can show when a running
//// session's rules are outdated.
//// Changing the rules never rewrites an existing thread's instructions.

import envoy
import filepath
import gleam/dict.{type Dict}
import gleam/dynamic/decode
import gleam/erlang/process.{type Name, type Subject}
import gleam/int
import gleam/json
import gleam/option.{type Option, None, Some}
import gleam/otp/actor
import gleam/otp/supervision
import gleam/result
import gleam/string
import simplifile

pub type Rules {
  Rules(text: String, version: Int, updated_at: Int)
}

/// What a thread received when it started: the project, the rule version,
/// and the exact developer instructions (re-sent unchanged on resume).
pub type Applied {
  Applied(project: String, version: Int, instructions: String, applied_at: Int)
}

pub type State {
  State(projects: Dict(String, Rules), threads: Dict(String, Applied))
}

pub fn path() -> String {
  let state = case envoy.get("XDG_STATE_HOME") {
    Ok(dir) if dir != "" -> dir
    _ ->
      filepath.join(envoy.get("HOME") |> result.unwrap("/tmp"), ".local/state")
  }
  filepath.join(state, "yacwu/project-rules.json")
}

// -- Pure helpers ---------------------------------------------------------------

/// A project is a host plus its shared Git directory, so all worktrees of a
/// repository resolve to the same rules. Folders outside Git use their path.
pub fn project_key(host: String, identity: String) -> String {
  host <> ":" <> identity
}

/// Backends on this machine (Codex, Claude) share its filesystem, so a
/// repository is one project whichever of them runs the session. Keys of
/// such hosts read as "local:"; remote hosts keep their own name.
pub fn machine_key(key: String, is_local: fn(String) -> Bool) -> String {
  case string.split_once(key, ":") {
    Ok(#(host, identity)) ->
      case host != "local" && is_local(host) {
        True -> project_key("local", identity)
        False -> key
      }
    Error(_) -> key
  }
}

/// How a session's loaded rules compare with its project's current rules:
/// "current", "outdated", "otherProject", or "unknown" (started before
/// Yacwu tracked rules).
pub fn status(
  applied: Option(Applied),
  project: String,
  current_version: Int,
  is_local: fn(String) -> Bool,
) -> String {
  case applied {
    None -> "unknown"
    Some(applied) ->
      case machine_key(applied.project, is_local) == project {
        False -> "otherProject"
        True if applied.version < current_version -> "outdated"
        True -> "current"
      }
  }
}

/// The repository folder's name: the Git directory's parent, or the folder.
pub fn project_name(identity: String) -> String {
  let trimmed = case string.ends_with(identity, "/") && identity != "/" {
    True -> string.drop_end(identity, 1)
    False -> identity
  }
  let folder = case string.ends_with(trimmed, "/.git") {
    True -> string.drop_end(trimmed, 5)
    False -> trimmed
  }
  case filepath.base_name(folder) {
    "" -> folder
    name -> name
  }
}

/// Developer instructions for a new thread: the base instructions, then the
/// project's rules (when it has any).
pub fn instructions(base: String, rules: Option(Rules)) -> String {
  case rules {
    Some(rules) ->
      case string.trim(rules.text) {
        "" -> base
        text ->
          base
          <> "\n\n# Project rules (version "
          <> int.to_string(rules.version)
          <> ", managed in Yacwu)\n\nThese apply to every session and worktree of this project, in addition to the repository's own AGENTS.md or CLAUDE.md files.\n\n"
          <> text
      }
    None -> base
  }
}

/// Save new rule text; the version advances only when the text changes.
pub fn updated(previous: Option(Rules), text: String, now: Int) -> Rules {
  let text = string.trim(text)
  case previous {
    Some(rules) if rules.text == text -> rules
    Some(rules) -> Rules(text, rules.version + 1, now)
    None -> Rules(text, 1, now)
  }
}

// -- Persistence ----------------------------------------------------------------

fn rules_decoder() -> decode.Decoder(Rules) {
  use text <- decode.field("text", decode.string)
  use version <- decode.field("version", decode.int)
  use updated_at <- decode.field("updatedAt", decode.int)
  decode.success(Rules(text, version, updated_at))
}

fn applied_decoder() -> decode.Decoder(Applied) {
  use project <- decode.field("project", decode.string)
  use version <- decode.field("version", decode.int)
  use instructions <- decode.field("instructions", decode.string)
  use applied_at <- decode.field("appliedAt", decode.int)
  decode.success(Applied(project, version, instructions, applied_at))
}

pub fn decode_state(text: String) -> State {
  let decoder = {
    use projects <- decode.optional_field(
      "projects",
      dict.new(),
      decode.dict(decode.string, rules_decoder()),
    )
    use threads <- decode.optional_field(
      "threads",
      dict.new(),
      decode.dict(decode.string, applied_decoder()),
    )
    decode.success(State(projects, threads))
  }
  json.parse(text, decoder)
  |> result.unwrap(State(dict.new(), dict.new()))
}

pub fn rules_json(rules: Rules) -> json.Json {
  json.object([
    #("text", json.string(rules.text)),
    #("version", json.int(rules.version)),
    #("updatedAt", json.int(rules.updated_at)),
  ])
}

pub fn encode_state(state: State) -> String {
  json.to_string(
    json.object([
      #("projects", json.dict(state.projects, fn(key) { key }, rules_json)),
      #(
        "threads",
        json.dict(state.threads, fn(key) { key }, fn(applied: Applied) {
          json.object([
            #("project", json.string(applied.project)),
            #("version", json.int(applied.version)),
            #("instructions", json.string(applied.instructions)),
            #("appliedAt", json.int(applied.applied_at)),
          ])
        }),
      ),
    ]),
  )
}

fn persist(path: String, state: State) -> Nil {
  let _ = simplifile.create_directory_all(filepath.directory_name(path))
  let _ = simplifile.write(path, encode_state(state))
  Nil
}

// -- Store ----------------------------------------------------------------------

pub opaque type Msg {
  GetRules(project: String, reply: Subject(Option(Rules)))
  SaveRules(project: String, text: String, now: Int, reply: Subject(Rules))
  Record(thread: String, applied: Applied)
  GetApplied(thread: String, reply: Subject(Option(Applied)))
}

pub type Store =
  Name(Msg)

/// One process owns the file, so concurrent requests cannot lose updates.
pub fn supervised(
  name: Store,
  path: String,
) -> supervision.ChildSpecification(Subject(Msg)) {
  supervision.worker(fn() {
    let initial =
      simplifile.read(path)
      |> result.map(decode_state)
      |> result.unwrap(State(dict.new(), dict.new()))
    actor.new(initial)
    |> actor.named(name)
    |> actor.on_message(fn(state: State, msg) {
      case msg {
        GetRules(project, reply) -> {
          process.send(
            reply,
            dict.get(state.projects, project) |> option.from_result,
          )
          actor.continue(state)
        }
        SaveRules(project, text, now, reply) -> {
          let rules =
            updated(
              dict.get(state.projects, project) |> option.from_result,
              text,
              now,
            )
          let state =
            State(
              ..state,
              projects: dict.insert(state.projects, project, rules),
            )
          persist(path, state)
          process.send(reply, rules)
          actor.continue(state)
        }
        Record(thread, applied) -> {
          let state =
            State(..state, threads: dict.insert(state.threads, thread, applied))
          persist(path, state)
          actor.continue(state)
        }
        GetApplied(thread, reply) -> {
          process.send(
            reply,
            dict.get(state.threads, thread) |> option.from_result,
          )
          actor.continue(state)
        }
      }
    })
    |> actor.start
  })
}

pub fn rules(store: Store, project: String) -> Option(Rules) {
  process.call_forever(process.named_subject(store), GetRules(project, _))
}

pub fn save_rules(
  store: Store,
  project: String,
  text: String,
  now: Int,
) -> Rules {
  process.call_forever(process.named_subject(store), SaveRules(
    project,
    text,
    now,
    _,
  ))
}

pub fn record(store: Store, thread: String, applied: Applied) -> Nil {
  process.send(process.named_subject(store), Record(thread, applied))
}

pub fn applied(store: Store, thread: String) -> Option(Applied) {
  process.call_forever(process.named_subject(store), GetApplied(thread, _))
}
