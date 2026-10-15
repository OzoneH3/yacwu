import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickerModels } from '../../scripts/copilot-backend.mjs';

test('Copilot does not advertise Auto or default aliases and defaults to explicit GPT-6 Luna', () => {
 const entries = pickerModels(['auto', 'default', 'gpt-6-luna', 'gpt-6.1-sol'].map(id => ({ id, name: id, description: '', usage: '1x', price: null, enabled: true, efforts: ['low', 'medium'], defaultEffort: 'medium' })));
 assert.deepEqual(entries.map(entry => entry.id), ['copilot/gpt-6-luna', 'copilot/gpt-6.1-sol']);
 assert.deepEqual(entries.filter(entry => entry.isDefault).map(entry => entry.id), ['copilot/gpt-6-luna']);
});


test('legacy Auto selects Luna explicitly and fails rather than using an account default when unavailable', async () => {
 const { CopilotAcpRuntime } = await import('../../scripts/copilot-acp-runtime.mjs');
 const runtime = new CopilotAcpRuntime({ command: ['unused'] });
 const sent = [];
 const connection = { request: async (method, params) => { sent.push({ method, params }); return {}; } };
 runtime.open.set('session', { options: [{ category: 'model', id: 'model', currentValue: 'auto', options: [{ value: 'auto' }, { value: 'gpt-6-luna' }] }], models: null, instructions: null });
 await runtime.configure(connection, 'session', { threadId: 'thread', model: 'copilot/auto' });
 assert.deepEqual(sent[0], { method: 'session/set_config_option', params: { sessionId: 'session', configId: 'model', value: 'gpt-6-luna' } });
 runtime.open.set('session', { options: [], models: null, instructions: null });
 await assert.rejects(runtime.configure(connection, 'session', { threadId: 'thread', model: 'copilot/auto' }), /Copilot model is unavailable: gpt-6-luna/);
});
