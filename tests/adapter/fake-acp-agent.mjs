// A scripted stand-in for `copilot --acp`: answers the ACP calls Yacwu's
// Copilot runtime makes and logs every message it receives (one JSON line
// each) to FAKE_ACP_LOG. The prompt text picks the behaviour:
//   "tool"  runs a shell command (asking permission first), then replies
//   "edit"  edits a file
//   "slow"  streams one chunk and waits until cancelled
//   "wait"  streams one chunk and ends 0.4 s later
//   anything else replies "Echo: <text>"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const log = process.env.FAKE_ACP_LOG;
const historyPath = process.env.FAKE_ACP_HISTORY;
/** Sessions' user messages survive restarts, so session/load can replay them. */
const history = historyPath && existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, 'utf8')) : {};
const options = () => [
	{ type: 'select', id: 'mode', category: 'mode', currentValue: 'https://agentclientprotocol.com/protocol/session-modes#agent', options: [{ value: 'https://agentclientprotocol.com/protocol/session-modes#agent', name: 'Agent' }, { value: 'https://agentclientprotocol.com/protocol/session-modes#plan', name: 'Plan' }] },
	{ type: 'select', id: 'model', category: 'model', currentValue: 'claude-sonnet-4.5', options: [{ value: 'gpt-5', name: 'GPT-5' }, { value: 'claude-sonnet-4.5', name: 'Claude Sonnet 4.5' }] },
	{ type: 'select', id: 'allow_all', category: 'permissions', currentValue: 'off', options: [{ value: 'on', name: 'On' }, { value: 'off', name: 'Off' }] }
];
const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
const update = (sessionId, body) => send({ method: 'session/update', params: { sessionId, update: body } });
let nextId = 100;
const waiting = new Map();
const ask = (method, params) => new Promise((resolve) => { const id = nextId++; waiting.set(id, resolve); send({ id, method, params }); });
const cancelled = new Map();
const cwds = new Map();

createInterface({ input: process.stdin }).on('line', async (line) => {
	const message = JSON.parse(line);
	if (log) appendFileSync(log, `${line}\n`);
	if (message.id != null && !message.method) { waiting.get(message.id)?.(message.result); waiting.delete(message.id); return; }
	const { id, method, params } = message;
	if (method === 'initialize') return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} }, promptCapabilities: { image: true } }, authMethods: [] } });
	if (method === 'session/new') {
		const sessionId = randomUUID();
		history[sessionId] = [];
		cwds.set(sessionId, params.cwd);
		return send({ id, result: { sessionId, configOptions: options() } });
	}
	if (method === 'session/load') {
		cwds.set(params.sessionId, params.cwd);
		for (const text of history[params.sessionId] ?? []) {
			update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text } });
			update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old reply' } });
		}
		return send({ id, result: { configOptions: options() } });
	}
	if (method === 'session/close') return send({ id, result: {} });
	if (method === 'session/set_config_option') return send({ id, result: { configOptions: options().map((o) => o.id === params.configId ? { ...o, currentValue: params.value } : o) } });
	if (method === 'session/cancel') { cancelled.get(params.sessionId)?.(); return; }
	if (method === 'session/prompt') {
		const sessionId = params.sessionId;
		const texts = params.prompt.filter((b) => b.type === 'text').map((b) => b.text);
		(history[sessionId] ??= []).push(...texts);
		if (historyPath) writeFileSync(historyPath, JSON.stringify(history));
		const text = texts.at(-1);
		if (text.includes('slow')) {
			update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Working' } });
			await new Promise((resolve) => cancelled.set(sessionId, resolve));
			return send({ id, result: { stopReason: 'cancelled' } });
		}
		if (text.includes('wait')) {
			update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Waiting' } });
			await new Promise((resolve) => setTimeout(resolve, 400));
			return send({ id, result: { stopReason: 'end_turn' } });
		}
		if (text.includes('tool')) {
			update(sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Thinking about it' } });
			update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'Say hi', kind: 'execute', status: 'pending', rawInput: { command: 'echo hi', description: 'Say hi' } });
			const answer = await ask('session/request_permission', { sessionId, toolCall: { toolCallId: 'call_1', title: 'Say hi', kind: 'execute', rawInput: { command: 'echo hi' } }, options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' }] });
			if (log) appendFileSync(log, `${JSON.stringify({ permissionAnswer: answer })}\n`);
			update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', content: [{ type: 'content', content: { type: 'text', text: 'hi\n' } }] });
			update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call_1', status: 'completed', rawOutput: { content: 'hi\n' } });
			update(sessionId, { sessionUpdate: 'plan', entries: [{ content: 'Say hi', priority: 'high', status: 'completed' }] });
			update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
			return send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 7, totalTokens: 127, cachedReadTokens: 20 } } });
		}
		if (text.includes('edit')) {
			const diff = { type: 'diff', path: `${cwds.get(sessionId)}/a.txt`, oldText: 'one', newText: 'two' };
			update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'call_2', title: 'Edit a.txt', kind: 'edit', status: 'pending', rawInput: { path: diff.path, old_str: 'one', new_str: 'two' }, content: [diff] });
			update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'call_2', status: 'completed', content: [diff], rawOutput: { content: 'File updated.' } });
			update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Edited.' } });
			return send({ id, result: { stopReason: 'end_turn' } });
		}
		update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Echo: ${text}` } });
		return send({ id, result: { stopReason: 'end_turn' } });
	}
	if (id != null) send({ id, error: { code: -32601, message: `unknown method ${method}` } });
});
