/** @typedef {{id?: string | number, method?: string, params?: Record<string, any>, result?: any, error?: any}} RpcMessage */

/** Remaining allowance (%) below which Claude work stops, unless a prompt says otherwise. */
export const DEFAULT_RESERVE = 10;
const RESERVE_MARKER = /\s*<!-- YACWU_ALLOWANCE_RESERVE percent=(\d{1,3}) -->/g;

/**
 * Take the browser's lockout preference out of a request's text input, so
 * Claude never sees it. Returns the requested reserve (clamped to 0–50) and
 * whether the request changed.
 * @param {RpcMessage | undefined} request
 * @returns {{reserve: number | null, changed: boolean}}
 */
export function takeAllowanceReserve(request) {
  let reserve = null;
  let changed = false;
  for (const part of request?.params?.input ?? []) {
    if (typeof part?.text !== 'string' || !part.text.includes('YACWU_ALLOWANCE_RESERVE')) continue;
    part.text = part.text.replace(RESERVE_MARKER, (/** @type {string} */ _, /** @type {string} */ percent) => {
      reserve = Math.min(50, Math.max(0, Number(percent)));
      return '';
    });
    changed = true;
  }
  return { reserve, changed };
}

/** Stop/block Claude turns when either allowance has the reserve or less remaining
 * (10% by default; per session from the browser's setting; 0 turns it off).
 * @param {(options?: {force?: boolean, reserve?: number}) => Promise<any>} readUsage
 * @param {(message: RpcMessage) => void} send
 * @param {(message: RpcMessage) => void} reply
 */
export function createClaudeQuotaGuard(readUsage, send, reply) {
  const active = new Map();
  const interrupted = new Map();
  const pending = new Map();
  /** threadId -> reserve (%) last requested for that session. */
  const reserves = new Map();
  let serial = 0;
  let closed = false;
  let polling = false;
  /** @param {any} turn */
  function annotateStop(turn) {
    const why = interrupted.get(turn?.id);
    if (!why || turn?.status !== 'interrupted') return;
    turn.error = { ...turn.error, message: why, yacwuQuotaStopped: true };
    const id = `quota-stop:${turn.id}`;
    turn.items ??= [];
    if (!turn.items.some(/** @param {any} item */ item => item.id === id)) turn.items.push({
      type: 'localNote', id, text: `Task stopped.\n${why}`, tone: 'info',
      resumeAvailable: true, quotaStop: true
    });
  }
  /** @param {string | undefined} threadId */
  function reserveFor(threadId) {
    return threadId ? reserves.get(threadId) ?? DEFAULT_RESERVE : DEFAULT_RESERVE;
  }
  /** @param {any} usage @param {number} reserve */
  function reason(usage, reserve) {
    if (reserve <= 0) return null;
    const limits = usage?.rateLimits;
    for (const [key, name] of [['primary', '5-hour'], ['secondary', '7-day']]) {
      const used = limits?.[key]?.usedPercent;
      if (typeof used === 'number' && Number.isFinite(used) && used >= 100 - reserve) return `Claude ${name} allowance has ${Math.max(0, 100 - used)}% remaining. Tasks are stopped and new starts blocked at ${reserve}% remaining.`;
    }
    return null;
  }
  /** @param {any} usage */
  function stop(usage) {
    if (closed) return;
    for (const [threadId, turnId] of active) {
      const message = reason(usage, reserveFor(threadId));
      if (!message || interrupted.has(turnId)) continue;
      interrupted.set(turnId, message);
      const id = `yacwu-quota-stop-${++serial}`;
      pending.set(id, turnId);
      send({ id, method: 'turn/interrupt', params: { threadId, turnId } });
    }
  }
  return {
    /** @param {RpcMessage | undefined} request @param {number | null} [requestedReserve] */
    async allow(request, requestedReserve = null) {
      if (!['turn/start', 'review/start', 'thread/compact/start'].includes(request?.method ?? '')) return true;
      const threadId = request?.params?.threadId;
      if (typeof threadId === 'string' && requestedReserve !== null) reserves.set(threadId, requestedReserve);
      const reserve = reserveFor(threadId);
      // Lockout turned off for this session: nothing to verify.
      if (reserve <= 0) return true;
      // The reader reuses recent valid readings and refreshes unknown/expired
      // ones, while respecting Anthropic's retry delay.
      const usage = await readUsage({ force: true, reserve });
      if (closed) return false;
      stop(usage);
      let message = reason(usage, reserve);
      const windows = [usage?.rateLimits?.primary, usage?.rateLimits?.secondary];
      if (!message && windows.some(w => typeof w?.usedPercent !== 'number' || !Number.isFinite(w.usedPercent))) message = `Cannot verify Claude 5-hour and 7-day allowance. New tasks are blocked until usage is available to protect the ${reserve}% reserve.`;
      if (message && usage?.usageError?.code === 'rate_limited') message = `Claude usage endpoint is temporarily rate limited. Try again after ${new Date(usage.usageError.retryAt).toLocaleTimeString()}. Tasks remain blocked until the ${reserve}% reserve can be checked.`;
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
        annotateStop(p.turn);
        if (active.get(p.threadId) === p.turn?.id) active.delete(p.threadId);
      }
      // Restore active turns when reconnecting to an already-loaded adapter.
      for (const turn of message.result?.thread?.turns ?? []) {
        annotateStop(turn);
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
