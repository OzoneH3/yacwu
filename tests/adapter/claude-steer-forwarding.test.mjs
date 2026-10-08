// Regression test against the external claude-codex adapter checkout (not
// part of this repository; see README "Alternative backends"). It pins down
// what a successful `turn/steer` from the Claude adapter does and does not
// prove, which the session relay's status wording depends on:
//
//   1. history storage   — the steered input is appended to the turn record;
//   2. runtime submission — the native runtime forwards it to a live turn
//                           only if it holds one for that thread;
//   3. model receipt     — never observable here (no model is run).
//
// When the adapter believes a turn is active but the native runtime holds
// no pending turn for the thread, `turn/steer` still succeeds: (1) happens,
// (2) silently does not. No paid model turn is involved.
//
// Run with: npm run test:adapter   (requires Node with node:sqlite)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const dist = resolve(import.meta.dirname, '../../claude-codex/dist/src');
const available = existsSync(join(dist, 'server.mjs'));

test(
	'adapter acknowledges a steer it records but does not forward',
	{ skip: available ? false : 'claude-codex checkout not built at claude-codex/dist' },
	async () => {
		const { SessionStore } = await import(pathToFileURL(join(dist, 'store.mjs')).href);
		const { NativeClaudeRuntime } = await import(pathToFileURL(join(dist, 'native-runtime.mjs')).href);
		const { CodexClaudeAppServer } = await import(pathToFileURL(join(dist, 'server.mjs')).href);
		const home = await mkdtemp(join(tmpdir(), 'yacwu-adapter-steer-'));
		const previousHome = process.env.CODEX_HOME;
		process.env.CODEX_HOME = home;
		try {
			const store = new SessionStore(join(home, 'state.sqlite'));
			const runtime = new NativeClaudeRuntime();
			const server = new CodexClaudeAppServer(store, runtime);
			const sent = [];
			const peer = { id: 'yacwu-test', send: (message) => sent.push(message), close() {} };
			const response = (id) => sent.find((message) => message.id === id);

			await server.handleRequest(peer, { jsonrpc: '2.0', id: 1, method: 'thread/start', params: { cwd: home } });
			const threadId = response(1)?.result?.thread?.id;
			assert.ok(threadId, 'thread/start returned a thread');

			// The adapter's bookkeeping says a turn is active (as after a turn
			// whose native query has already ended, or a restart), but the
			// native runtime holds no pending turn for this thread.
			const turnId = 'turn-relay-test';
			store.upsertTurn({
				id: turnId, threadId, status: 'inProgress', startedAt: 0, completedAt: null,
				durationMs: null, items: [], diff: '', error: null
			});
			server.activeTurnByThread.set(threadId, turnId);
			assert.equal(runtime.turns.size, 0);

			await server.handleRequest(peer, {
				jsonrpc: '2.0', id: 2, method: 'turn/steer',
				params: { threadId, expectedTurnId: turnId, input: [{ type: 'text', text: 'relayed message' }] }
			});

			// Acknowledged…
			assert.equal(response(2)?.error, undefined);
			assert.equal(response(2)?.result?.turnId, turnId);
			// …(1) stored in history…
			const stored = store.getTurn(turnId).items.filter((item) => item.type === 'userMessage');
			assert.deepEqual(stored.map((item) => item.content?.[0]?.text), ['relayed message']);
			// …(2) but not submitted to any runtime input.
			assert.equal(runtime.turns.size, 0);
			store.close?.();
		} finally {
			if (previousHome === undefined) delete process.env.CODEX_HOME;
			else process.env.CODEX_HOME = previousHome;
			await rm(home, { recursive: true, force: true });
		}
	}
);
