import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CopilotAcpRuntime } from '../../scripts/copilot-acp-runtime.mjs';

function setup(failLoad = false) {
 const runtime = new CopilotAcpRuntime({ command: ['unused'] });
 const calls = [];
 const connection = { request: async (method, params) => {
  calls.push({ method, params });
  if (method === 'session/load' && failLoad) throw new Error('temporary load failure');
  return { sessionId: 'fresh', configOptions: [] };
 } };
 const context = { threadId: 'thread', claudeSessionId: 'existing', cwd: '/project/new' };
 return { runtime, calls, connection, context, handlers: { onEvent: async () => {} } };
}

test('moving an open Copilot conversation reloads the same ID at the new cwd and keeps instructions', async () => {
 const h = setup();
 h.runtime.open.set('existing', { cwd: '/project/old', options: [], models: null, instructions: 'RULE' });
 assert.equal(await h.runtime.session(h.connection, h.context, h.handlers), 'existing');
 assert.deepEqual(h.calls, [{ method: 'session/load', params: { sessionId: 'existing', cwd: '/project/new', mcpServers: [] } }]);
 assert.equal(h.runtime.open.get('existing').cwd, '/project/new');
 assert.equal(h.runtime.open.get('existing').instructions, 'RULE');
});

test('a failed reopen never starts a replacement conversation or sends a prompt', async () => {
 const h = setup(true);
 await assert.rejects(h.runtime.session(h.connection, h.context, h.handlers), /could not reopen.*existing/i);
 assert.deepEqual(h.calls.map(c => c.method), ['session/load']);
 assert.equal(h.runtime.open.has('existing'), false);
});

test('a failed folder reload retains its prior session state for retry', async () => {
 const h = setup(true);
 const state = { cwd: '/project/old', options: [], models: null, instructions: 'RULE' };
 h.runtime.open.set('existing', state);
 await assert.rejects(h.runtime.session(h.connection, h.context, h.handlers), /could not reopen/i);
 assert.equal(h.runtime.open.get('existing'), state);
 assert.deepEqual(h.calls.map(c => c.method), ['session/load']);
});

test('moving a busy session is rejected, while reusing an idle session in the same cwd is unchanged', async () => {
 const h = setup();
 h.runtime.open.set('existing', { cwd: '/project/old', options: [], models: null, instructions: null });
 h.runtime.bySession.set('existing', {});
 await assert.rejects(h.runtime.session(h.connection, h.context, h.handlers), /running.*folder|folder.*running/i);
 h.runtime.bySession.delete('existing');
 assert.equal(await h.runtime.session(h.connection, { ...h.context, cwd: '/project/old' }, h.handlers), 'existing');
 assert.deepEqual(h.calls, []);
});
