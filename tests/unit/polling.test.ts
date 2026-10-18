import { expect, test } from 'bun:test';
import { forEachConcurrent, observeWhileVisible } from '../../src/lib/polling';

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
test('observational timers stop hidden, refresh on visibility, coalesce, and clean up', async () => {
 const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
 const timers = new Set<() => void>();
 const clock = { set(fn: () => void) { timers.add(fn); return fn; }, clear(id: unknown) { timers.delete(id as () => void); } };
 let calls = 0;
 let release: () => void = () => {};
 const stop = observeWhileVisible(() => { calls++; return new Promise<void>(resolve => { release = resolve; }); }, 10, { document: doc, clock });
 await flush(); expect(calls).toBe(0); expect(timers.size).toBe(0);
 doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
 await flush(); expect(calls).toBe(1); expect(timers.size).toBe(1);
 for (const tick of timers) tick(); await flush(); expect(calls).toBe(1);
 release(); await flush();
 doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'));
 expect(timers.size).toBe(0);
 doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
 await flush(); expect(calls).toBe(2);
 release(); stop(); await flush(); expect(timers.size).toBe(0);
 doc.dispatchEvent(new Event('visibilitychange')); await flush(); expect(calls).toBe(2);
});

test('bounded polling processes every item with at most four in flight', async () => {
 let active = 0, peak = 0;
 const done: number[] = [];
 await forEachConcurrent(Array.from({ length: 21 }, (_, i) => i), 4, async i => {
  peak = Math.max(peak, ++active);
  await Promise.resolve(); done.push(i); active--;
 });
 expect(peak).toBe(4); expect(done.sort((a,b)=>a-b)).toEqual(Array.from({ length: 21 }, (_, i) => i));
 await expect(forEachConcurrent([], 0, async () => {})).rejects.toThrow();
});
