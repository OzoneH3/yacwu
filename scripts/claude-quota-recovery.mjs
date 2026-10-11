// Recover explicitly queued sessions through the existing HTTP server, without
// replacing or connecting directly to a persistent backend daemon.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { claudeSessionLimitReason, createClaudeQuotaGuard } from './claude-quota-guard.mjs';
import { createClaudeUsageReader } from './claude-usage.mjs';
import { quotaResumeStore } from './claude-quota-state.mjs';

/** @param {{request: (path: string, body?: any) => Promise<any>, store: ReturnType<typeof quotaResumeStore>, readUsage: (options?: any) => Promise<any>, now?: () => number, log?: (text: string) => void}} options */
export function createClaudeRecoveryWorker({ request, store, readUsage, now = Date.now, log = () => {} }) {
  const pending = new Set();
  let remaining = store.load();
  const guard = createClaudeQuotaGuard(readUsage, message => {
    const operation = dispatch(message).finally(() => pending.delete(operation));
    pending.add(operation);
  }, message => {
    if (message.params?.item?.text) log(message.params.item.text);
  }, { now, waiting: remaining, saveWaiting(entries) { remaining = entries; store.save(entries); } });

  /** @param {any} message */
  async function dispatch(message) {
    try {
      const id = message.params.threadId;
      // An archived/deleted session must never be revived by recovery.
      const listing = await request('/api/threads?host=claude');
      if (!Array.isArray(listing.data)) throw new Error('Session listing unavailable');
      if (!listing.data.some(/** @param {any} thread */ thread => thread.id === id)) {
        await guard.allow({ method: 'thread/archive', params: { threadId: id } });
        return;
      }
      const path = `/api/threads/${encodeURIComponent(id)}`;
      if (message.method === 'turn/start') {
        // Recheck after the quota guard's read, before submitting any input.
        const entry = remaining.find(/** @param {any} entry */ entry => entry.threadId === id);
        const history = await request(`${path}?host=claude&turns=1`);
        const last = history.thread?.turns?.at(-1);
        if (!last) throw new Error('Session history unavailable');
        if (!entry || last.id !== entry.turnId || (entry.providerLimit ? !claudeSessionLimitReason(last) : last.status !== 'interrupted')) {
          await guard.allow({ method: 'thread/archive', params: { threadId: id } });
          return;
        }
      }
      const result = message.method === 'thread/read'
        ? await request(`${path}?host=claude&turns=1`)
        : await request(`${path}/message?host=claude`, { text: message.params.input.map(/** @param {any} part */ part => part.text).join('\n') });
      guard.observe({ id: message.id, result });
    } catch (error) {
      log(`Recovery request deferred: ${error instanceof Error ? error.message : String(error)}`);
      guard.observe({ id: message.id, error: { message: String(error) } });
    }
  }
  return {
    async poll() {
      await guard.poll();
      while (pending.size) await Promise.all([...pending]);
      return remaining.length;
    },
    close() { guard.close(); }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const queue = process.argv[2];
  if (!queue) throw new Error('Usage: node scripts/claude-quota-recovery.mjs .workspace/QUEUE.json');
  const base = process.env.YACWU_URL || 'http://localhost:3000';
  const worker = createClaudeRecoveryWorker({
    store: quotaResumeStore(resolve(queue)), readUsage: createClaudeUsageReader(),
    log: text => console.log(`${new Date().toISOString()} ${text}`),
    async request(path, body) {
      const response = await fetch(new URL(path, base), {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60_000)
      });
      const result = await response.json();
      if (!response.ok || result.error) throw new Error(result.error?.message ?? result.error ?? `HTTP ${response.status}`);
      return result;
    }
  });
  let polling = false;
  async function poll() {
    if (polling) return;
    polling = true;
    try {
      if (await worker.poll() === 0) { clearInterval(timer); worker.close(); console.log('Recovery queue complete.'); }
    } catch (error) { console.error(error); }
    finally { polling = false; }
  }
  const timer = setInterval(poll, 30_000);
  await poll();
}
