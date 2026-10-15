// GitHub Copilot as a Yacwu backend: claude-codex's app-server (threads,
// history, the codex protocol) driven by Copilot CLI over ACP instead of
// Claude. Configure it like the Claude backend:
//
//   YACWU_BACKENDS="copilot=node ./scripts/copilot-backend.mjs ./claude-codex/dist/src/adapter.mjs"
//
// Copilot must be installed and signed in (`copilot login`). Its sessions
// are stored apart from Claude's, in $XDG_STATE_HOME/yacwu/copilot-adapter
// (CLAUDE_CODEX_HOME overrides). YACWU_COPILOT_CLI names another binary.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CopilotAcpRuntime, MODEL_PREFIX, discoverCopilotModels } from './copilot-acp-runtime.mjs';
import { deleteArchivedThread, isConversationId } from './claude-thread-delete.mjs';

const MODELS_MAX_AGE_MS = 24 * 3600_000;

/** Model picker entries: Copilot's own choice first, then each model. @param {Array<{id: string, name: string, description: string}>} models */
export function pickerModels(models) {
  return [
    { id: `${MODEL_PREFIX}auto`, sdkModel: `${MODEL_PREFIX}auto`, displayName: 'Copilot · auto', description: 'Copilot picks the model', isDefault: true },
    ...models.filter((m) => m.id !== 'auto').map((m) => ({ id: `${MODEL_PREFIX}${m.id}`, sdkModel: `${MODEL_PREFIX}${m.id}`, displayName: `Copilot · ${m.name}`, description: m.description, isDefault: false }))
  ];
}

export function copilotHome(env = process.env) {
  return env.COPILOT_HOME || join(homedir(), '.copilot');
}

/** Delete an archived thread, and Copilot's own copy of its session when no other thread uses it. @param {{store: any, threadId: string, home: string}} options */
export async function deleteCopilotThread({ store, threadId, home }) {
  const sessionId = store.getThread(threadId)?.claudeSessionId ?? null;
  const shared = sessionId != null && store.db.prepare('SELECT COUNT(*) AS n FROM threads WHERE claude_session_id = ? AND id <> ?').get(sessionId, threadId).n > 0;
  // With Copilot's home as the root, nothing of Claude's can match.
  const result = await deleteArchivedThread({ store, configRoot: home, threadId });
  result.kept = shared ? [`Copilot session ${sessionId} (still used by another session)`] : [];
  if (sessionId && !shared && isConversationId(sessionId)) {
    const dir = join(home, 'session-state', sessionId);
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
      result.files.push(dir);
    }
  }
  return result;
}

async function main() {
  const adapterPath = resolve(process.argv[2] ?? 'claude-codex/dist/src/adapter.mjs');
  const stateRoot = process.env.XDG_STATE_HOME || join(homedir(), '.local/state');
  process.env.CLAUDE_CODEX_HOME ||= join(stateRoot, 'yacwu/copilot-adapter');
  process.env.CLAUDE_CODEX_DISABLE_CODEX_PROXY = '1';
  process.env.CLAUDE_CODEX_DEFAULT_MODEL ||= `${MODEL_PREFIX}auto`;
  process.env.CLAUDE_CODEX_SUMMARY_MODEL ||= `${MODEL_PREFIX}auto`;
  const home = process.env.CLAUDE_CODEX_HOME;
  mkdirSync(home, { recursive: true });

  // The adapter re-reads CLAUDE_CODEX_MODELS on every model/list.
  const cachePath = join(home, 'copilot-models.json');
  const useModels = (/** @type {any[]} */ models) => { process.env.CLAUDE_CODEX_MODELS = JSON.stringify(pickerModels(models)); };
  const refresh = () => discoverCopilotModels({ cwd: home }).then(({ models }) => {
    if (!models.length) return;
    useModels(models);
    writeFileSync(cachePath, JSON.stringify({ at: Date.now(), models }));
  }, (error) => console.error(`[yacwu copilot] Model list unavailable: ${error instanceof Error ? error.message : String(error)}`));
  let cached = null;
  try { cached = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { /* none yet */ }
  useModels(cached?.models ?? []);
  if (!cached) await refresh();
  else if (Date.now() - cached.at > MODELS_MAX_AGE_MS) void refresh();

  const load = (/** @type {string} */ name) => import(pathToFileURL(join(dirname(adapterPath), name)).href);
  const [{ SessionStore }, { CodexClaudeAppServer }, { startStdioTransport }] = await Promise.all([load('store.mjs'), load('server.mjs'), load('transports.mjs')]);
  const store = new SessionStore();
  store.recoverStaleInProgressTurns();
  const server = new CodexClaudeAppServer(store, new CopilotAcpRuntime());
  const dispatch = server.dispatch;
  server.dispatch = async function (/** @type {any} */ peer, /** @type {string} */ method, /** @type {any} */ params) {
    if (method === 'thread/delete') {
      const threadId = typeof params?.threadId === 'string' ? params.threadId : '';
      const result = await deleteCopilotThread({ store: this.store, threadId, home: copilotHome() });
      this.clearThreadState?.(threadId);
      return result;
    }
    if (method === 'account/rateLimits/read') {
      // ACP does not report Copilot's premium request allowance.
      const rateLimits = { limitId: 'copilot', limitName: 'GitHub Copilot', primary: null, secondary: null, credits: null, planType: null, rateLimitReachedType: null };
      return { rateLimits, rateLimitsByLimitId: { copilot: rateLimits } };
    }
    return dispatch.call(this, peer, method, params);
  };
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    await server.stop();
    process.exit(0);
  };
  for (const signal of /** @type {NodeJS.Signals[]} */ (['SIGINT', 'SIGTERM', 'SIGHUP'])) process.once(signal, () => void shutdown());
  startStdioTransport(server.handle.bind(server), (/** @type {any} */ peer) => { server.closePeer(peer); void shutdown(); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
