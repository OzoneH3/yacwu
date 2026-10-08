// Discover Claude's versioned catalog without sending a prompt, then run the
// existing adapter. No adapter checkout modifications or model calls required.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createClaudeUsageReader, normalizeClaudeTokenUsage, readClaudeCredentials } from './claude-usage.mjs';
import { createClaudeTurnRouter } from './claude-routing.mjs';
import { createClaudeProgressReminders } from './claude-progress.mjs';
import { createClaudeQuotaGuard, takeAllowanceReserve } from './claude-quota-guard.mjs';

/**
 * Supplement CLI aliases with concrete IDs available to the signed-in account.
 * @param {{fetchModels?: (url: string, options: RequestInit) => Promise<Response>, token?: string}} options
 */
export async function accountModels({ fetchModels = fetch, token } = {}) {
  if (!token) {
    const auth = await readClaudeCredentials().catch(() => null);
    token = process.env.CLAUDE_CODE_OAUTH_TOKEN || auth?.accessToken;
  }
  if (!token) return [];
  const models = [];
  let after;
  do {
    const url = new URL('https://api.anthropic.com/v1/models');
    url.searchParams.set('limit', '100');
    if (after) url.searchParams.set('after_id', after);
    const response = await fetchModels(url.href, {
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error(`Claude model catalog unavailable (${response.status})`);
    const page = await response.json();
    if (!Array.isArray(page.data)) throw new Error('Invalid Claude model catalog');
    for (const model of page.data) {
      if (typeof model.id === 'string' && model.id.startsWith('claude-')) {
        models.push({ id: model.id, sdkModel: model.id, displayName: typeof model.display_name === 'string' ? model.display_name : model.id, description: '', isDefault: false });
      }
    }
    const next = page.has_more && typeof page.last_id === 'string' ? page.last_id : undefined;
    if (page.has_more && (!next || next === after)) throw new Error('Invalid Claude model catalog pagination');
    after = next;
  } while (after);
  return models;
}

/** @param {ReturnType<typeof adapterModels>} cliModels @param {Awaited<ReturnType<typeof accountModels>>} availableModels */
export function mergeModelCatalogs(cliModels, availableModels) {
  const models = new Map(cliModels.map((model) => [model.id, model]));
  for (const model of availableModels) if (!models.has(model.id)) models.set(model.id, model);
  return [...models.values()];
}

/** @param {Array<{value: string, resolvedModel?: string, displayName: string, description?: string}>} models */
export function adapterModels(models) {
  return models.map((model) => {
    const resolved = model.resolvedModel ?? model.value;
    const match = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?=-|\[|$))?/.exec(resolved);
    const version = match ? `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}${match[3] ? `.${match[3]}` : ''}` : null;
    return {
      id: model.value,
      sdkModel: model.value,
      displayName: version ? `Claude ${version}${model.value === 'default' ? ' (default)' : ''}${model.value.includes('[1m]') ? ' · 1M' : ''}` : model.displayName,
      description: model.description ?? '',
      isDefault: model.value === 'default'
    };
  });
}

/** @param {string} adapterPath */
async function discoverCliModels(adapterPath) {
  const require = createRequire(pathToFileURL(adapterPath));
  const { query } = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href);
  const abortController = new AbortController();
  let release = () => {};
  const waiting = new Promise((resolveWaiting) => { release = () => resolveWaiting(undefined); });
  async function* noPrompt() { await waiting; }
  const session = query({ prompt: noPrompt(), options: { abortController, persistSession: false, settingSources: [], ...(process.env.CLAUDE_CODEX_CLI ? { pathToClaudeCodeExecutable: process.env.CLAUDE_CODEX_CLI } : {}) } });
  const timer = setTimeout(() => abortController.abort(), 15000);
  try {
    return adapterModels(await session.supportedModels());
  } finally {
    clearTimeout(timer);
    session.close();
    release();
  }
}

/** @param {string} adapterPath */
export async function discoverModels(adapterPath) {
  const [cli, account] = await Promise.allSettled([discoverCliModels(adapterPath), accountModels()]);
  if (cli.status === 'rejected' && account.status === 'rejected') throw cli.reason;
  if (account.status === 'rejected') console.error(`[yacwu claude] Account model discovery unavailable; using CLI catalog: ${account.reason instanceof Error ? account.reason.message : 'request failed'}`);
  return mergeModelCatalogs(cli.status === 'fulfilled' ? cli.value : [], account.status === 'fulfilled' ? account.value : []);
}

async function main() {
  const adapterPath = resolve(process.argv[2] ?? 'claude-codex/dist/src/adapter.mjs');
  /** @type {NodeJS.ProcessEnv} */
  // Claude Code reports session_state_changed (its authoritative turn-over
  // signal) only with this set; claude-background-runtime ends turns on it.
  const env = { ...process.env, CLAUDE_CODEX_DISABLE_CODEX_PROXY: '1', CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' };
  if (!env.CLAUDE_CODEX_MODELS) {
    try {
      const models = await discoverModels(adapterPath);
      if (models.length) env.CLAUDE_CODEX_MODELS = JSON.stringify(models);
    } catch (error) {
      console.error(`[yacwu claude] Versioned model discovery unavailable; using adapter aliases: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const args = process.argv.slice(3);
  const entryPath = new URL('./claude-adapter-entry.mjs', import.meta.url);
  const child = spawn(process.execPath, [fileURLToPath(entryPath), adapterPath, ...(args.length ? args : ['app-server', '--listen', 'stdio://'])], { stdio: ['pipe', 'pipe', 'inherit'], env });
  const readUsage = createClaudeUsageReader();
  const quota = createClaudeQuotaGuard(readUsage,
    (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`));
  const quotaTimer = setInterval(() => void quota.poll(), 30000);
  /** @param {import('./claude-routing.mjs').RpcMessage | undefined} message @param {string} line */
  async function forward(message, line) {
    // The browser's lockout preference is for Yacwu, not for Claude.
    const { reserve, changed } = takeAllowanceReserve(message);
    if (!await quota.allow(message, reserve)) return;
    progress.request(message);
    child.stdin.write(`${changed ? JSON.stringify(message) : line}\n`);
  }
  const progress = createClaudeProgressReminders((message) => child.stdin.write(`${JSON.stringify(message)}\n`));
  const reminderTimer = setInterval(() => progress.tick(), 15000);
  const routing = createClaudeTurnRouter(
    (message) => { void forward(message, JSON.stringify(message)); },
    (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
  );
  const input = createInterface({ input: process.stdin });
  const output = createInterface({ input: child.stdout });
  input.on('line', (line) => {
    let request;
    try { request = JSON.parse(line); } catch { /* Forward adapter parse errors. */ }
    if (request?.method === 'account/rateLimits/read' && request.id != null) {
      void readUsage().then((result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`));
    } else if (!routing.request(request)) {
      void forward(request, line);
    }
  });
  input.on('close', () => child.stdin.end());
  output.on('line', (line) => {
    try {
      const message = JSON.parse(line);
      if (quota.observe(message)) return;
      if (progress.observe(message)) return;
      if (routing.response(message)) return;
      line = JSON.stringify(normalizeClaudeTokenUsage(message));
    } catch { /* Preserve non-JSON adapter output. */ }
    process.stdout.write(`${line}\n`);
  });
  child.stdin.on('error', () => input.close());
  for (const signal of /** @type {NodeJS.Signals[]} */ (['SIGTERM', 'SIGINT'])) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => { clearInterval(quotaTimer); quota.close(); clearInterval(reminderTimer); progress.close(); input.close(); process.stdin.pause(); console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { clearInterval(quotaTimer); quota.close(); clearInterval(reminderTimer); progress.close(); routing.close(); input.close(); process.stdin.pause(); process.exitCode = code ?? (signal ? 1 : 0); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
