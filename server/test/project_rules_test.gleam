import envoy
import filepath
import gleam/int
import gleam/option.{None, Some}
import gleeunit/should
import simplifile
import yacwu/git
import yacwu/project_rules.{Applied, Rules}

pub fn project_name_test() {
  project_rules.project_name("/home/u/Apps/growpilot/.git")
  |> should.equal("growpilot")
  project_rules.project_name("/home/u/scratch") |> should.equal("scratch")
}

pub fn instructions_test() {
  project_rules.instructions("base", None) |> should.equal("base")
  project_rules.instructions("base", Some(Rules("  ", 2, 0)))
  |> should.equal("base")
  let text =
    project_rules.instructions("base", Some(Rules("Reuse first.", 3, 0)))
  text
  |> should.equal(
    "base\n\n# Project rules (version 3, managed in Yacwu)\n\nThese apply to every session and worktree of this project, in addition to the repository's own AGENTS.md or CLAUDE.md files.\n\nReuse first.",
  )
}

pub fn version_advances_only_on_change_test() {
  let first = project_rules.updated(None, " Reuse first. ", 10)
  first |> should.equal(Rules("Reuse first.", 1, 10))
  project_rules.updated(Some(first), "Reuse first.", 20) |> should.equal(first)
  project_rules.updated(Some(first), "Reuse first. Explain why.", 30)
  |> should.equal(Rules("Reuse first. Explain why.", 2, 30))
}

pub fn state_round_trips_test() {
  let state =
    project_rules.decode_state(
      "{\"projects\":{\"local:/r/.git\":{\"text\":\"t\",\"version\":2,\"updatedAt\":5}},\"threads\":{\"th\":{\"project\":\"local:/r/.git\",\"version\":2,\"instructions\":\"i\",\"appliedAt\":6}}}",
    )
  project_rules.decode_state(project_rules.encode_state(state))
  |> should.equal(state)
  project_rules.decode_state("not json").projects
  |> should.equal(project_rules.decode_state("{}").projects)
}

/// Every worktree of a repository shares its Git directory, so one project.
pub fn worktrees_share_a_project_identity_test() {
  let base =
    envoy.get("TMPDIR")
    |> fn(dir) {
      case dir {
        Ok(d) -> d
        _ -> "/tmp"
      }
    }
  let root =
    filepath.join(
      base,
      "yacwu-project-rules-" <> int.to_string(int.random(1_000_000_000)),
    )
  let main = filepath.join(root, "main")
  let other = filepath.join(root, "other")
  let assert Ok(_) = simplifile.create_directory_all(main)
  let repo = git.local_repo(main)
  let assert Ok(#(0, _)) = repo.exec(["init", "-q"])
  let assert Ok(#(0, _)) =
    repo.exec([
      "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q",
      "--allow-empty", "-m", "init",
    ])
  let assert Ok(#(0, _)) = repo.exec(["worktree", "add", "-q", other])
  let assert Ok(main_dir) = git.common_dir(repo)
  git.common_dir(git.local_repo(other)) |> should.equal(Ok(main_dir))
  project_rules.project_name(main_dir) |> should.equal("main")
  // A separate clone, even one named like the original, is its own project.
  let clone = filepath.join(root, "elsewhere/main")
  let assert Ok(#(0, _)) = repo.exec(["clone", "-q", main, clone])
  let assert Ok(clone_dir) = git.common_dir(git.local_repo(clone))
  clone_dir |> should.not_equal(main_dir)
  project_rules.project_name(clone_dir) |> should.equal("main")
  let _ = simplifile.delete(root)
  Nil
}

fn local_backend(host: String) -> Bool {
  host == "claude"
}

/// Codex ("local") and Claude (a local backend) sessions in one repository
/// share its rules; remote hosts and other repositories do not.
pub fn backends_on_this_machine_share_a_project_test() {
  let codex = project_rules.project_key("local", "/r/growpilot/.git")
  project_rules.machine_key(codex, local_backend) |> should.equal(codex)
  project_rules.project_key("claude", "/r/growpilot/.git")
  |> project_rules.machine_key(local_backend)
  |> should.equal(codex)
  project_rules.project_key("pi", "/r/growpilot/.git")
  |> project_rules.machine_key(local_backend)
  |> should.equal("pi:/r/growpilot/.git")
  project_rules.project_key("claude", "/r/yacwu/.git")
  |> project_rules.machine_key(local_backend)
  |> should.not_equal(codex)
}

pub fn status_test() {
  let project = "local:/r/growpilot/.git"
  let applied = fn(key, version) { Some(Applied(key, version, "", 0)) }
  project_rules.status(None, project, 1, local_backend)
  |> should.equal("unknown")
  project_rules.status(applied(project, 1), project, 1, local_backend)
  |> should.equal("current")
  project_rules.status(applied(project, 0), project, 1, local_backend)
  |> should.equal("outdated")
  // Claude sessions recorded before keys were shared per machine.
  project_rules.status(
    applied("claude:/r/growpilot/.git", 0),
    project,
    1,
    local_backend,
  )
  |> should.equal("outdated")
  project_rules.status(
    applied("local:/r/yacwu/.git", 1),
    project,
    1,
    local_backend,
  )
  |> should.equal("otherProject")
}
