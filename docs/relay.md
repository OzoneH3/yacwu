# Session messages (relay)

Agents in Yacwu sessions on the same machine can send each other short
messages through the Yacwu server. It is a trusted, single-user, local
feature: state lives in server memory, and no session is ever woken up.

## How agents use it

Sessions with shared coordination enabled are told how in their prompt. The
CLI is `scripts/yacwu-relay.mjs`; the server exports its path and connection
details to every local backend:

```sh
node "$YACWU_RELAY_CLI" peers  --session <own id>          # sessions in the same folder
node "$YACWU_RELAY_CLI" send   --from <own id> --to <id> "message"
node "$YACWU_RELAY_CLI" inbox  --session <own id>          # read-only
node "$YACWU_RELAY_CLI" status --id <message id>
```

`send` prints the message id. When it retries after a connection failure it
reuses that id, so the relay drops the duplicate; pass `--id` to retry by hand.

## Delivery

- **Working recipient:** the message is steered into its current turn
  (`turn/steer`, guarded by the turn id), so it lands at the next input boundary.
- **Idle recipient:** the message waits and goes out with the user's next
  prompt, as a separate input part after it. Idle sessions are not woken.
- **Unknown state** (after a reconnect, say): the relay reads the thread's
  runtime status and its in-progress turn before steering. When that can't
  be established, the message keeps waiting.

## Statuses

| Status | Meaning |
|---|---|
| queued | Waiting in server memory; lost if the server restarts |
| sending | A delivery attempt is in flight |
| accepted | The recipient's backend acknowledged it. This is not proof the model read it. The Claude adapter can record a steer on the turn without forwarding it to a running model. |
| uncertain | The backend may have taken it (lost connection, timeout, unrecognised error). It is never resent automatically. |
| rejected | Refused (unknown or archived recipient, messages turned off, …) |

Only backend errors verified to be raised before the input is stored count
as a refusal. Anything else is treated as uncertain.

## Transcripts

Received messages appear as `[Yacwu relay …]` blocks. They get a sender
label only when they match the server's delivery record: same recipient,
same acknowledged turn, same id, sender, and text. After a server restart
those records are gone and blocks are shown as plain text. Sender identity
is always self-reported by the sending agent.

Each message ends with the exact `yacwu-relay send` command for replying to
its sender. Agents must reply that way: built-in agent messaging, such as
Claude's SendMessage tool, only reaches that agent's own subagents.

## Settings and security

- **Accept direct messages** (Session details) is stored on the server and
  applies to every browser at once. Turning it off refuses new messages and
  drops queued ones. Messages already sent or uncertain are left alone. A
  session's own choice lasts until the server restarts.
- **Default: accept direct messages** (Settings) decides for every session
  without its own choice. It is saved in Yacwu's state directory
  (`relay-settings.json`), so it survives restarts. Turning it off drops
  messages still queued for those sessions.
- Agent routes (`/api/relay/*`) need a bearer credential, kept in a 0600 file
  named by `YACWU_RELAY_AUTH_FILE`. Any agent running as your user can read
  it, so it keeps other users out, not one session from another.
- Browser routes (the delivery log and the setting) use normal Yacwu
  authentication and never accept the relay credential. With
  `YACWU_INSECURE_SKIP_AUTH=1` they are open to any local process.
- Only sessions on this machine are reachable; remote (SSH) sessions are not.

## Limits

16 KiB per message, 50 queued per recipient, 500 undelivered in total,
10 messages / 64 KiB per delivery, 8 attempts in flight per backend. The last
1000 finished messages and 5000 message ids are remembered for status and
duplicate detection. All of it is lost on restart, so duplicate detection
holds only within one server run.

## Not yet verified against live backends

These need real model turns and have not been run:

- Codex steer into a running turn, and Codex's exact error text when
  `expectedTurnId` no longer matches. Until it's known, that error is
  treated as uncertain.
- Whether Codex echoes `clientUserMessageId` back as `userMessage.clientId`.
  Reconciling uncertain messages from history depends on it and is not
  implemented.
- A Codex agent's shell tool receiving `YACWU_RELAY_*` and reaching the server.
- End-to-end delivery between a Codex and a Claude session.
