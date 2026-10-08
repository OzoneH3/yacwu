// Discover Claude's versioned catalog without sending a prompt, then run the
// existing adapter. No adapter checkout modifications or model calls required.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

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
export async function discoverModels(adapterPath) {
  const require = createRequire(pathToFileURL(adapterPath));
  const { query } = await import(pathToFileURL(require.resolve('@anthropic-ai/claude-agent-sdk')).href);
  const abortController = new AbortController();
  let release = () => {};
  const waiting = new Promise((resolveWaiting) => { release = () => resolveWaiting(undefined); });
  async function* noPrompt() { await waiting; }
  const session = query({ prompt: noPrompt(), options: { abortController, persistSession: false, settingSources: [] } });
  const timer = setTimeout(() => abortController.abort(), 15000);
  try {
    return adapterModels(await session.supportedModels());
  } finally {
    clearTimeout(timer);
    session.close();
    release();
  }
}

async function main() {
  const adapterPath = resolve(process.argv[2] ?? 'claude-codex/dist/src/adapter.mjs');
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, CLAUDE_CODEX_DISABLE_CODEX_PROXY: '1' };
  if (!env.CLAUDE_CODEX_MODELS) {
    try {
      const models = await discoverModels(adapterPath);
      if (models.length) env.CLAUDE_CODEX_MODELS = JSON.stringify(models);
    } catch (error) {
      console.error(`[yacwu claude] Versioned model discovery unavailable; using adapter aliases: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const args = process.argv.slice(3);
  const child = spawn(process.execPath, [adapterPath, ...(args.length ? args : ['app-server', '--listen', 'stdio://'])], { stdio: 'inherit', env });
  for (const signal of /** @type {NodeJS.Signals[]} */ (['SIGTERM', 'SIGINT'])) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
