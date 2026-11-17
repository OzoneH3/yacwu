# Native Windows Codex conversion

## Implemented scope

Yacwu implements a foreground source installation for Windows 11 x64,
with local Codex as its only backend. The Gleam/OTP server and Svelte UI remain
the application architecture. Start it with `start.ps1` after installing the
prerequisites listed in the README.

The standard local Codex transport was already stdio. The Windows port reuses
it through `scripts/codex-stdio.mjs`, launched directly by Erlang through Node.
The bridge resolves a native executable or the standard npm Codex JavaScript
entry point, passes arguments without a shell, preserves stdout for JSON-RPC,
and captures stderr separately. `YACWU_CODEX_BIN` can select another native
Codex executable. This handles both global npm installs and local `.bin` shims.

Windows uses child processes owned by the foreground server. Closing the stdio
port triggers termination of the Codex process tree with `taskkill /T /F`.
An interrupted turn is subject to the existing bounded recovery mechanism on
restart; it does not continue uninterrupted while Yacwu is stopped. Saved
sessions remain in Codex's own home.

Windows ignores alternative backend configuration and persistent mode. The
host picker offers local Codex, and SSH requests are rejected explicitly.
Persistent daemons, SSH hosts, Windows services, packaging, and native in-use
session detection remain outside this foreground release. Unix retains its
existing transports and providers.

## Changes by area

| Area | Implementation |
| --- | --- |
| Launch | `start.ps1` checks prerequisites and builds; `scripts/run-server.mjs` supplies paths and forwards server arguments without POSIX environment assignments. |
| Process transport | `yacwu_platform.erl` starts a Node stdio bridge on Windows; Unix keeps its existing launcher. |
| Paths | Host helpers recognize drives and UNC shares; workspace-relative API paths use a platform-independent traversal check. Windows device names, alternate streams, and ambiguous drive-relative folder paths are rejected. |
| State | `XDG_STATE_HOME` overrides the state root; Windows defaults to `%LOCALAPPDATA%`, with Yacwu files under `yacwu`. Home comes from `USERPROFILE`; `CODEX_HOME` remains independently configurable. |
| Uploads | Local uploads use `TMPDIR`, then `TEMP`, then `TMP`, with an OS-specific fallback. |
| UI | Folder parents preserve drive/share roots. Transcript links accept Windows paths, spaces, and Unicode. Remote access controls follow server capabilities. |
| Relay | PowerShell instructions use `$env:YACWU_RELAY_CLI`. Credential files and their dedicated directory receive an ACL for the current Windows user before the credential is written. ACL failure disables the agent relay. |
| Permissions | Existing read-only policies remain enforced at thread start/resume/fork and turn start. No Windows fallback widens a read-only session. |

## Validation

Local Linux checks passed: production build, Svelte type checks, 71 portable
backend tests, 20 path/Markdown/relay unit tests, two Node bridge tests, and
two Playwright browser tests. The Windows child-tree test is skipped on Linux. A real
Codex initialization and thread-list smoke test uses an isolated home and does
not submit an inference request.

The Windows CI job builds the UI and server, runs the portable backend suite,
checks PowerShell syntax and actual ACL operations, tests child-tree shutdown,
initializes a real npm-installed Codex, and runs browser path tests. Linux-only
fixtures (`/proc`, Unix sockets, Bash stubs) remain in the existing Linux job.
The portable suite also checks read-only policy persistence across resume,
fork, and manager recreation using a protocol fixture.

The user confirmed successful Windows startup on 2026-11-17. Windows CI and
a Windows desktop have not been executed from this Linux workspace. The full
native acceptance checklist remains pending; startup confirmation and Linux
tests do not establish Windows sandbox enforcement or lifecycle behavior.

## Native acceptance checklist

- [ ] Windows CI passes on the branch.
- [ ] On Windows 11 x64, install Node 24+, Bun 1.3+, Gleam 1.18+, OTP 27+,
  rebar3 and Git; install Codex, log in, and run `start.ps1` from a path with
  spaces and Unicode.
- [ ] Create, stream, steer, interrupt, resume, fork, archive and restore a
  session; inspect files/diffs and upload images and text.
- [ ] Browse a drive root and a reachable UNC share; open transcript links
  and verify traversal and alternate-stream inputs are rejected.
- [ ] Set up the native Codex sandbox; verify a read-only turn cannot create,
  modify or delete a file, including after resume/fork/restart. Setup failure
  must remain an error. Follow the [official Windows sandbox documentation](https://learn.chatgpt.com/docs/windows/windows-sandbox).
- [ ] Send a relay message between two Codex sessions from PowerShell; verify
  active delivery, idle queuing, restart persistence and credential ACLs.
- [ ] Close the foreground server during a command with a child process;
  confirm the process tree exits, saved state survives, and subsequent startup
  applies the documented recovery behavior.

## Later work

Persistent Windows backends need a separate lifecycle design and transport
selection. Background service installation and packaged releases follow native
foreground acceptance. Claude and Copilot Windows integrations require their
own projects and are not enabled by this implementation.
