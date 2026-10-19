/** Coalesce event bursts and periodic refreshes, retaining one trailing refresh. */
export function createRefreshThrottle(interval: number, now = Date.now,
 timers = { set: (fn: () => void, ms: number): unknown => setTimeout(fn, ms), clear: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>) }) {
 const last = new Map<string, number>();
 const pending = new Map<string, { timer: unknown; run: () => unknown | Promise<unknown>; waiters: { resolve: () => void; reject: (error: unknown) => void }[] }>();
 return {
  request(key: string, run: () => unknown | Promise<unknown>): Promise<void> {
   const delay = Math.max(0, (last.get(key) ?? -Infinity) + interval - now());
   if (!pending.has(key) && !delay) { last.set(key, now()); return Promise.resolve().then(run).then(() => {}); }
   return new Promise((resolve, reject) => {
    const existing = pending.get(key);
    if (existing) { existing.run = run; existing.waiters.push({ resolve, reject }); return; }
    const entry = { timer: undefined as unknown, run, waiters: [{ resolve, reject }] };
    entry.timer = timers.set(() => {
     pending.delete(key); last.set(key, now());
     void Promise.resolve().then(entry.run).then(
      () => entry.waiters.forEach(w => w.resolve()),
      error => entry.waiters.forEach(w => w.reject(error)));
    }, delay);
    pending.set(key, entry);
   });
  },
  dispose() { for (const entry of pending.values()) { timers.clear(entry.timer); entry.waiters.forEach(w => w.resolve()); } pending.clear(); last.clear(); }
 };
}
