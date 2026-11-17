# Windows conversion plan (Codex only)

## Goal and scope

Run Yacwu natively on supported 64-bit Windows with the Codex CLI as its only
agent backend. Preserve the browser UI, session management, Codex app-server
features, workspace browser, file changes view, local history, and normal
Codex login. Do not make Claude Code or GitHub Copilot work on Windows in this
project phase; retain their current behavior on supported Unix hosts.

The first milestone is a source checkout launched by PowerShell, not an
installer or packaged desktop app. Windows 11 is the initial validation target.
Record exact supported Windows, Node/Bun, Gleam, and OTP versions after
prototyping the server toolchain.

## Current platform assumptions to resolve

- Codex currently launches with a Unix-domain socket. Check the installed
  Windows Codex app-server transport and choose its supported local transport
  (prefer loopback TCP if Unix sockets are not supported). Keep the transport
  behind a platform-neutral interface; do not expose an unauthenticated
  listener beyond loopback.
- The server is written in Gleam and requires Erlang/OTP plus `rebar3`. Prove
  this toolchain can build and run reliably on Windows before broad porting.
  If it cannot, evaluate a small Windows host/runtime replacement while
  preserving the existing API and browser client.
- `start.sh`, `scripts/install-service.sh`, release packaging, and AppImage
  scripts are Unix-specific. Add a PowerShell foreground launcher first;
  service installation and packaging are later milestones.
- Several state paths assume `$HOME`, XDG directories, `/tmp`, or Unix
  permissions. Centralize Yacwu state/config/cache resolution and use Windows
  known folders, while honoring existing environment overrides.
- Runtime helpers use `/proc`, Unix signals, Unix sockets, `pkill`, and shell
  commands. Inventory each helper and provide a Windows implementation or
  disable a feature with a clear explanation.
- Normalize path handling around Node/Gleam path libraries. Preserve drive
  letters and UNC paths, handle case-insensitive comparisons, and avoid
  assuming `/` separators or Unix executable permissions.

## Phased work

### 1. Prove the native Codex path

- On a clean Windows 11 machine, install the supported Node/Bun and Gleam/OTP
  toolchains and the Codex CLI; complete `codex login`.
- Build the Gleam service and UI, launch Codex app-server, and establish a
  local connection using the transport supported by the Windows CLI.
- Verify one new session, one resumed session, streaming, stop/continue,
  file reads/writes, diff display, and app shutdown/restart.
- Document any Codex CLI feature gaps or version requirements before choosing
  a transport or runtime redesign.

### 2. Remove platform assumptions from the Codex server path

- Separate app-server transport selection from session logic; configure local
  loopback TCP or the supported Windows transport without changing API
  semantics.
- Replace shell-dependent start/dev commands with PowerShell scripts and
  cross-platform package scripts; keep Unix launchers working.
- Centralize config/state/cache locations and path comparisons, including
  `CODEX_HOME`, project directories, `.workspace`, logs, and temporary files.
- Audit process lifetime, child process termination, environment inheritance,
  process inspection, and file watching on Windows.
- Make Codex-only app flows avoid loading Claude/Copilot-specific runtime
  helpers; keep Unix-only optional backend integrations isolated.

### 3. Windows validation and UX

- Add Windows CI for dependency installation, UI build/type check, Gleam build,
  and focused server tests. Add Windows-specific tests for path handling,
  transport, process shutdown, and file operations.
- Run an end-to-end smoke test on Windows covering login, create/resume, live
  output, stop, file browser/edit, git changes, and clean restart.
- Check browser file picker paths, drag/drop attachments, clipboard images,
  Monaco editor behavior, and long Windows paths.
- Update README requirements and startup instructions only after the native
  workflow succeeds. State clearly that Claude and Copilot remain unsupported
  on Windows until separately ported.

### 4. Optional distribution

- Decide between a documented source install, a PowerShell bootstrapper, and
  a packaged release based on toolchain results and user demand.
- If packaging, define upgrade behavior, data preservation, log collection,
  firewall binding (loopback by default), and uninstall behavior.
- Add Windows service/background startup only after foreground operation and
  clean shutdown are dependable.

## Acceptance criteria

- A Windows user can follow documented steps to install prerequisites, log
  into Codex, start Yacwu, and use core Codex session workflows without WSL.
- The server binds only to loopback by default and connects to the local Codex
  app-server using a supported Windows transport.
- Project paths with spaces, drive letters, and UNC paths are handled correctly
  in session creation, file operations, and Git changes.
- Restarting Yacwu does not orphan Codex processes or lose persisted Yacwu
  state; running Codex work follows documented restart semantics.
- Windows CI and the manual end-to-end checklist pass. Unix behavior and the
  existing Unix packaging workflow remain intact.

## Initial investigation checklist

1. Confirm current Codex CLI installation and app-server transport on Windows.
2. Build Gleam/OTP server on Windows and identify any failing dependencies or
   FFI assumptions.
3. Inventory server FFI and runtime references to `/proc`, `/tmp`, Unix
   sockets, process signals, shell commands, `chmod`, and XDG paths.
4. Select state/config known-folder defaults and define override precedence.
5. Prototype a PowerShell foreground launch and document the verified steps.
