import { expect, test } from 'bun:test';
import { createClaudeRecoveryWorker } from '../../scripts/claude-quota-recovery.mjs';

const reason = "You've hit your session limit · resets 2:40am (Europe/Berlin)";
const queued = { threadId: 'research', turnId: 'limited', reason, reserve: 10, providerLimit: true, checkAt: 0 };
const healthy = async () => ({ rateLimits: { primary: { usedPercent: 0 }, secondary: { usedPercent: 20 } } });

test('recovery continues an explicitly queued failed session once through HTTP', async () => {
 let entries: any[] = [queued];
 const calls: string[] = [];
 const worker = createClaudeRecoveryWorker({ readUsage: healthy, store: { load: () => entries, save: value => { entries = value; } }, request: async (path, body) => {
  calls.push(path);
  if (path === '/api/threads?host=claude') return { data: [{ id: 'research' }] };
  if (body) { expect(body.text).toContain('finish only the remaining work'); return { turn: { id: 'continued' } }; }
  return { thread: { turns: [{ id: 'limited', status: 'failed', error: { message: reason } }] } };
 } });
 expect(await worker.poll()).toBe(0);
 expect(calls.filter(path => path.includes('/message'))).toHaveLength(1);
 await worker.poll();
 expect(calls.filter(path => path.includes('/message'))).toHaveLength(1);
 worker.close();
});

test('recovery drops archived sessions and superseded work without starting them', async () => {
 for (const archived of [true, false]) {
  let entries: any[] = [queued];
  const worker = createClaudeRecoveryWorker({ readUsage: healthy, store: { load: () => entries, save: value => { entries = value; } }, request: async (path, body) => {
   expect(body).toBeUndefined();
   return path === '/api/threads?host=claude' ? { data: archived ? [] : [{ id: 'research' }] } : { thread: { turns: [{ id: 'newer', status: 'completed' }] } };
  } });
  expect(await worker.poll()).toBe(0);
  worker.close();
 }
});

test('depleted or unknown allowance keeps explicit recovery queued', async () => {
 for (const primary of [null, { usedPercent: 100 }]) {
  let entries: any[] = [queued];
  const worker = createClaudeRecoveryWorker({ readUsage: async () => ({ rateLimits: { primary, secondary: { usedPercent: 0 } } }), store: { load: () => entries, save: value => { entries = value; } }, request: async () => { throw new Error('Must not request a start'); } });
  expect(await worker.poll()).toBe(1);
  expect(entries).toHaveLength(1);
  worker.close();
 }
});
