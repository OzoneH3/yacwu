import { expect, test } from 'bun:test';
import { createRefreshThrottle } from '../../src/lib/refresh-throttle';

test('usage bursts retain one trailing refresh per host and await it', async () => {
 let now = 0; let next = 0;
 const queued = new Map<number, () => void>();
 const throttle = createRefreshThrottle(5000, () => now, { set: fn => { queued.set(++next, fn); return next; }, clear: id => { queued.delete(id as number); } });
 const calls: string[] = [];
 await throttle.request('local', () => { calls.push('first'); });
 const a = throttle.request('local', () => { calls.push('superseded'); });
 const b = throttle.request('local', () => { calls.push('trailing'); });
 await throttle.request('claude', () => { calls.push('other host'); });
 expect(calls).toEqual(['first', 'other host']); expect(queued.size).toBe(1);
 now = 5000; const fn = queued.values().next().value!; queued.clear(); fn();
 await Promise.all([a, b]); expect(calls).toEqual(['first', 'other host', 'trailing']);
 const cancelled = throttle.request('local', () => { calls.push('cancelled'); });
 throttle.dispose(); await cancelled;
 expect(queued.size).toBe(0); expect(calls).not.toContain('cancelled');
});
