import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CopilotAcpRuntime } from '../../scripts/copilot-acp-runtime.mjs';

test('live ACP context is separate from billable usage, supports compaction and zero', async () => {
 const runtime = new CopilotAcpRuntime({ command: ['unused'] });
 const contexts = [], events = [];
 runtime.onContextUsage = (threadId, usage) => contexts.push({ threadId, ...usage });
 const connection = { request: async () => ({ sessionId: 'session', configOptions: [] }) };
 await runtime.session(connection, { threadId: 'thread', cwd: '/project' }, { onEvent: async e => events.push(e) });
 runtime.bySession.set('session', { handlers: { onEvent: async e => events.push(e) }, events: Promise.resolve() });
 for (const used of [53000, 20000, 0]) runtime.update('session', { sessionUpdate: 'usage_update', used, size: 200000, cost: { amount: 10, currency: 'USD' } });
 await runtime.bySession.get('session').events;
 assert.deepEqual(contexts, [53000, 20000, 0].map(used => ({ threadId: 'thread', used, size: 200000 })));
 assert.deepEqual(runtime.contextUsage.get('thread'), { used: 0, size: 200000 });
 assert.equal(events.some(e => e.type === 'usage'), false);
});

test('context replay survives load, rejects invalid payloads and ignores unknown sessions', async () => {
 const runtime = new CopilotAcpRuntime({ command: ['unused'] });
 const connection = { request: async () => {
  runtime.update('existing', { sessionUpdate: 'usage_update', used: 40000, size: 100000 });
  return {};
 } };
 await runtime.session(connection, { threadId: 'thread', claudeSessionId: 'existing', cwd: '/project' }, { onEvent: async () => {} });
 assert.deepEqual(runtime.contextUsage.get('thread'), { used: 40000, size: 100000 });
 for (const [used, size] of [[null, 100], [-1, 100], [NaN, 100], [1, 0], [1, '100'], [1.5, 100]]) runtime.update('existing', { sessionUpdate: 'usage_update', used, size });
 runtime.update('unknown', { sessionUpdate: 'usage_update', used: 1, size: 100 });
 assert.deepEqual([...runtime.contextUsage], [['thread', { used: 40000, size: 100000 }]]);
});
