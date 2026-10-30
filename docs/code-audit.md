# Code consolidation audit

Reviewed 2026-10-30 against `d3a6b4c`.

## Scope and method

The inventory covered 142 tracked production source/script files and 326 source,
script and test files in total. Reference searches, TypeScript syntax inspection,
exact function/block duplicate searches, and compiler unused-local/parameter
checks were followed by manual review of the candidates and their callers.
Frontend Svelte/TypeScript, Gleam/Erlang server modules, backend wrapper scripts,
and build entry points were included. The separate, untracked `claude-codex`
checkout and generated output were excluded from consolidation.

This is an unused-code and duplication audit, not proof that every branch is
reachable or a security/performance certification. Dynamic protocol dispatch,
Erlang foreign functions, Svelte routes, and script entry points require callers
beyond ordinary imports. No complete user-facing feature was proven unused.

## Consolidated

| Finding | Change |
| --- | --- |
| Settled usage observations and unfinished previews contained identical pool construction | Both use `buildUsagePool`; contributors are indexed once by model/effort instead of filtering all contributors for each group. Window accounting, worker overlap, and benchmark flags are retained. |
| Image and document staging repeated local/remote directory selection and file writes | One `store_upload` path handles storage; format validation remains specific to each input type. |
| Relay metadata and full-turn recovery repeated request/error/generation handling | One parameterized `read_active_turn` function; the full-turn fallback still runs only for inconclusive metadata, never across a connection change or request failure. |
| File browser independently decoded Git line statistics | It uses `indexFileLineStats`, as transcript changes do. This also fixes missing counts for `./` and workspace-absolute paths and retains binary markers. |
| Pointer and keyboard tooltip exits had identical implementations | One `onTooltipOut` handler for both event types. |
| `agentsForSession` survived only in tests after the UI switched to an agent index | Removed it and moved its nesting/root/order assertions to `indexAgentsBySession`, the production implementation. |
| `claudeBackendHost` survived only in tests after generic provider support | Removed it; provider lookup assertions now exercise `providerHost`. |
| Unused migration binding and browser-test locator | Removed; enabled `noUnusedLocals` and `noUnusedParameters` in the normal type check. |

## Retained deliberately

- Worker factories, daemon exports, `relay.memory_persistence`, and parsers used
  within their own modules have real runtime or test consumers. An export with
  no import in another production file is not necessarily dead.
- Weekly and five-hour allowance analyses share the reducer but retain separate
  state. Combining the state would mix reset windows and corrupt estimates.
- Claude quota recovery, generic restart recovery, relay delivery, and the todo
  queue have distinct triggers and delivery guarantees. Their similar retry
  concepts do not make them interchangeable features.
- Local and remote process transports have similar Erlang port declarations but
  different lifecycle and connection behavior. This pass leaves the FFI boundary
  explicit.
- Svelte `+page.svelte` modules and the AppImage Docker entry script are framework
  or packaging entry points, even without ordinary source imports.

## Remaining structural work

1. `src/routes/+layout.svelte` is roughly 12,000 lines and owns session lifecycle,
   event handling, composer behavior, dialogs, and rendering. Extract controllers
   by ownership, beginning with composer/attachments and session persistence;
   preserve Svelte reactivity and notification ordering with browser regressions.
2. `server/src/yacwu/router.gleam` is roughly 4,400 lines. Upload parsing, thread
   commands, and account/usage endpoints are candidates for separate modules.
   Keep authorization and provider routing centralized during extraction.
3. `server/src/yacwu/codex.gleam` combines transport supervision, request tracking,
   and event-derived state in roughly 2,500 lines. Splitting it requires explicit
   tests for reconnect generations, outstanding requests, and persistent daemon
   adoption; code similarity alone is insufficient evidence to merge paths.
4. The normal compiler checks now catch unused locals and parameters, but not
   every unused export or dynamically dispatched handler. Repeat reference audits
   when replacing APIs, and move tests to the replacement implementation at the
   same time so tests do not keep obsolete helpers alive.

These are maintainability findings. No measured speedup is claimed for the
structural recommendations.

## Verification

Run checks in an isolated project copy. The new usage-pool contract test fails
without the shared builder. The browser regression fails on the old file-browser
implementation because normalized-path line statistics are absent. Unit tests,
Svelte diagnostics (including unused declarations), Gleam tests, and focused
Playwright tests cover the consolidated behavior. Backend wrappers and persistent
daemons are unchanged.
