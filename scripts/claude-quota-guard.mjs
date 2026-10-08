/** @typedef {{id?: string | number, method?: string, params?: Record<string, any>, result?: any, error?: any}} RpcMessage */
/** Stop/block Claude turns when either allowance has 10% or less remaining.
 * @param {(options?: {force?: boolean}) => Promise<any>} readUsage
 * @param {(message: RpcMessage) => void} send
 * @param {(message: RpcMessage) => void} reply
 */
export function createClaudeQuotaGuard(readUsage, send, reply) {
  const active = new Map();
  const interrupted = new Map();
  const pending = new Map();
  let serial = 0;
  let closed = false;
  let polling = false;
  /** @param {any} usage */
  function reason(usage) {
    const limits = usage?.rateLimits;
    for (const [key, name] of [['primary', '5-hour'], ['secondary', '7-day']]) {
      const used = limits?.[key]?.usedPercent;
      if (typeof used === 'number' && Number.isFinite(used) && used >= 90) return `Claude ${name} allowance has ${Math.max(0, 100 - used)}% remaining. Tasks are stopped and new starts blocked at 10% remaining.`;
    }
    return null;
  }
  /** @param {any} usage */
  function stop(usage) {
    const message = reason(usage);
    if (!message || closed) return;
    for (const [threadId, turnId] of active) {
      if (interrupted.has(turnId)) continue;
      interrupted.set(turnId, message);
      const id = `yacwu-quota-stop-${++serial}`;
      pending.set(id, turnId);
      send({ id, method: 'turn/interrupt', params: { threadId, turnId } });
    }
  }
  return {
    /** @param {RpcMessage | undefined} request */
    async allow(request) {
      if (!['turn/start', 'review/start', 'thread/compact/start'].includes(request?.method ?? '')) return true;
      // The reader reuses recent valid readings and refreshes unknown/expired
      // ones, while respecting Anthropic's retry delay.
      const usage = await readUsage({ force: true });
      if (closed) return false;
      stop(usage);
      let message = reason(usage);
      const windows = [usage?.rateLimits?.primary, usage?.rateLimits?.secondary];
      if (!message && windows.some(w => typeof w?.usedPercent !== 'number' || !Number.isFinite(w.usedPercent))) message = 'Cannot verify Claude 5-hour and 7-day allowance. New tasks are blocked until usage is available to protect the 10% reserve.';
      if (message && usage?.usageError?.code === 'rate_limited') message = `Claude usage endpoint is temporarily rate limited. Try again after ${new Date(usage.usageError.retryAt).toLocaleTimeString()}. Tasks remain blocked until the 10% reserve can be checked.`;
      if (!message) return true;
      if (request?.id != null) reply({ id: request.id, error: { code: -32000, message } });
      return false;
    },
    /** @param {RpcMessage} message */
    observe(message) {
      if (typeof message.id === 'string' && message.id.startsWith('yacwu-quota-stop-')) {
        const turnId = pending.get(message.id);
        pending.delete(message.id);
        // An explicit failure permits retry at the next quota poll.
        if (message.error && turnId && [...active.values()].includes(turnId)) interrupted.delete(turnId);
        return true;
      }
      const p = message.params ?? {};
      if (message.method === 'turn/started' && p.threadId && p.turn?.id) {
        active.set(p.threadId, p.turn.id);
        void this.poll();
      }
      if (message.method === 'turn/completed') {
        const why = interrupted.get(p.turn?.id);
        if (why && p.turn?.status === 'interrupted') p.turn.error = { ...p.turn.error, message: why };
        if (active.get(p.threadId) === p.turn?.id) active.delete(p.threadId);
      }
      // Restore active turns when reconnecting to an already-loaded adapter.
      for (const turn of message.result?.thread?.turns ?? []) {
        const why = interrupted.get(turn.id);
        if (why && turn.status === 'interrupted') turn.error = { ...turn.error, message: why };
        if (turn.status === 'inProgress' && message.result.thread.id) active.set(message.result.thread.id, turn.id);
      }
      return false;
    },
    async poll() {
      if (closed || polling || !active.size) return;
      polling = true;
      try { stop(await readUsage({ force: true })); } finally { polling = false; }
    },
    close() { closed = true; active.clear(); pending.clear(); interrupted.clear(); }
  };
}
