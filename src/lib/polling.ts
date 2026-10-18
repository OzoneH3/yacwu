/** Bound request bursts without dropping any work. Callers handle individual
 * failures when the remaining requests must still run. */
export async function forEachConcurrent<T>(items: readonly T[], concurrency: number, run: (item: T) => Promise<void>): Promise<void> {
 if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Concurrency must be a positive integer');
 let next = 0;
 await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
  while (next < items.length) await run(items[next++]);
 }));
}

interface VisibilitySource {
 readonly visibilityState: string;
 addEventListener(type: string, listener: () => void): void;
 removeEventListener(type: string, listener: () => void): void;
}
interface Clock { set(run: () => void, milliseconds: number): unknown; clear(timer: unknown): void }

/** Observational timers only. Recovery, queued tasks and SSE stay independent. */
export function observeWhileVisible(run: () => unknown | Promise<unknown>, milliseconds: number,
 options: { immediate?: boolean; document?: VisibilitySource; clock?: Clock } = {}) {
 const source = options.document ?? document;
 const clock = options.clock ?? { set: (run: () => void, ms: number) => setInterval(run, ms), clear: (timer: unknown) => clearInterval(timer as ReturnType<typeof setInterval>) };
 let timer: unknown;
 let stopped = false;
 let running = false;
 const tick = () => {
  if (stopped || source.visibilityState !== 'visible' || running) return;
  running = true;
  void Promise.resolve().then(() => {
   if (!stopped && source.visibilityState === 'visible') return run();
  }).catch(() => { /* Observations retry next tick; callers surface actionable failures. */ }).finally(() => { running = false; });
 };
 const schedule = (immediate: boolean) => {
  if (timer !== undefined) { clock.clear(timer); timer = undefined; }
  if (!stopped && source.visibilityState === 'visible') {
   if (immediate) tick();
   timer = clock.set(tick, milliseconds);
  }
 };
 const visible = () => schedule(true);
 source.addEventListener('visibilitychange', visible);
 schedule(options.immediate !== false);
 return () => {
  stopped = true;
  if (timer !== undefined) clock.clear(timer);
  source.removeEventListener('visibilitychange', visible);
 };
}
