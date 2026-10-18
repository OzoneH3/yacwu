import { expect, test } from 'bun:test';
import { createUsageHistory } from '../../src/lib/usage-background';

test('incremental usage retains history, skips unchanged analyses and replaces rotated journals', async () => {
 const replies = [
  { cursor: 'one', reset: true, events: [{ at: 1, host: 'local', event: 'turn/started', threadId: 't', turnId: 'one' }] },
  { cursor: 'two', reset: false, events: [{ at: 2, host: 'local', event: 'turn/completed', threadId: 't', turnId: 'one' }] },
  { cursor: 'two', reset: false, events: [] },
  { cursor: 'three', reset: true, events: [] }
 ];
 const urls: string[] = [];
 const history = createUsageHistory(async (url) => { urls.push(String(url)); return new Response(JSON.stringify(replies.shift())); });
 const first = await history.refresh('local', {});
 expect(first.weekly.tasks).toHaveLength(1);
 const second = await history.refresh('local', {});
 expect(second.weekly.tasks[0].endedAt).toBe(2);
 expect(await history.refresh('local', {})).toBe(second);
 expect((await history.refresh('local', {})).weekly.tasks).toHaveLength(0);
 expect(urls[1]).toContain('cursor=one');
 expect(urls[0]).toContain('incremental=1');
});

test('failed refreshes keep the last cursor so events are not lost', async () => {
 let call = 0; const urls: string[] = [];
 const history = createUsageHistory(async (url) => {
  urls.push(String(url)); call++;
  if (call === 2) return new Response('{}', { status: 503 });
  return new Response(JSON.stringify({ cursor: 'saved', reset: call === 1, events: [] }));
 });
 await history.refresh('local', {});
 await expect(history.refresh('local', {})).rejects.toThrow();
 await history.refresh('local', {});
 expect(urls[2]).toContain('cursor=saved');
});

test('a restored journal cache starts with a delta request', async () => {
 const saved = { cursor: 'disk', events: [{ at: 1, host: 'local', event: 'turn/started', threadId: 't', turnId: 'one' }] };
 const urls: string[] = [];
 const history = createUsageHistory(async (url) => { urls.push(url); return Response.json({ cursor: 'next', reset: false, events: [] }); }, {
  load: async () => saved, save: async () => {}
 });
 expect((await history.refresh('local', {})).weekly.tasks).toHaveLength(1);
 expect(urls[0]).toContain('cursor=disk');
});

test('unavailable caches fall back to the server and cache writes contain only appended events', async () => {
 const updates: any[] = [];
 let calls = 0;
 const history = createUsageHistory(async () => Response.json({ cursor: String(++calls), reset: calls === 1, events: [{ at: calls, host: 'local', event: 'metadata' }] }), {
  load: async () => { throw new Error('private browsing'); }, save: async update => { updates.push(update); throw new Error('quota'); }
 });
 await history.refresh('local', {}); await history.refresh('local', {});
 expect(updates[1]).toMatchObject({ previousCursor: '1', cursor: '2', reset: false });
 expect(updates[1].events).toHaveLength(1);
});

test('server reset replaces persisted history instead of retaining stale tasks', async () => {
 const saved = { cursor: 'stale', events: [{ at: 1, host: 'local', event: 'turn/started', threadId: 't', turnId: 'one' }] };
 const updates: any[] = [];
 const history = createUsageHistory(async () => Response.json({ cursor: 'fresh', reset: true, events: [] }), {
  load: async () => saved, save: async update => { updates.push(update); }
 });
 expect((await history.refresh('local', {})).weekly.tasks).toHaveLength(0);
 expect(updates).toEqual([{ previousCursor: 'stale', cursor: 'fresh', reset: true, events: [] }]);
});

test('alternating hosts keep their cached analyses and journal resets invalidate every host', async () => {
 let reset = true;
 const history = createUsageHistory(async () => { const data = { cursor: 'one', reset, events: [] }; reset = false; return Response.json(data); });
 const a = await history.refresh('local', {});
 const b = await history.refresh('claude', {});
 expect(await history.refresh('local', {})).toBe(a);
 expect(await history.refresh('claude', {})).toBe(b);
 reset = true;
 expect(await history.refresh('local', {})).not.toBe(a);
 expect(await history.refresh('claude', {})).not.toBe(b);
});

test('analysis cache evicts least-recently-used catalogs at four entries', async () => {
 let first = true;
 const history = createUsageHistory(async () => { const reset = first; first = false; return Response.json({ cursor: 'c', reset, events: [] }); });
 const a = await history.refresh('a', {});
 const b = await history.refresh('b', {});
 await history.refresh('c', {}); await history.refresh('d', {});
 expect(await history.refresh('a', {})).toBe(a);
 await history.refresh('e', {});
 expect(await history.refresh('b', {})).not.toBe(b);
 expect(await history.refresh('a', {})).toBe(a);
 const renamed = await history.refresh('a', { old: 'new' });
 expect(renamed).not.toBe(a);
});
