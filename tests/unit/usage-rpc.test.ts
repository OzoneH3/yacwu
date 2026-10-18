import { expect, test } from 'bun:test';
import { createUsageResponder } from '../../src/lib/usage-rpc';
import { createUsageClient } from '../../src/lib/usage-client';
import { analyzeUsage } from '../../src/lib/usage-analysis';
const snapshot = () => ({ weekly: analyzeUsage([]), fiveHour: analyzeUsage([]) });

test('unchanged replies omit the large result and new evidence gets a new revision', async () => {
 let result = snapshot();
 const reply = createUsageResponder(async () => result);
 const request = { id: 1, host: 'local', names: {} };
 const first = await reply(request);
 expect(first.result).toBe(result);
 expect(await reply({ ...request, knownVersion: first.version })).toEqual({ id: 1, version: first.version, unchanged: true });
 result = snapshot();
 expect((await reply({ ...request, knownVersion: first.version })).version).not.toBe(first.version);
});

test('client coalesces requests, preserves unchanged identity, and resets revisions after a crash', async () => {
 const sent: any[] = [];
 const workers: any[] = [];
 const load = createUsageClient(() => {
  const worker = { postMessage(message: any) { sent.push(message); }, terminate() {}, onmessage: null, onerror: null };
  workers.push(worker); return worker as unknown as Worker;
 });
 const first = load('local', {});
 expect(load('local', {})).toBe(first);
 expect(sent).toHaveLength(1);
 const result = snapshot();
 workers[0].onmessage({ data: { id: sent[0].id, version: 1, result } });
 expect(await first).toBe(result);
 const second = load('local', {});
 expect(sent[1].knownVersion).toBe(1);
 workers[0].onmessage({ data: { id: sent[1].id, version: 1, unchanged: true } });
 expect(await second).toBe(result);
 const failed = load('local', {});
 workers[0].onerror({ message: 'crash' });
 await expect(failed).rejects.toThrow('crash');
 const restarted = load('local', {});
 expect(workers).toHaveLength(2); expect(sent.at(-1).knownVersion).toBeUndefined();
 workers[1].onmessage({ data: { id: sent.at(-1).id, version: 1, result: snapshot() } });
 expect(await restarted).not.toBe(result);
});
