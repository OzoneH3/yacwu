// The Copilot backend end to end over the app-server protocol: Yacwu's
// requests in, claude-codex's server, the ACP runtime, and a scripted ACP
// agent (or, with YACWU_TEST_COPILOT_CLI, the real Copilot CLI against a
// fake OpenAI-compatible provider). No model is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const adapter = join(repo, 'claude-codex/dist/src/adapter.mjs');
const fakeAgent = fileURLToPath(new URL('./fake-acp-agent.mjs', import.meta.url));
const skip = existsSync(adapter) ? false : 'Claude adapter checkout is not built';

/** The backend as Yacwu runs it, with a minimal app-server client. */
function backend(env) {
	const child = spawn(process.execPath, [join(repo, 'scripts/copilot-backend.mjs'), adapter], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
	let nextId = 1;
	const waiting = new Map();
	const notes = [];
	const listeners = new Set();
	createInterface({ input: child.stdout }).on('line', (line) => {
		const message = JSON.parse(line);
		if (message.id != null && !message.method) {
			const done = waiting.get(message.id);
			waiting.delete(message.id);
			if (message.error) done?.reject(new Error(message.error.message));
			else done?.resolve(message.result);
		} else if (message.method && message.id != null) {
			// Approval requests: accept.
			child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { decision: 'accept' } })}\n`);
			notes.push(message);
		} else {
			notes.push(message);
			for (const listener of listeners) listener(message);
		}
	});
	const request = (method, params) => new Promise((resolve, reject) => {
		const id = nextId++;
		waiting.set(id, { resolve, reject });
		child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
	});
	const next = (match, timeoutMs = 20_000) => new Promise((resolve, reject) => {
		const found = notes.find(match);
		if (found) return resolve(found);
		const timer = setTimeout(() => { listeners.delete(listener); reject(new Error('timed out waiting for a notification')); }, timeoutMs);
		const listener = (message) => { if (match(message)) { clearTimeout(timer); listeners.delete(listener); resolve(message); } };
		listeners.add(listener);
	});
	/** Run one turn to its end; its items and the turn/completed notification. */
	const turn = async (threadId, text) => {
		const from = notes.length;
		const started = await request('turn/start', { threadId, input: [{ type: 'text', text }] });
		const completed = await next((m, i) => m.method === 'turn/completed' && m.params.turn.id === started.turn.id);
		const mine = notes.slice(from);
		return { started, completed, items: mine.filter((m) => m.method === 'item/completed').map((m) => m.params.item), notes: mine };
	};
	const stop = () => new Promise((resolve) => { child.once('exit', resolve); child.stdin.end(); setTimeout(() => child.kill(), 3000).unref(); });
	return { child, request, next, notes, turn, stop };
}

async function connect(env) {
	const server = backend(env);
	await server.request('initialize', { clientInfo: { name: 'test', version: '0' }, capabilities: { experimentalApi: true } });
	server.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
	return server;
}

const logOf = (path) => existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];

test('Copilot sessions run, resume after a restart, and stop through the ACP runtime', { skip, timeout: 120_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), 'yacwu-copilot-'));
	const cwd = join(root, 'project');
	mkdirSync(cwd);
	const log = join(root, 'acp.jsonl');
	const env = { HOME: root, XDG_STATE_HOME: join(root, 'state'), CODEX_HOME: join(root, 'codex'), COPILOT_HOME: join(root, 'copilot'), YACWU_COPILOT_CLI: `${process.execPath} ${fakeAgent}`, FAKE_ACP_LOG: log, FAKE_ACP_HISTORY: join(root, 'history.json') };
	let server = await connect(env);
	try {
		const { data: models } = await server.request('model/list', {});
		assert.deepEqual(models.map((m) => [m.id, m.displayName]), [['copilot/auto', 'Copilot · auto'], ['copilot/gpt-5', 'Copilot · GPT-5'], ['copilot/claude-sonnet-4.5', 'Copilot · Claude Sonnet 4.5']]);
		assert.equal(existsSync(join(root, 'state/yacwu/copilot-adapter/copilot-models.json')), true, 'model list is cached in the Copilot adapter home');

		const { thread } = await server.request('thread/start', { cwd, model: 'copilot/gpt-5', approvalPolicy: 'never', sandbox: 'danger-full-access', developerInstructions: 'RULE-X' });
		const first = await server.turn(thread.id, 'run a tool');
		assert.equal(first.completed.params.turn.status, 'completed');
		const command = first.items.find((item) => item.type === 'commandExecution');
		assert.equal(command?.command, 'echo hi');
		assert.match(String(command?.aggregatedOutput), /hi/);
		assert.equal(first.items.find((item) => item.type === 'agentMessage')?.text, 'Done.');
		assert.ok(first.items.some((item) => item.type === 'reasoning'), 'thinking is shown');
		assert.ok(first.notes.some((m) => m.method === 'turn/plan/updated' && m.params.plan[0]?.step === 'Say hi'), 'Copilot plans become the turn plan');
		assert.ok(first.notes.some((m) => m.method === 'thread/tokenUsage/updated' && m.params.tokenUsage.last.totalTokens > 0), 'token usage is reported');

		let sent = logOf(log);
		const sessions = sent.filter((m) => m.method === 'session/new');
		const prompts = () => logOf(log).filter((m) => m.method === 'session/prompt');
		assert.equal(sessions.length, 2, 'one throwaway session for the model list, one for the thread');
		assert.ok(sent.some((m) => m.method === 'session/set_config_option' && m.params.configId === 'model' && m.params.value === 'gpt-5'), 'the chosen model is selected');
		assert.ok(sent.some((m) => m.method === 'session/set_config_option' && m.params.configId === 'allow_all' && m.params.value === 'on'), 'full access turns on allow-all');
		assert.match(prompts()[0].params.prompt[0].text, /^<yacwu-instructions>[\s\S]*RULE-X/);

		const second = await server.turn(thread.id, 'hello again');
		assert.equal(second.items.find((item) => item.type === 'agentMessage')?.text, 'Echo: hello again');
		assert.equal(logOf(log).filter((m) => m.method === 'session/new').length, 2, 'the thread keeps its Copilot session');
		assert.equal(prompts()[1].params.prompt.length, 1, 'instructions are not repeated');

		await server.stop();
		server = await connect(env);
		const resumed = await server.turn(thread.id, 'after restart');
		assert.deepEqual(resumed.items.filter((item) => item.type === 'agentMessage').map((item) => item.text), ['Echo: after restart'], 'the replayed history is not shown again');
		sent = logOf(log);
		assert.equal(sent.filter((m) => m.method === 'session/load').at(-1)?.params.sessionId, prompts()[1].params.sessionId, 'the earlier Copilot session is reopened');
		assert.equal(prompts().at(-1).params.prompt.length, 1, 'instructions already in the reopened history are not repeated');

		const edit = await server.turn(thread.id, 'edit the file');
		const change = edit.items.find((item) => item.type === 'fileChange');
		assert.equal(change?.changes[0]?.path, join(cwd, 'a.txt'));

		// A message sent while Copilot works becomes the next prompt of the same turn.
		const waiting = await server.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'wait a moment' }] });
		await server.next((m) => m.method === 'item/agentMessage/delta' && m.params.turnId === waiting.turn.id);
		await server.request('turn/steer', { threadId: thread.id, expectedTurnId: waiting.turn.id, input: [{ type: 'text', text: 'and also this' }] });
		const steered = await server.next((m) => m.method === 'turn/completed' && m.params.turn.id === waiting.turn.id);
		assert.equal(steered.params.turn.status, 'completed');
		assert.deepEqual(prompts().slice(-2).map((m) => m.params.prompt.at(-1).text), ['wait a moment', 'and also this']);
		assert.ok(server.notes.some((m) => m.method === 'item/completed' && m.params.turnId === waiting.turn.id && m.params.item.type === 'agentMessage' && m.params.item.text === 'Echo: and also this'));

		const started = await server.request('turn/start', { threadId: thread.id, input: [{ type: 'text', text: 'slow work' }] });
		await server.next((m) => m.method === 'item/agentMessage/delta' && m.params.turnId === started.turn.id);
		await server.request('turn/interrupt', { threadId: thread.id, turnId: started.turn.id });
		const stopped = await server.next((m) => m.method === 'turn/completed' && m.params.turn.id === started.turn.id);
		assert.equal(stopped.params.turn.status, 'interrupted');
		for (let i = 0; i < 50 && !logOf(log).some((m) => m.method === 'session/cancel'); i++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.ok(logOf(log).some((m) => m.method === 'session/cancel'), 'Stop cancels the Copilot prompt');
	} finally {
		await server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test('without full access, Copilot asks Yacwu before running a tool', { skip, timeout: 60_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), 'yacwu-copilot-ask-'));
	const log = join(root, 'acp.jsonl');
	const server = await connect({ HOME: root, XDG_STATE_HOME: join(root, 'state'), CODEX_HOME: join(root, 'codex'), YACWU_COPILOT_CLI: `${process.execPath} ${fakeAgent}`, FAKE_ACP_LOG: log });
	try {
		const { thread } = await server.request('thread/start', { cwd: root, model: 'copilot/auto', approvalPolicy: 'on-request', sandbox: 'workspace-write' });
		const result = await server.turn(thread.id, 'run a tool');
		assert.equal(result.completed.params.turn.status, 'completed');
		assert.ok(server.notes.some((m) => m.id != null && /approval/i.test(m.method)), 'Yacwu was asked to approve the command');
		assert.deepEqual(logOf(log).find((m) => m.permissionAnswer)?.permissionAnswer, { outcome: { outcome: 'selected', optionId: 'allow_once' } });
		assert.ok(!logOf(log).some((m) => m.method === 'session/set_config_option' && m.params.configId === 'model'), 'auto leaves Copilot\'s model choice alone');
	} finally {
		await server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

// The real Copilot CLI in offline mode with a fake model provider: checks
// the runtime against Copilot's actual ACP messages without an account.
const cli = process.env.YACWU_TEST_COPILOT_CLI;
test('the real Copilot CLI runs a turn with a shell command', { skip: skip || (cli ? false : 'set YACWU_TEST_COPILOT_CLI to a copilot binary'), timeout: 180_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), 'yacwu-copilot-cli-'));
	let calls = 0;
	const provider = createServer(async (req, res) => {
		for await (const _ of req);
		if (!req.url.includes('chat/completions')) { res.writeHead(404); res.end(); return; }
		calls++;
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		const chunk = (delta, finish = null, usage) => res.write(`data: ${JSON.stringify({ id: `c${calls}`, object: 'chat.completion.chunk', created: 1, model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`);
		chunk({ role: 'assistant', content: '' });
		if (calls === 1) {
			chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'echo copilot-ran-this', description: 'Echo a word' }) } }] });
			chunk({}, 'tool_calls');
		} else {
			chunk({ content: 'All done.' });
			chunk({}, 'stop', { prompt_tokens: 50, completion_tokens: 3, total_tokens: 53 });
		}
		res.end('data: [DONE]\n\n');
	});
	await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
	const server = await connect({ HOME: root, XDG_STATE_HOME: join(root, 'state'), CODEX_HOME: join(root, 'codex'), COPILOT_HOME: join(root, 'copilot'), YACWU_COPILOT_CLI: cli, COPILOT_OFFLINE: 'true', COPILOT_AUTO_UPDATE: 'false', COPILOT_PROVIDER_BASE_URL: `http://127.0.0.1:${provider.address().port}/v1`, COPILOT_PROVIDER_API_KEY: 'fake-provider-key-123', COPILOT_MODEL: 'claude-sonnet-4.5' });
	try {
		writeFileSync(join(root, 'README'), 'x\n');
		const { thread } = await server.request('thread/start', { cwd: root, model: 'copilot/auto', approvalPolicy: 'never', sandbox: 'danger-full-access' });
		const result = await server.turn(thread.id, 'run the echo');
		assert.equal(result.completed.params.turn.status, 'completed');
		const command = result.items.find((item) => item.type === 'commandExecution');
		assert.equal(command?.command, 'echo copilot-ran-this');
		assert.match(String(command?.aggregatedOutput), /copilot-ran-this/);
		assert.equal(result.items.filter((item) => item.type === 'agentMessage').at(-1)?.text, 'All done.');
	} finally {
		await server.stop();
		provider.close();
		rmSync(root, { recursive: true, force: true });
	}
});
