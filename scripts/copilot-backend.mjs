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
import { createCopilotAccountReader } from './copilot-account.mjs';
import { deleteArchivedThread, isConversationId } from './claude-thread-delete.mjs';

const MODELS_MAX_AGE_MS = 24 * 3600_000;
/** Bump when the cached model list gains fields, so older caches are re-read. */
const MODELS_CACHE_VERSION = 2;

/**
 * @typedef {{id: string, name: string, description?: string, usage?: string | null, price?: string | null,
 *   enabled?: boolean, efforts?: string[], defaultEffort?: string | null}} CopilotModel
 */

/** "15x" → "15 premium requests per prompt". @param {string | null | undefined} usage */
export function usageNote(usage) {
  const match = /^(\d+(?:\.\d+)?)x$/.exec(usage ?? '');
  if (!match) return '';
  const count = Number(match[1]);
  return count === 0 ? 'No premium requests' : `${match[1]} premium request${count === 1 ? '' : 's'} per prompt`;
}

/**
 * Explicit usable models, each once, with GPT-6 Luna as the default.
 * Names carry Copilot's fixed multiplier, not learned allowance costs.
 * @param {CopilotModel[]} models
 */
export function pickerModels(models) {
  const usable = models.filter((m) => m.enabled !== false);
  return usable.filter((m) => !/^(?:auto|default)$/i.test(m.id)).map((m) => ({
      id: `${MODEL_PREFIX}${m.id}`,
      sdkModel: `${MODEL_PREFIX}${m.id}`,
      displayName: m.usage ? `${m.name} · ${/^0(?:\.0+)?x$/.test(m.usage) ? 'free' : m.usage}` : m.name,
      description: usageNote(m.usage) || m.description || '',
      isDefault: m.id === 'gpt-6-luna',
      efforts: m.efforts ?? [],
      defaultEffort: m.defaultEffort ?? null
    }));
}

const EFFORT_NOTES = /** @type {Record<string, string>} */ ({ none: 'No reasoning', low: 'Minimal reasoning', medium: 'Balanced reasoning and speed', high: 'More thorough reasoning', xhigh: 'Extensive reasoning', max: 'Maximum reasoning' });

/** The app-server model/list answer: each model with the thinking levels it really offers. @param {ReturnType<typeof pickerModels>} entries */
export function modelListResult(entries) {
  return {
    data: entries.map((entry) => ({
      id: entry.id, model: entry.id, displayName: entry.displayName, description: entry.description,
      upgrade: null, upgradeInfo: null, availabilityNux: null, hidden: false,
      supportedReasoningEfforts: entry.efforts.map((effort) => ({ reasoningEffort: effort, description: EFFORT_NOTES[effort] ?? effort })),
      defaultReasoningEffort: entry.defaultEffort ?? (entry.efforts.includes('medium') ? 'medium' : entry.efforts[0] ?? null),
      inputModalities: ['text', 'image'], supportsPersonality: false, additionalSpeedTiers: [], isDefault: entry.isDefault
    })),
    nextCursor: null
  };
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
  process.env.CLAUDE_CODEX_DEFAULT_MODEL ||= `${MODEL_PREFIX}gpt-6-luna`;
  process.env.CLAUDE_CODEX_SUMMARY_MODEL ||= `${MODEL_PREFIX}gpt-6-luna`;
  const home = process.env.CLAUDE_CODEX_HOME;
  mkdirSync(home, { recursive: true });

  // The adapter re-reads CLAUDE_CODEX_MODELS on every model/list.
  const cachePath = join(home, 'copilot-models.json');
  /** @type {ReturnType<typeof pickerModels>} */
  let entries = [];
  const useModels = (/** @type {CopilotModel[]} */ models) => {
    entries = pickerModels(models);
    process.env.CLAUDE_CODEX_MODELS = JSON.stringify(entries.map(({ efforts, defaultEffort, ...entry }) => entry));
  };
  const refresh = () => discoverCopilotModels({ cwd: home }).then(({ models }) => {
    if (!models.length) return;
    useModels(models);
    writeFileSync(cachePath, JSON.stringify({ version: MODELS_CACHE_VERSION, at: Date.now(), models }));
  }, (error) => console.error(`[yacwu copilot] Model list unavailable: ${error instanceof Error ? error.message : String(error)}`));
  let cached = null;
  try { cached = JSON.parse(readFileSync(cachePath, 'utf8')); } catch { /* none yet */ }
  if (cached?.version !== MODELS_CACHE_VERSION) cached = null;
  useModels(cached?.models ?? []);
  if (!cached) await refresh();
  else if (Date.now() - cached.at > MODELS_MAX_AGE_MS) void refresh();

  const load = (/** @type {string} */ name) => import(pathToFileURL(join(dirname(adapterPath), name)).href);
  const [{ SessionStore }, { CodexClaudeAppServer }, { startStdioTransport }] = await Promise.all([load('store.mjs'), load('server.mjs'), load('transports.mjs')]);
  const store = new SessionStore();
  store.recoverStaleInProgressTurns();
  const runtime = new CopilotAcpRuntime();
  const server = new CodexClaudeAppServer(store, runtime);
  runtime.onContextUsage = (threadId, usage) => server.notifyThread(threadId, {
    method: 'yacwu/contextUsage/updated', params: { threadId, ...usage }
  });
  const readAccount = createCopilotAccountReader();
  const dispatch = server.dispatch;
  server.dispatch = async function (/** @type {any} */ peer, /** @type {string} */ method, /** @type {any} */ params) {
    if (method === 'thread/delete') {
      const threadId = typeof params?.threadId === 'string' ? params.threadId : '';
      const result = await deleteCopilotThread({ store: this.store, threadId, home: copilotHome() });
      this.clearThreadState?.(threadId);
      return result;
    }
    if (method === 'model/list') return modelListResult(entries);
    // The adapter only knows Claude's thinking levels and drops Copilot's
    // "none"; the runtime takes the level as Yacwu asked for it.
    if (method === 'turn/start' && typeof params?.threadId === 'string' && typeof params?.effort === 'string') runtime.requestedEffort.set(params.threadId, params.effort);
    if (method === 'account/rateLimits/read') {
      // ACP does not report account usage; gh can optionally supply explicit credits.
      const rateLimits = { limitId: 'copilot', limitName: 'GitHub Copilot', primary: null, secondary: null, credits: null, planType: null, rateLimitReachedType: null, copilotUsage: await readAccount() };
      return { rateLimits, rateLimitsByLimitId: { copilot: rateLimits } };
    }
    const result = await dispatch.call(this, peer, method, params);
    if (method === 'thread/read' || method === 'thread/resume') {
      const usage = runtime.contextUsage.get(params?.threadId);
      if (usage) this.notify(peer, { method: 'yacwu/contextUsage/updated', params: { threadId: params.threadId, ...usage } });
    }
    return result;
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
