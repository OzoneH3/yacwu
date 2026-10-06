# yacwu

**Yet Another Codex Web UI** — a focused, editorial web front-end for
[Codex](https://developers.openai.com/codex), with a **Gleam (BEAM/OTP)**
backend and a **Svelte** SPA front-end.

It talks to Codex over the [app-server protocol](docs/codex-app-server.md)
(JSON-RPC 2.0 over stdio) and keeps **no database of its own** — multi-session
state lives entirely in Codex's own persistent sessions, read back via
`thread/list` / `thread/read` and continued via `thread/resume`.

## Features

- 🖥️ Light and dark themes, with a responsive workspace for desktop and mobile
- 🧵 Multi-session workspace: create sessions in chosen folders, rename and
  reorder them, switch between them, browse archived sessions and restore them,
  and resume interrupted work
- ✅ Background completion indicators mark finished sessions until you open
  them, so completed work is easy to spot in the session list
- 🔒 In-use detection warns before opening a session another Codex process has
  loaded, helping prevent two processes from modifying the same conversation
- ⚡ Live streaming of assistant messages, reasoning, commands, plans, file
  changes, and current activity; send steering instructions while a turn runs,
  or stop and resume it later; manual stops are recorded in the transcript.
  A quiet-turn monitor posts a notice after two minutes without activity but
  never stops the worker
- ⏱️ The Session bar keeps the current prompt visible, puts task progress and
  time-left estimates before the Session label, and shows 5-hour / 7-day usage
  on the right. Progress updates appear as their own transcript entries;
  elapsed time appears while work runs and on its completed response. The
  session list shows 0% until a running task reports progress, with time left
  available on hover once estimated
- 🤝 Multi-agent visibility: switch between the session and spawned agents,
  see which agents are active, and browse finished agents in a separate
  Previous group; agent transcripts are read-only, and agent activity links
  jump directly to the corresponding transcript
- 🧠 Choose a model and reasoning effort per session. Model capability,
  usage-efficiency, and value indicators appear in the model choices; after
  selection, the picker shows only the model name. These are Yacwu display
  estimates, not official benchmark scores. If you change models mid-turn, you
  can stop and restart the current prompt on the newly selected model
- 💬 Interactive answers: direct questions and questions with listed options
  open a prompt dialog; answer or dismiss each to advance through the session's
  question queue, including questions from its agents
- 📁 Workspace browser rooted at the session folder, with a Monaco text editor
  (Ctrl/Cmd+S to save), file previews and copy actions, and clickable file
  links in assistant messages. The file and diff viewer state is kept per
  session, and worktree-prefixed file links select the corresponding diff
- ± Git changes inspector with All, Staged, and Unstaged scopes, added/removed
  line counts in both the inspector and transcript file-change entries, lazy
  unified diffs, and a resizable split view
- 🖼️ Attach images (PNG, JPEG, WebP, non-animated GIF), PDFs, and common
  text/code files through the picker or clipboard paste; image previews appear
  inline, while other files are staged temporarily and passed to Codex by path
- 🧭 Transcript position rail for jumping between messages in long sessions
- ⌨️ Composer slash commands (see below), message copy buttons, and Up/Down
  prompt history with the Codex TUI's shell-style recall semantics
- 🎛️ Per-session codex profiles: pick a `$CODEX_HOME/<name>.config.toml` when
  creating a session (or with `/profile`)
- 🧾 Queue follow-up work with `/todo <task>`; queued tasks start one at a time
  after the current turn, and `/todo` shows the queue with progress numbering
  that includes an already-running prompt
- 🔁 Alternative backends: `YACWU_BACKENDS` registers other local app-server
  commands (e.g. [claude-codex](https://github.com/fuergaosi233/claude-codex))
  that appear in the host picker alongside the default local codex
- 🔌 One `codex app-server` connection per machine, multiplexed; events fan
  out to the browser via Server-Sent Events
- 🌐 Remote machines over SSH: pick any concrete `Host` alias from
  `~/.ssh/config` when creating a session. yacwu bootstraps a **persistent**
  app-server on the remote machine (`--listen unix://` + streamlocal
  forwarding — no TCP ports), and reconnects with backoff after SSH drops or
  yacwu restarts while remote turns keep running. Full feature parity: the
  file browser, Git viewer, images, profiles, and in-use detection all
  operate on the remote machine. See [docs/remote.md](docs/remote.md)
- 🗄️ No storage layer — Codex is the source of truth

## Slash commands

Type these in the composer (anything not starting with `/` is a normal model turn):

| command | action |
| --- | --- |
| `/status` | show account, rate limits & session info |
| `/model` | show the current model, reasoning effort, and available choices |
| `/model <model> [effort]` | change the model and optional reasoning effort (`--effort <effort>` changes effort only) |
| `/profile` | show the session's codex profile and the available choices |
| `/profile <name>` / `/profile clear` | switch this session to a profile / back to the base config |
| `/goal <objective>` | set the thread goal (`--budget N` to add a token budget) |
| `/goal` / `/goal clear` | show / clear the current goal |
| `/todo <task>` | queue a follow-up task to start after the current task |
| `/todo` | show queued tasks and their status |
| `/todo clear` | clear queued tasks that have not started |
| `/compact` | compact conversation history |
| `/review [notes]` | review uncommitted changes (or run a custom review) |
| `/shell <command>` | run a user-initiated shell command in the thread |
| `/rollback [turns]` | roll back the last N turns (default 1) |
| `/fork` | branch this thread into a new session |
| `/btw [question]` | start an ephemeral side conversation (a throwaway fork that treats inherited history as read-only context; nested under its parent in the sidebar) |
| `/archive` | archive this session |
| `/help` | list the commands |

## Requirements

- [Gleam](https://gleam.run) ≥ 1.18 with Erlang/OTP ≥ 27 (and `rebar3` on
  `PATH` for compiling one transitive Erlang dependency) — `.tool-versions`
  pins the versions for [asdf](https://asdf-vm.com) users
- [Bun](https://bun.sh) ≥ 1.3 (builds the web UI)
- [`codex`](https://developers.openai.com/codex) CLI on `PATH`, already
  authenticated (`codex login`)

## Run

```bash
bun install
bun run build                              # build the web UI into ./build
YACWU_INSECURE_SKIP_AUTH=1 bun run start   # serve UI + API on http://127.0.0.1:3000
```

`bun run start` runs the Gleam server (`server/`), which serves the static UI
build, the REST/SSE API, and spawns/manages one `codex app-server` process
(plus one per configured [alternative backend](#alternative-backends)). The server fails closed: it refuses to start unless authentication
is configured (see [Authentication](#authentication)) or
`YACWU_INSECURE_SKIP_AUTH=1` explicitly opts into running open, as above for
a localhost-only setup. The listening address is configurable:

```bash
cd server
gleam run -- 0.0.0.0:8080            # positional host:port
gleam run -- --host 0.0.0.0 --port 8080
gleam run -- --unix /run/yacwu.sock  # Unix domain socket instead of TCP
gleam run -- --help
```

The server accepts `-H/--host`, `-p/--port`, a positional `host:port`, or
`--unix <path>` (CLI flags override the `HOST`/`PORT` env vars). `YACWU_CWD`
selects the working directory for new sessions; `YACWU_STATIC` points at the
web UI build directory (default `./build`, relative to where the server runs —
the `bun run` scripts set it for you). Set `YACWU_DEBUG=1` for a per-request
timing log on stderr.

### Alternative backends

Anything that speaks the codex app-server protocol over stdio can stand in
for `codex app-server` — for example
[claude-codex](https://github.com/fuergaosi233/claude-codex), which serves
the protocol backed by Claude Code. Declare such backends with
`YACWU_BACKENDS`, semicolon-separated `name=command` entries:

```bash
YACWU_BACKENDS="claude=node /opt/claude-codex/dist/src/adapter.mjs" bun run start
```

Each name appears in the host picker alongside the default local codex
(`local`) and the SSH remotes, and runs its command as a child process on
this machine — same working directory, file browser, Git viewer, profiles and
in-use detection as the default. Sessions started on a backend are listed and
resumed through that backend, and merge into the session rail with everyone
else's. The command is split on whitespace (no quoting) and resolved via
`/usr/bin/env`, so bare program names use `PATH` and absolute paths work
as-is. Names must be URL-safe (letters, digits, `.-_@`) and may not be
`local`; a backend name shadows an identical `~/.ssh/config` alias.

For a deployable artifact, `cd server && gleam export erlang-shipment`
produces a self-contained BEAM release (needs only Erlang on the target), and
`bun run build` supplies the static `build/` directory to serve next to it.

## Release tarball

```bash
./scripts/build-release.sh    # produces dist/yacwu-<version>.tar.gz
```

Uses the local toolchain (no Docker): the backend becomes a single-file
escript (`gleam export escript`) bundled with the web UI build and a `yacwu`
launcher. The result is portable BEAM bytecode — the target machine needs a
compatible Erlang/OTP (≥ the version pinned in `.tool-versions`) and the
`codex` CLI, but no Gleam or Bun:

```bash
tar -xzf yacwu-1.0.0.tar.gz
./yacwu/yacwu 0.0.0.0:8080
```

## AppImage

```bash
./scripts/build-appimage.sh   # produces dist/yacwu-<architecture>.AppImage
```

Requires Docker (or podman with the docker CLI shim). The whole build runs in
an Ubuntu 20.04 (glibc 2.31) container so the resulting AppImage works on
distros at least that old: it pulls the prebuilt Erlang/OTP for that distro
from hex.pm's build service (the same builds `erlef/setup-beam` uses), exports
the backend with `gleam export erlang-shipment`, and bundles the Erlang
runtime, the web UI build, and the non-glibc shared libraries the runtime
needs (libssl, libtinfo, …). Both x86_64 and aarch64 Docker hosts are
supported; the output uses the corresponding architecture in its filename.

```bash
./dist/yacwu-$(uname -m).AppImage --help
./dist/yacwu-$(uname -m).AppImage 0.0.0.0:8080
```

The AppImage accepts the same flags/env as the server. It still needs the
`codex` CLI on `PATH` at runtime (and `libfuse2`, like any AppImage — or run
it with `--appimage-extract-and-run`).

## Develop

```bash
bun install
YACWU_INSECURE_SKIP_AUTH=1 bun run dev:server
                     # Gleam API backend on http://127.0.0.1:3000
bun run dev          # Vite dev server on http://127.0.0.1:5173 (proxies /api)
```

The front-end dev server proxies `/api/*` (including the SSE stream) to the
backend, so edit Svelte code with hot reload while the Gleam server runs
unchanged. Set `YACWU_API` to proxy to a backend on a different address.

## Authentication

Two mechanisms, usable separately or together. The server fails closed: with
neither configured it refuses to start (and rejects every request with `403`)
unless `YACWU_INSECURE_SKIP_AUTH=1` explicitly opts into running without
authentication — only do that on a trusted network, e.g. bound to localhost.

### Forward auth

Put yacwu behind a reverse proxy that authenticates users and injects a
`Remote-User` header (Authelia, Traefik forward-auth, oauth2-proxy, …). Pass
an allowlist to require that header:

```bash
cd server
gleam run -- --remote-user alice,bob  # or: YACWU_REMOTE_USERS=alice,bob
```

When enabled, every request must carry `Remote-User: <user>` matching one of the
listed users — otherwise it's rejected (`401` if the header is missing, `403` if
the user isn't allowed). This is enforced for pages, the API, and static assets.
When unset, forward auth is disabled.

### Built-in OAuth login

yacwu can also authenticate users itself against an OAuth 2.0 / OpenID Connect
provider (authorization code flow with PKCE), so no authenticating proxy is
needed:

```bash
cd server
YACWU_OAUTH_ISSUER=https://auth.example.com \
YACWU_OAUTH_CLIENT_ID=yacwu \
YACWU_OAUTH_CLIENT_SECRET=... \
YACWU_OAUTH_USERS=alice,bob \
gleam run
```

Register `https://<your-yacwu-host>/oauth/callback` as the redirect URI with
the provider. Unauthenticated page loads bounce to the provider's login page;
after the callback the user stays signed in via an HMAC-signed `yacwu_session`
cookie — stateless, like everything else in the server. API requests without a
valid session get a plain `401`. `/oauth/logout` signs out.

| variable | meaning |
| --- | --- |
| `YACWU_OAUTH_ISSUER` | OIDC issuer; endpoints found via `/.well-known/openid-configuration` |
| `YACWU_OAUTH_AUTH_URL` / `YACWU_OAUTH_TOKEN_URL` | explicit endpoints (override discovery; both required when no issuer is set) |
| `YACWU_OAUTH_USERINFO_URL` | userinfo endpoint, used when the provider issues no usable id_token |
| `YACWU_OAUTH_CLIENT_ID` / `YACWU_OAUTH_CLIENT_SECRET` | client credentials registered with the provider |
| `YACWU_OAUTH_SCOPES` | requested scopes (default `openid profile email`) |
| `YACWU_OAUTH_USER_CLAIM` | claim holding the user identity (default: first of `preferred_username`, `email`, `login`, `sub`) |
| `YACWU_OAUTH_USERS` | comma-separated identity allowlist; empty admits any authenticated user |
| `YACWU_OAUTH_REDIRECT_URL` | explicit callback URL, when the one derived from `X-Forwarded-Proto` / `X-Forwarded-Host` / `Host` is wrong |
| `YACWU_OAUTH_COOKIE_SECRET` | cookie-signing secret; auto-generated per process when unset (sessions then survive only until a restart) |
| `YACWU_OAUTH_SESSION_TTL` | session lifetime in seconds (default `604800`, 7 days) |

Plain OAuth 2.0 providers without OIDC work via explicit endpoints — GitHub,
for example:

```bash
YACWU_OAUTH_AUTH_URL=https://github.com/login/oauth/authorize \
YACWU_OAUTH_TOKEN_URL=https://github.com/login/oauth/access_token \
YACWU_OAUTH_USERINFO_URL=https://api.github.com/user \
YACWU_OAUTH_SCOPES=read:user \
YACWU_OAUTH_CLIENT_ID=... YACWU_OAUTH_CLIENT_SECRET=... \
YACWU_OAUTH_USERS=octocat \
gleam run
```

When both mechanisms are configured, a valid `Remote-User` header or a valid
session cookie admits the request; anything else is sent through the OAuth
login.

## Other commands

```bash
bun run check        # svelte-check / TypeScript (front-end)
bun run test:unit    # front-end unit tests (bun test)
bun run test:server  # backend unit tests (gleeunit)
bunx playwright test # end-to-end verification (builds the UI, runs the Gleam server, drives the live app)
```

## Architecture

```
browser ──HTTP/SSE──> Gleam server (mist, server/)
                         │  server/src/yacwu/codex.gleam  (JSON-RPC manager actor)
                         └──stdio──> codex app-server ──> Codex sessions on disk
```

- `server/src/yacwu/codex.gleam` — OTP actor owning the single
  `codex app-server` port: correlates request/response ids, broadcasts
  notifications to SSE subscribers, respawns the process if it exits.
- `server/src/yacwu/router.gleam` — thin REST/SSE endpoints over the protocol
  (`/api/threads`, `/api/threads/[id]/open|message|interrupt`, `/api/events`),
  plus static serving of the built SPA with an `index.html` fallback.
- `server/src/yacwu/oauth.gleam` — the built-in OAuth/OIDC login: endpoint
  discovery, PKCE, the code-for-token exchange, and the signed session
  cookies backing it (no server-side session storage).
- `server/src/yacwu/session_lock.gleam` — detects whether another codex
  process has a session's rollout file open before we resume it.
- `server/src/yacwu/model_state.gleam` — per-thread model/effort overrides and
  the model catalog.
- `src/routes/+layout.svelte` — the terminal-style UI; routes streamed events
  to the right session by `threadId`.

The backend is pure Gleam: interop with the VM (spawning the codex port,
`/proc` symlink reads, Unix sockets) goes through typed `@external` bindings
to Erlang built-ins — no Erlang source files, no NIFs.

Threads run in "yolo" mode — `approvalPolicy: "never"` and
`sandbox: "danger-full-access"` — so the web UI never blocks on an interactive
approval prompt and commands run with full access.

### Per-session profiles

codex profiles are `$CODEX_HOME/<name>.config.toml` files layered over the
base config — but codex only applies them via the `--profile` CLI flag, which
doesn't work with `codex app-server`, and the app-server protocol has no
profile parameter. yacwu emulates the layering per-thread: the chosen
profile file is parsed and passed as the generic `config` override map on
`thread/start` / `thread/resume` (plus the profile's model/effort on
`turn/start`). Explicit request params beat that map, so yacwu's forced
`approvalPolicy: "never"` survives any profile, and an explicit `/model`
override wins over the profile's model.

Profile files are re-read from disk on every request — nothing is cached, so
edits take effect immediately. Which profile a session uses is remembered
in-memory; after a server restart it is re-inferred as the profile whose
`model` matches the session's current model, if any.

### In-use detection

codex keeps an open file descriptor on a session's rollout `.jsonl` for as long
as the thread is loaded (resumed) — even while idle. Before resuming, the open
endpoint checks whether any process (outside our own app-server's process tree)
holds that path open; if one exists it returns `409` and the UI shows a warning
with the offending process so you can cancel or "open anyway".

The scan is platform-specific: on Linux it reads `/proc/*/fd` symlinks; on
OpenBSD (which has no `/proc`) it runs `fstat(1)` on the rollout file and
`ps` for the process tree. Other platforms degrade to no detection rather
than blocking.

### Unix socket listening

`--unix <path>` accepts connections on a Unix domain socket and relays them
byte-for-byte to the HTTP listener bound on a loopback ephemeral port (mist
itself only speaks TCP). HTTP, SSE, and auth headers/cookies pass through
unchanged.

### Stalled-task diagnostics

Yacwu records Codex RPC timing, lifecycle event metadata, connection changes,
and browser Stop/SSE observations automatically. Every 30 seconds it records a
manager snapshot with pending request ages, active turn activity, subscriber
count, and the local Codex process ID. On Linux, snapshots also include
process state, CPU counters, thread count, and resident memory pages. A turn without an event for two minutes
produces a `turn_silent` snapshot, repeated at most once every two minutes.
Silence can also mean legitimate reasoning or a long-running tool; Yacwu does
not cancel the turn automatically.

Logs live in `$XDG_STATE_HOME/yacwu/diagnostics` (default
`~/.local/state/yacwu/diagnostics`). Set `YACWU_DIAGNOSTICS_DIR` to override it.
Each host has a `codex-*.jsonl` metadata log and a `codex-*.stderr.log` log.
Metadata rotates at 5 MiB; local child stderr is checked every 30 seconds and
retains the last 5 MiB in `.1` before truncating in place. Each log keeps one
previous file. The directory is mode 0700 and files are mode 0600. Log write
failures do not prevent requests from running.

The metadata log excludes prompts, command output, and streamed text. The
local Codex child's stderr is retained separately and can contain Codex's own
error details. `RUST_LOG` defaults to `info` for newly spawned local children
and respects an existing override. Remote Codex stderr stays on the remote
host; local connection/RPC diagnostics are still recorded.

To inspect a stalled session without waiting for a Codex RPC, read
`GET /api/threads/<session-id>/diagnostics` (add `?host=<host>` for remote
routing). This uses the same authentication as the other API endpoints and
returns the manager snapshot and exact log paths. Correlate its turn and
request IDs with the retained logs and Codex's session transcript. It can
separate an unresponsive RPC, disconnected transport, missing browser events,
and a silent turn, but cannot guarantee an explanation for an internal model
or upstream service stall.

Backend diagnostics take effect after restarting Yacwu; local stderr capture
starts with the next local child. Let active tasks finish before restarting a
server that owns their Codex child. Reload the browser after rebuilding.

## License

MIT
