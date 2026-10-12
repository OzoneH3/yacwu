// Project rules through the real session-launch path: an isolated Yacwu
// server (own HOME, state and port, no persistent backends) with the Claude
// adapter in mock mode, so no model is called. The mock echoes the system
// prompt addendum Claude would get; Codex sessions are checked through the
// developer instructions Yacwu recorded for them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const adapter = join(repo, 'claude-codex/dist/src/adapter.mjs');
const has = (cmd) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
const skip = !existsSync(adapter) ? 'Claude adapter checkout is not built'
	: !has('gleam') ? 'gleam is not installed'
	: !has('codex') ? 'codex is not installed'
	: false;

const RULE = 'Before making changes, identify your actual repository and worktree. If the instruction files are unavailable in this checkout, report that explicitly rather than claiming they were loaded.';

function git(cwd, ...args) {
	execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd, stdio: 'ignore' });
}

/** Main checkout (old commit without AGENTS.md), linked worktree, old checkout, separate clone, unrelated repo. */
function fixtures(root) {
	const main = join(root, 'growpilot');
	mkdirSync(main, { recursive: true });
	git(main, 'init', '-q');
	writeFileSync(join(main, 'app.txt'), 'app\n');
	git(main, 'add', '.');
	git(main, 'commit', '-qm', 'old');
	const old = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: main, encoding: 'utf8' }).trim();
	writeFileSync(join(main, 'AGENTS.md'), '# Shared policy\n');
	writeFileSync(join(main, 'CLAUDE.md'), '@AGENTS.md\n');
	git(main, 'add', '.');
	git(main, 'commit', '-qm', 'docs');
	const worktree = join(main, '.workspace/wt/feature');
	git(main, 'worktree', 'add', '-q', worktree, '-b', 'feature');
	const oldCheckout = join(root, 'growpilot-old');
	git(main, 'worktree', 'add', '-q', '--detach', oldCheckout, old);
	const clone = join(root, 'elsewhere/growpilot');
	git(root, 'clone', '-q', main, clone);
	const unrelated = join(root, 'unrelated');
	mkdirSync(unrelated);
	git(unrelated, 'init', '-q');
	git(unrelated, 'commit', '-q', '--allow-empty', '-m', 'x');
	return { main, worktree, oldCheckout, clone, unrelated };
}

const freePort = () => new Promise((resolve) => {
	const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

async function startServer(root) {
	const port = await freePort();
	const home = join(root, 'home');
	mkdirSync(home);
	const child = spawn('gleam', ['run'], {
		cwd: join(repo, 'server'),
		detached: true,
		stdio: ['ignore', 'pipe', 'pipe'],
		env: {
			...process.env,
			HOME: home,
			XDG_STATE_HOME: join(home, 'state'),
			PORT: String(port),
			YACWU_PERSISTENT_BACKENDS: '0',
			YACWU_INSECURE_SKIP_AUTH: '1',
			YACWU_BACKEND_ROOT: repo,
			YACWU_BACKENDS: `claude=node ./scripts/claude-backend.mjs ${adapter}`,
			CLAUDE_CODEX_MOCK: '1'
		}
	});
	let log = '';
	child.stdout.on('data', (data) => { log += data; });
	child.stderr.on('data', (data) => { log += data; });
	const base = `http://127.0.0.1:${port}/api`;
	for (let i = 0; i < 240; i++) {
		try { if ((await fetch(`${base}/hosts`)).ok) return { base, home, stop: () => { try { process.kill(-child.pid, 'SIGTERM'); } catch {} } }; } catch {}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	try { process.kill(-child.pid, 'SIGTERM'); } catch {}
	throw new Error(`server did not start:\n${log.slice(-2000)}`);
}

test('project rules reach Claude and Codex sessions per repository', { skip, timeout: 300_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), 'yacwu-rules-launch-'));
	const fx = fixtures(root);
	const server = await startServer(root);
	const json = async (path, body) => {
		const response = await fetch(`${server.base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		const data = await response.json();
		assert.ok(response.ok, `${path}: ${JSON.stringify(data)}`);
		return data;
	};
	const start = async (host, cwd) => (await json('/threads', { host, cwd })).thread.id;
	const rules = (id) => json(`/threads/${id}/project-rules`);
	// The mock runtime answers "system prompt check" with the addendum it got.
	const systemPrompt = async (id) => {
		await json(`/threads/${id}/message`, { text: 'system prompt check <!-- YACWU_ALLOWANCE_RESERVE percent=0 -->' });
		for (let i = 0; i < 60; i++) {
			const { thread } = await json(`/threads/${id}?turns=1`);
			const replies = thread.turns.flatMap((turn) => turn.items).filter((item) => item.type === 'agentMessage' && item.text);
			if (replies.length) return replies.at(-1).text;
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		assert.fail(`no mock reply for ${id}`);
	};
	const recorded = (id) => JSON.parse(readFileSync(join(server.home, 'state/yacwu/project-rules.json'), 'utf8')).threads[id];
	try {
		const before = await start('claude', fx.main);
		const project = (await rules(before)).current.project;
		assert.match(project, /^local:.*\/growpilot\/\.git$/);
		assert.equal((await json(`/threads/${before}/project-rules`, { text: RULE })).version, 1);

		// Claude and Codex in one repository share its rules.
		const claude = await start('claude', fx.main);
		// New Claude sessions name their model rather than a floating "default".
		assert.equal((await json(`/threads/${claude}/model`)).model, 'claude-opus-5-5');
		const applied = (await rules(claude)).applied;
		assert.equal(applied.project, project);
		assert.equal(applied.version, 1);
		const claudePrompt = await systemPrompt(claude);
		assert.ok(claudePrompt.includes('Project rules (version 1'), claudePrompt);
		assert.ok(claudePrompt.includes(RULE));
		const codex = await start('local', fx.main);
		const codexRules = await rules(codex);
		assert.equal(codexRules.current.project, project);
		assert.equal(codexRules.status, 'current');
		assert.equal(recorded(codex).version, 1);
		assert.ok(recorded(codex).instructions.includes(RULE));

		// Linked worktrees and older checkouts of the repository get them too.
		for (const cwd of [fx.worktree, fx.oldCheckout]) {
			const id = await start('claude', cwd);
			assert.equal((await rules(id)).current.project, project);
			assert.ok((await systemPrompt(id)).includes(RULE));
		}
		assert.equal(existsSync(join(fx.oldCheckout, 'AGENTS.md')), false);

		// A separate clone with the same folder name and an unrelated repository do not.
		for (const cwd of [fx.clone, fx.unrelated]) {
			const id = await start('claude', cwd);
			const state = await rules(id);
			assert.notEqual(state.current.project, project);
			assert.equal(state.current.version, 0);
			assert.ok(!(await systemPrompt(id)).includes(RULE));
		}

		// An update reaches new sessions; existing ones keep and report their version.
		assert.equal((await json(`/threads/${claude}/project-rules`, { text: `${RULE} Mention the version.` })).version, 2);
		assert.equal((await rules(before)).status, 'outdated');
		assert.equal((await rules(claude)).status, 'outdated');
		assert.equal((await rules(codex)).status, 'outdated');
		assert.ok((await systemPrompt(claude)).includes('Project rules (version 1'));
		const fresh = await start('claude', fx.main);
		assert.ok((await systemPrompt(fresh)).includes('Project rules (version 2'));
		assert.equal((await rules(fresh)).status, 'current');
	} finally {
		server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test('a question asked through a tool call waits for the user and gets their answer', { skip, timeout: 300_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), 'yacwu-ask-'));
	const server = await startServer(root);
	const call = async (path, body) => {
		const response = await fetch(`${server.base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		return { ok: response.ok, data: await response.json() };
	};
	try {
		const { data: created } = await call('/threads', { host: 'claude', cwd: root });
		const id = created.thread.id;
		await call(`/threads/${id}/message`, { text: 'ask user question check <!-- YACWU_ALLOWANCE_RESERVE percent=0 -->' });
		let question = null;
		for (let i = 0; i < 60 && !question; i++) {
			const { data } = await call(`/threads/${id}?turns=1`);
			question = data.thread.turns.flatMap((turn) => turn.items).find((item) => item.type === 'dynamicToolCall' && item.tool === 'AskUserQuestion' && item.status === 'inProgress');
			if (!question) await new Promise((resolve) => setTimeout(resolve, 500));
		}
		assert.ok(question, 'the question item never appeared');
		// It waits: no answer was invented for the user.
		await new Promise((resolve) => setTimeout(resolve, 1000));
		assert.equal((await call(`/threads/${id}?turns=1`)).data.thread.turns.at(-1).status, 'inProgress');
		const answered = await call(`/threads/${id}/user-input`, { itemId: question.id, answers: { q0: { answers: ['API Key'] } } });
		assert.ok(answered.ok, JSON.stringify(answered.data));
		let reply = '';
		for (let i = 0; i < 60 && !reply.includes('API Key'); i++) {
			const { data } = await call(`/threads/${id}?turns=1`);
			reply = data.thread.turns.flatMap((turn) => turn.items).filter((item) => item.type === 'agentMessage').map((item) => item.text).join('\n');
			if (!reply.includes('API Key')) await new Promise((resolve) => setTimeout(resolve, 500));
		}
		assert.ok(reply.includes('API Key'), reply);
		// A second answer to the same question is refused.
		assert.equal((await call(`/threads/${id}/user-input`, { itemId: question.id, answers: { q0: { answers: ['OAuth'] } } })).ok, false);
	} finally {
		server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
