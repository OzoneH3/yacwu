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
 * @param {{now?: () => number, waiting?: any[], saveWaiting?: (waiting: any[]) => void}} options
 */
export function createClaudeQuotaGuard(readUsage, send, reply, { now = Date.now, waiting = [], saveWaiting = () => {} } = {}) {
  const active = new Map();
  const interrupted = new Map();
  const pending = new Map();
  /** threadId -> reserve (%) last requested for that session. */
  const reserves = new Map();
  const progressPreferences = new Map();
  const resumes = new Map(waiting.filter(entry => typeof entry?.threadId === 'string' && typeof entry?.turnId === 'string').map(entry => [entry.threadId, { ...entry, checking: false, starting: false }]));
  const resumeRequests = new Map();
  const resumedTurns = new Set();
  for (const entry of resumes.values()) {
    reserves.set(entry.threadId, entry.reserve ?? DEFAULT_RESERVE);
    progressPreferences.set(entry.threadId, entry.progress === true);
    if (typeof entry.reason === 'string') interrupted.set(entry.turnId, entry.reason);
  }
  function persist() { saveWaiting([...resumes.values()].map(({ checking, starting, ...entry }) => entry)); }
  /** @param {any} usage @param {number} reserve */
  function checkAfter(usage, reserve) {
    if (usage?.usageError?.retryAt > now()) return usage.usageError.retryAt;
    const resets = [usage?.rateLimits?.primary, usage?.rateLimits?.secondary]
      .filter(window => typeof window?.usedPercent === 'number' && window.usedPercent >= 100 - reserve)
      .map(window => window.resetsAt * 1000).filter(at => Number.isFinite(at) && at > now());
    // After reset, or while usage is unavailable, retry promptly rather than
    // applying the fifteen-minute pre-reset cooldown again.
    return resets.length ? Math.min(now() + 900_000, Math.max(...resets)) : now() + 120_000;
  }
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
      if (['turn/interrupt', 'thread/archive', 'thread/delete'].includes(request?.method ?? '') && resumes.delete(request?.params?.threadId)) persist();
      if (!['turn/start', 'review/start', 'thread/compact/start'].includes(request?.method ?? '')) return true;
      const threadId = request?.params?.threadId;
      if (typeof threadId === 'string' && request?.method === 'turn/start') progressPreferences.set(threadId, request.params?.input?.some(/** @param {any} part */ part => typeof part.text === 'string' && part.text.includes('<!-- YACWU_TASK_PROGRESS -->')) ?? false);
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
      if (typeof message.id === 'string' && message.id.startsWith('yacwu-quota-resume-')) {
        const request = resumeRequests.get(message.id);
        resumeRequests.delete(message.id);
        const entry = request && resumes.get(request.threadId);
        if (!entry) return true;
        if (request.kind === 'read') {
          entry.checking = false;
          const latest = message.result?.thread?.turns?.at(-1);
          if (message.error || !latest) entry.checkAt = now() + 300_000;
          else if (latest.id !== entry.turnId || latest.status !== 'interrupted') { resumes.delete(entry.threadId); persist(); }
          else {
            entry.starting = true;
            const id = `yacwu-quota-resume-${++serial}`;
            resumeRequests.set(id, { kind: 'start', threadId: entry.threadId, sentAt: now() });
            const progress = entry.progress ? '\n\n<!-- YACWU_TASK_PROGRESS -->\nReport estimated completion and time remaining early, about once a minute and at milestones, using a standalone [[YACWU_PROGRESS percent=35 remaining_minutes=6]] line with your actual estimates. Finish at 100 percent and 0 minutes before the final answer.\n[/YACWU_TASK_PROGRESS]' : '';
            send({ id, method: 'turn/start', params: { threadId: entry.threadId, input: [{ type: 'text', text: `The previous task was stopped. Continue from the current state: first inspect what is already complete, then finish only the remaining work.${progress}` }] } });
          }
        } else if (message.error) {
          entry.starting = false;
          entry.checkAt = now() + 300_000;
        } else if (message.result?.turn?.id) {
          // A successful start response is authoritative even if its lifecycle
          // notification was missed. Do not leave the resume pending forever.
          active.set(entry.threadId, message.result.turn.id);
          resumedTurns.add(message.result.turn.id);
          resumes.delete(entry.threadId);
          reply({ method: 'item/completed', params: { threadId: entry.threadId, turnId: message.result.turn.id, item: { type: 'localNote', id: `quota-resumed:${message.result.turn.id}`, text: 'Task resumed automatically after the allowance reset.', tone: 'info' } } });
        }
        persist();
        return true;
      }
      if (typeof message.id === 'string' && message.id.startsWith('yacwu-quota-stop-')) {
        const turnId = pending.get(message.id);
        pending.delete(message.id);
        // An explicit failure permits retry at the next quota poll.
        if (message.error && turnId && [...active.values()].includes(turnId)) interrupted.delete(turnId);
        return true;
      }
      const p = message.params ?? {};
      if (message.method === 'turn/started' && p.threadId && p.turn?.id) {
        const entry = resumes.get(p.threadId);
        if (entry?.starting) {
          resumedTurns.add(p.turn.id);
          reply({ method: 'item/completed', params: { threadId: p.threadId, turnId: p.turn.id, item: { type: 'localNote', id: `quota-resumed:${p.turn.id}`, text: 'Task resumed automatically after the allowance reset.', tone: 'info' } } });
        }
        if (entry) { resumes.delete(p.threadId); persist(); }
        active.set(p.threadId, p.turn.id);
        void this.poll();
      }
      if (message.method === 'turn/completed') {
        annotateStop(p.turn);
        if (p.turn?.error?.yacwuQuotaStopped && p.threadId) {
          resumes.set(p.threadId, { threadId: p.threadId, turnId: p.turn.id, reason: p.turn.error.message, progress: progressPreferences.get(p.threadId) ?? false, reserve: reserveFor(p.threadId), checkAt: now(), checking: false, starting: false });
          persist();
        }
        if (active.get(p.threadId) === p.turn?.id) active.delete(p.threadId);
      }
      // Restore active turns when reconnecting to an already-loaded adapter.
      for (const turn of message.result?.thread?.turns ?? []) {
        annotateStop(turn);
        if (resumedTurns.has(turn.id)) {
          const id = `quota-resumed:${turn.id}`;
          turn.items ??= [];
          if (!turn.items.some(/** @param {any} item */ item => item.id === id)) turn.items.unshift({ type: 'localNote', id, text: 'Task resumed automatically after the allowance reset.', tone: 'info' });
        }
        if (turn.status === 'inProgress' && message.result.thread.id) active.set(message.result.thread.id, turn.id);
      }
      return false;
    },
    async poll() {
      for (const [id, request] of resumeRequests) {
        if (request.kind !== 'read' || now() - request.sentAt < 30_000) continue;
        resumeRequests.delete(id);
        const entry = resumes.get(request.threadId);
        if (entry) { entry.checking = false; entry.checkAt = now(); }
      }
      const ready = [...resumes.values()].filter(entry => !entry.checking && !entry.starting && (entry.checkAt ?? 0) <= now() && !active.has(entry.threadId));
      if (closed || polling || (!active.size && !ready.length)) return;
      polling = true;
      try {
        const usage = await readUsage({ force: true });
        stop(usage);
        for (const entry of ready) {
          if (!resumes.has(entry.threadId) || closed) continue;
          const known = [usage?.rateLimits?.primary, usage?.rateLimits?.secondary].every(window => typeof window?.usedPercent === 'number' && Number.isFinite(window.usedPercent));
          if (!known || reason(usage, entry.reserve)) { entry.checkAt = checkAfter(usage, entry.reserve); continue; }
          entry.checking = true;
          const id = `yacwu-quota-resume-${++serial}`;
          resumeRequests.set(id, { kind: 'read', threadId: entry.threadId, sentAt: now() });
          send({ id, method: 'thread/read', params: { threadId: entry.threadId, includeTurns: true } });
        }
        persist();
      } finally { polling = false; }
    },
    close() { closed = true; active.clear(); pending.clear(); interrupted.clear(); resumeRequests.clear(); }
  };
}
