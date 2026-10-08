# yacwu

> [!NOTE]
> This repository continues development of [the original Yacwu by AFK-surf](https://github.com/AFK-surf/yacwu), with additional features and fixes. Credit to the original authors; their MIT license and copyright notice are preserved.

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
  reorder them, switch between them, browse archived sessions, restore them, or
  permanently delete them in a wider archive browser, and resume interrupted
  work. Clear session sits beside Archive in Session details: it starts an
  empty conversation with 0 conversation tokens, keeps the name, folder,
  model/thinking, profile, fast mode and list position, and archives the old
  history for restoration. The replacement stays hidden while being prepared,
  then appears in the original list position without a temporary new-session row.
  Empty sessions survive page refresh before their first prompt by recovering
  their verified, still-loaded Codex thread, even before Codex indexes it.
  Available after the session and its agents stop;
  previously consumed account allowance is unchanged
- ✅ Background completion indicators mark finished sessions until you open
  them, so completed work is easy to spot in the session list
- 🔒 In-use detection warns before opening a session another Codex process has
  loaded, helping prevent two processes from modifying the same conversation
- ⚡ Live streaming of assistant messages, reasoning, commands, plans, file
  changes, and current activity; send steering instructions while a turn runs,
  or stop and resume it later from the Resume button beside the stop note;
  that button disappears whenever the session starts another turn.
  manual stops are recorded in the transcript.
  A quiet-turn monitor posts a notice after two minutes without activity;
  it offers Keep waiting, Ask Codex for a status update, or Stop worker, and
  never stops a worker automatically
- ⏱️ The Session bar keeps the current prompt visible, puts task progress and
  time-left estimates before the Session label, and shows 5-hour / 7-day usage
  on the right, with reset countdowns and local reset dates/times on hover.
  Progress updates appear as their own transcript entries, while repeated
  identical estimates are omitted;
  elapsed time appears while work runs and on its completed response. The
  session list shows 0% until a running task reports progress, with time left
  estimated from elapsed task time on hover when the progress marker omits it.
- 🤝 Multi-agent visibility: switch between the session and spawned agents,
  see which agents are active, and browse finished agents in a separate
  Previous group; agent transcripts are read-only, and agent activity links
  jump directly to the corresponding transcript
- 🧠 Choose a model and reasoning effort per session.
  “Suggest settings” recommends an available model and supported thinking level
  for the draft prompt, explains its reasoning, and lets you apply both together.
  It uses local text heuristics (no allowance consumed), not project or attachment
  analysis; suggestions are starting points rather than guaranteed best choices.
  Model capability, usage-efficiency, and value indicators appear in the model
  choices. Value ratings emphasize capability per estimated 1% of Pro allowance used;
  these are rough Yacwu comparisons, not official benchmark scores. After
  selection, the picker shows only the model name. If you change models
  mid-turn, you can stop and restart the current prompt on the newly selected
  model without adding a duplicate prompt to the transcript
- 💸 Thinking-level choices show learned weekly allowance cost per 100k tokens
  for the selected model. Running task progress includes a projected total
  allowance cost from completion estimates, or elapsed/remaining time when
  progress is not yet available. Completed responses show estimated weekly
  allowance used and recorded token totals, including agent turns started
  under that prompt. Usage refreshes every 30 seconds and at turn boundaries;
  the open history dialog also refreshes automatically. One clean single-setting
  observation provides an explicitly provisional “early” rate with rounding
  uncertainty, for tasks with a broadly similar token mix. More independent
  evidence upgrades it to fitted costs; unrelated sparse or inseparable mixed
  models do not block a separately calibrated model.
  Partial recordings and insufficient calibration are labeled rather than
  assigned a fabricated percentage. If some contributing agent turns cannot
  be estimated, the header and completed response show the known subtotal
  marked “incomplete,” with a tooltip explaining the excluded turns. Incomplete
  subtotals are never projected as the full task cost.
  When a progress update omits its remaining time, Yacwu estimates it from the
  current turn's elapsed time or the rate between progress updates.
  Rereading a completed task after a collector restart preserves its recorded
  totals rather than marking that historical task as a new recording gap.
- 📊 Task usage history: click the weekly allowance or open it from Session
  details to inspect recorded model, thinking level, cumulative token deltas,
  elapsed time, and weekly allowance readings. Backend recording continues
  with the browser closed; pooled observations learn estimated weekly cost
  per model/thinking level, including overlapping turns. Separate token weights,
  indicative uncertainty ranges, and matching-account hosts improve estimates;
  combined observation windows group concurrent sessions and agents by model
  and thinking level, show their token contributions and runtime, and count
  each account allowance change once. Single-setting windows show a direct
  observed cost per 100k tokens; mixed, pending, and incomplete windows are
  identified separately, with model/thinking and concurrency filters.
  Agent spawn evidence recovers first-turn settings and token baselines even
  when the spawn receipt arrives late; completed-turn snapshots do not charge
  historical tokens to new work.
  Manual benchmarks provide bounded calibration workloads
- 💬 Interactive answers: completed questions and action requests open a prompt
  dialog; multiple choice blocks in one message are queued separately and remain
  queued while you answer earlier ones. Streamed partial text cannot close a
  question. Answers show confirmation after Codex accepts them, while the agent
  prepares a response.
  Answer or dismiss each to advance through the session's question queue,
  including requests from agents. Session question badges reflect that same
  unresolved queue, and dismissed questions stay dismissed after refresh.
  Choice lists require an adjacent request; report tables and code examples
  do not become question prompts
- 📁 Workspace browser rooted at the session folder, with a Monaco text editor
  (Ctrl/Cmd+S to save), file previews and copy actions, and clickable file
  links in assistant messages. The file and diff viewer state is kept per
  session, directory links expand their folder and preview/copy its listing,
  and worktree-prefixed file links select the corresponding diff
- ± Git changes inspector with All, Staged, and Unstaged scopes, added/removed
  line counts in both the inspector and transcript file-change entries, lazy
  unified diffs, and a resizable split view
- 🖼️ Attach images (PNG, JPEG, WebP, non-animated GIF), PDFs, and common
  text/code files through the picker or clipboard paste; image previews appear
  inline, while other files are staged temporarily and passed to Codex by path
- 🧭 Transcript position rail for jumping between messages, with a scroll-to-bottom
  control whenever the latest message is out of view
- 📋 Responses with file links offer **Copy files** beside the message copy
  button. It copies each unique file linked using Markdown in response order,
  with a filename heading followed by its contents. Plain paths in backticks
  and directory links are excluded. Unreadable files report an error and leave
  the clipboard unchanged.
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
- 🔗 Transcript links to absolute files open at their linked folder, including
  files outside the session's working directory
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
YACWU_BACKENDS="claude=node ./scripts/claude-backend.mjs ./claude-codex/dist/src/adapter.mjs" bun run start
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

Relative script paths resolve from the Yacwu project folder when using
`bun run start` or `bun run dev:server`. For other launchers, set
`YACWU_BACKEND_ROOT` to an absolute base directory; otherwise the launch
environment's `PWD` is used. Backend session working directories remain
independent of this script path.

Claude model catalogs hide the adapter's GPT/Codex proxy choices in the
model picker, suggestions and benchmark selection. Use a regular Codex
session for GPT models; Claude sessions keep their Claude choices.

The Claude launcher discovers the installed Agent SDK's supported models on
backend startup without submitting a prompt. It labels aliases with their
resolved versions (rather than hard-coding model releases), and disables
the adapter's Codex proxy. Discovery failures fall back to the adapter's
aliases; an explicit `CLAUDE_CODEX_MODELS` configuration is respected. The
adapter must be built with its SDK dependency installed before launching.
You can still invoke the adapter directly if you do not want discovery.

Claude sessions have a **Claude usage** shortcut to recorded task token counts
and runtime. Session details show the live reported total, input, cached-input
and output counters when received. These live counters may reset on adapter
restart; recorded task history is separate. The adapter does not supply Claude
account allowance percentages, so these are not equivalent to its subscription
usage meter.

Navigating into a folder in the new-session directory browser selects that
folder as the working directory, including for local Claude backends. You do
not need a second confirmation click before starting the session.

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

Test servers use a separate temporary usage directory so their collector
startup events do not invalidate live task recordings or calibration.

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

Yacwu also checks saved running tasks against backend runtime state every
15 seconds and on reconnect. Loaded-but-idle interrupted tasks (including
Claude tasks interrupted by adapter restarts) stop their activity timer and
show a recovery action and log the backend's interruption reason (or explicitly
state that no reason was reported). Failed reads retain the current state; silence alone
never stops a task that is still reported active.

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

### Task allowance analysis

Spawn receipts provide evidence of new agent counters and their initial
model/thinking settings, even if they arrive after the first turn. A matching
first `total` and `last` token reading can also establish a fresh counter.
Read/resume requests and their runtime replies are correlated automatically:
stored counters from confirmed idle reads establish initial baselines without
invalidating usage from other sessions. Active or failed reads, intervening
turn activity, and unexplained positive deltas remain incomplete; stale stored
snapshots cannot rewind a newer baseline. Existing-session totals remain
cumulative; connection gaps remain partial.

For older local recordings, `bun scripts/recover-usage.ts` previews repairs
using exact turn contexts, first-agent token readings, and completed-turn
snapshots from saved Codex rollouts. Add `--apply` to append verified metadata
without replacing the original history. Use `--since <ISO-date>` to limit the
period, `--usage-dir <path>` for another usage directory, or
`--codex-home <path>` for another local Codex home. Recovery excludes prompts
and responses and can be rerun without duplicating repairs. Remote histories
are not repaired by this local utility.

Usage metadata is stored per host in `$XDG_STATE_HOME/yacwu/usage` (default
`~/.local/state/yacwu/usage`); `YACWU_USAGE_DIR` overrides the directory. Files
are private, rotate at 20 MiB, and retain one previous file. Prompts, responses,
and tool output are excluded. Recording begins when the updated backend starts
and continues without an open browser. Quota snapshots are sampled every
30 seconds and at turn boundaries, along with live quota/token notifications.

The history window separates the account-wide weekly percentage change from a
task's estimated cost. Each row is one Codex turn; agents have separate rows.
Token counts use differences in cumulative usage, including cached input,
rather than the context-size counter. Existing turns without a known token
baseline, or turns interrupted by a recording gap, are marked partial.

Calibration pools readings until at least two percentage points are consumed
and token activity has been quiet for 60 seconds. Post-task readings allow a
settling period for delayed quota updates. It learns nonnegative weights for
uncached input, cached input, and output when independently identifiable;
reasoning is counted within output once. Insufficient or indistinguishable
token breakdowns use a labeled total-token fallback. Multiple independent
observations are required for fitted weights. Before that, clean single-setting
windows provide provisional total-token rates with explicit rounding ranges;
they do not invent costs from mixed-only evidence or extrapolate cached-heavy
samples to substantially different token mixes. Whole-percent differences are treated as ranges
(up to one percentage point either side), and displayed uncertainty combines
rounding and fit variation. The ranges are indicative, not guaranteed bounds.

Hosts with matching hashed account fingerprints share token evidence, using
the selected host as the single quota source to avoid double-counting readings.
An account ID is preferred when exposed; otherwise the fingerprint uses email,
account type, and plan. Raw email addresses are not stored. Unidentified hosts
remain separate; legacy host-only history remains available. Account, quota
bucket and plan changes keep calibration separate. Quota resets, recording
gaps and allowance changes without tracked tokens do not train the model.
Elapsed time is recorded for comparison; waiting on a tool does not imply token
consumption. Usage outside Yacwu can still affect shared allowance, so task
costs remain empirical estimates. Static model value ratings are unchanged.

The usage window includes a **Manual calibration benchmark** runner. Choose
a model, supported thinking level, weekly percentage-point target (2–5),
maximum turns (1–100), and maximum runtime (3–60 minutes). It creates a
dedicated read-only session with versioned text workloads covering explanations,
specifications and scheduling analysis. It samples quota every 10 seconds while
settling: at least 60 seconds for the baseline and 90 seconds after each turn,
with 60 seconds of unchanged readings required. Allowance reset timestamps may
vary by up to 60 seconds between reads without being treated as a new week;
larger changes stop the run. Usage changes restart the stability timer; a
backwards reading must recover to the highest reading seen. Sampling
stops after five minutes without stability. The runtime limit includes these
settling periods. The controls show elapsed time, time until the runtime limit,
completed turns and sampling status; turn-limit stops are labeled partial runs.
The estimator also requires stable quota readings before learning token costs.
Use **Models × Thinking levels** to check up to six model/thinking
combinations and run them sequentially. All thinking levels supported by each
model are available; Low and Medium remain selected by default. Economical mode targets 2
percentage points for the first selected combination, then 1 for each remaining
combination. With all six selected this is 7 points nominally. Disable
economical mode for 2 points each. Turn and runtime limits apply **per
combination**, including settling; six combinations can take up to six times
the selected runtime. The controls show the order, total target,
current combination and separate results with links to each benchmark session.
Each handoff carries the settled allowance baseline forward; if that reading
changes during the handoff, the batch stops rather than attributing the change
to the next model. A partial combination, error or manual stop prevents the
remaining combinations from starting. Isolated benchmark boundaries allow 1-point
observations without pooling different combinations or double-counting tokens.
Integer rounding uncertainty still applies; repeated sweeps may be needed for
identifiable token weights and sufficient samples.

Benchmarks consume allowance only after you explicitly start them. Pause other
Yacwu work first: a shared reservation permits only one benchmark across all
hosts. The runner refuses to start while tasks are active and stops
if other Yacwu work begins. It also stops at the observed target, turn/time
limit, manual Stop, or quota reset. Targets are checked between turns, so the
final turn can overshoot the requested allowance target. Closing the browser
does not stop the backend runner; restarting the backend ends it and never
restarts it automatically.

Quota stability is provisional, not a guarantee that accounting has finished.
Pause other use of the same account outside Yacwu as well; it cannot be detected
reliably. Benchmark samples and final summaries are saved with usage telemetry.
These runs measure allowance use, not model answer quality, and continuing the
same session includes growing context and cache reuse in the measurements.

## License

MIT
