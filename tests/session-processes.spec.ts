import { expect, test } from '@playwright/test';

// A quiet Claude session still shows what it is running on this machine:
// its busiest worker processes with their CPU use, or that none is running.

const ID = 'procs-session';

test('a running Claude session shows its worker processes and CPU use', async ({ page }) => {
	await page.clock.install();
	const claude = { pid: 1, ppid: 0, command: '/x/claude-agent-sdk-linux-x64/claude --output-format stream-json', elapsedSeconds: 900, cpuCentiseconds: 500 };
	let stage = 0;
	const samples = [
		[claude, { pid: 3, ppid: 1, command: 'make -j1 release-check', elapsedSeconds: 800, cpuCentiseconds: 10 }, { pid: 4, ppid: 3, command: '/tmp/go-build/api.test', elapsedSeconds: 700, cpuCentiseconds: 1000 }],
		[claude, { pid: 3, ppid: 1, command: 'make -j1 release-check', elapsedSeconds: 810, cpuCentiseconds: 10 }, { pid: 4, ppid: 3, command: '/tmp/go-build/api.test', elapsedSeconds: 710, cpuCentiseconds: 1500 }],
		[claude]
	];
	const thread = { id: ID, name: 'procs', cwd: '/tmp', host: 'claude', status: { type: 'active' }, turns: [{ id: 't1', status: 'inProgress', items: [
		{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Run the release check' }] },
		{ type: 'mcpToolCall', id: 'w1', server: 'claude', tool: 'YacwuBackgroundWorker', status: 'inProgress', arguments: { description: 'Run make release-check' } }
	] }] };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/hosts') return route.fulfill({ json: { hosts: [{ name: 'local', kind: 'local', provider: 'codex' }, { name: 'claude', kind: 'local', provider: 'claude' }] } });
		if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/tmp' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [ID] } });
		if (path === `/api/threads/${ID}/processes`) return route.fulfill({ json: { at: 0, processes: samples[stage] } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'claude-opus-5-5', effort: 'medium', models: [{ id: 'claude-opus-5-5', displayName: 'Claude Opus 5.5', efforts: ['medium'] }] } });
		if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread } });
		return route.fulfill({ json: {} });
	});
	await page.goto(`/s/${ID}?host=claude`);
	const workers = page.locator('.working-processes');
	await expect(workers).toHaveText('⚙ make, api.test');
	// The next sample shows CPU use since the previous one.
	stage = 1;
	await page.clock.runFor(10_000);
	await expect(workers).toContainText(/api\.test \d+% CPU/);
	stage = 2;
	await page.clock.runFor(10_000);
	await expect(workers).toHaveText('⚙ no worker process running');
});
