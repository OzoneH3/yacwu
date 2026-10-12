// A task cut off by a crashed backend is continued without anyone pressing
// Continue: Yacwu notices the turn is gone once the backend is back and sends
// the restart continuation prompt. Mock Claude backend, no model calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adapter, skip, startServer } from './yacwu-server.mjs';

/** Every process below `root`, as [pid, command line]. */
function descendants(root) {
	const table = execFileSync('ps', ['-eo', 'pid=,ppid=,args='], { encoding: 'utf8' }).trim().split('\n')
		.map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
		.map(([, pid, ppid, args]) => ({ pid: Number(pid), ppid: Number(ppid), args }));
	const found = [];
	const walk = (pid) => { for (const child of table.filter((row) => row.ppid === pid)) { found.push(child); walk(child.pid); } };
	walk(root);
	return found;
}

test('a turn cut off by a crashed backend is continued automatically', { skip, timeout: 300_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), 'yacwu-recovery-'));
	// The adapter without Yacwu's wrapper: its allowance guard cannot read
	// usage offline and would refuse the continued turn.
	const server = await startServer(root, { claudeBackend: `node ./scripts/claude-adapter-entry.mjs ${adapter} app-server --listen stdio://` });
	const call = async (path, body) => {
		const response = await fetch(`${server.base}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		return response.json();
	};
	const items = async (id) => (await call(`/threads/${id}?turns=1`)).thread?.turns?.flatMap((turn) => turn.items) ?? [];
	try {
		const id = (await call('/threads', { host: 'claude', cwd: root })).thread.id;
		// This mock turn waits for an answer, so it is still running when the backend dies.
		await call(`/threads/${id}/message`, { text: 'ask user question check <!-- YACWU_ALLOWANCE_RESERVE percent=0 -->' });
		for (let i = 0; i < 60 && !(await items(id)).some((item) => item.type === 'dynamicToolCall'); i++) await new Promise((resolve) => setTimeout(resolve, 500));
		const backend = descendants(server.pid).filter((proc) => /claude-(backend|adapter-entry)\.mjs/.test(proc.args));
		assert.ok(backend.length, 'the Claude backend process was not found');
		for (const proc of [...backend, ...backend.flatMap((proc) => descendants(proc.pid))]) {
			try { process.kill(proc.pid, 'SIGKILL'); } catch {}
		}
		let continued = false;
		for (let i = 0; i < 120 && !continued; i++) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			try {
				continued = (await items(id)).some((item) => item.type === 'userMessage'
					&& JSON.stringify(item.content ?? '').includes('interrupted by an app restart'));
			} catch { /* the backend is coming back */ }
		}
		assert.ok(continued, 'the cut-off task was not continued');
	} finally {
		server.stop();
		rmSync(root, { recursive: true, force: true });
	}
});
