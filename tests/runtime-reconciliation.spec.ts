import { expect, test } from '@playwright/test';

test('loaded Claude thread becoming interrupted clears running UI without a completion event', async ({ page }) => {
	const id = 'claude-interrupted-task';
	let interrupted = false;
	const thread = () => ({ id, host: 'claude', name: 'Claude test', cwd: '/tmp', status: { type: interrupted ? 'idle' : 'active' },
		turns: [{ id: 'turn-test', status: interrupted ? 'interrupted' : 'inProgress', items: [], error: interrupted ? { message: 'server restarted before completing turn' } : null }] });
	await page.addInitScript(({ id }) => localStorage.setItem('yacwu-running-tasks', JSON.stringify({ [id]: id })), { id });
	await page.clock.install();
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		let data: object = {};
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') data = { data: [thread()], defaultCwd: '/tmp' };
		else if (path === '/api/threads/loaded') data = { data: [id] };
		else if (path.endsWith('/model')) data = { model: 'sonnet', effort: 'medium', models: [] };
		else if (path.startsWith(`/api/threads/${id}`)) data = { thread: thread() };
		await route.fulfill({ json: data });
	});
	await page.goto(`/s/${id}?host=claude`);
	await expect(page.getByRole('button', { name: 'Stop current turn', exact: true })).toBeVisible();
	interrupted = true;
	await page.clock.fastForward(16000);
	await expect(page.getByRole('button', { name: 'Continue interrupted task', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Stop current turn', exact: true })).toHaveCount(0);
	await expect(page.getByText('Task interrupted. Reason: server restarted before completing turn Use Continue interrupted task to resume.', { exact: true })).toBeVisible();
});

async function restartedSession(page: import('@playwright/test').Page, status: string, turnStatus: string) {
	const id = 'claude-after-restart';
	const thread = () => ({ id, host: 'claude', name: 'Claude test', cwd: '/tmp', status: { type: status },
		turns: [{ id: 'turn-live', status: turnStatus, items: [], error: null }] });
	await page.addInitScript(({ id }) => localStorage.setItem('yacwu-running-tasks', JSON.stringify({ [id]: id })), { id });
	await page.clock.install();
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		let data: object = {};
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') data = { data: [thread()], defaultCwd: '/tmp' };
		// A persistent backend Yacwu just reconnected to lists no loaded threads.
		else if (path === '/api/threads/loaded') data = { data: [] };
		else if (path.endsWith('/model')) data = { model: 'sonnet', effort: 'medium', models: [] };
		else if (path.startsWith(`/api/threads/${id}`)) data = { thread: thread() };
		await route.fulfill({ json: data });
	});
	await page.goto(`/s/${id}?host=claude`);
	await page.clock.fastForward(16000);
}

test('a turn still running in a persistent backend after a restart is not flagged as interrupted', async ({ page }) => {
	await restartedSession(page, 'active', 'inProgress');
	await expect(page.getByRole('button', { name: 'Stop current turn', exact: true })).toBeVisible();
	await page.clock.fastForward(16000);
	await expect(page.getByRole('button', { name: 'Continue interrupted task', exact: true })).toHaveCount(0);
	await expect(page.getByText(/Task interrupted/)).toHaveCount(0);
});

test('a thread its backend no longer runs is still flagged after a restart', async ({ page }) => {
	await restartedSession(page, 'notLoaded', 'inProgress');
	await expect(page.getByRole('button', { name: 'Continue interrupted task', exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Stop current turn', exact: true })).toHaveCount(0);
});

test('a compact stopped status hydrates missed final output once', async ({ page }) => {
 const id = 'missed-final-output'; let stopped = false; let historyReads = 0;
 await page.addInitScript(id => localStorage.setItem('yacwu-running-tasks', JSON.stringify({ [id]: id })), id);
 await page.clock.install();
 await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()); const path = url.pathname;
  let data: object = {};
  const thread = { id, host: 'local', name: 'Missed final', cwd: '/workspace', status: { type: stopped ? 'idle' : 'active' }, turns: [{ id: 'turn', status: stopped ? 'completed' : 'inProgress', items: stopped ? [{ id: 'final', type: 'agentMessage', text: 'Recovered final response' }] : [] }] };
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (path === '/api/threads') data = { data: [thread] };
  else if (path === '/api/threads/loaded') data = { data: [] };
  else if (path.endsWith('/runtime')) data = { thread: { ...thread, turns: thread.turns.map(turn => ({ ...turn, items: [] })) } };
  else if (path === `/api/threads/${id}` || path.endsWith('/open')) { if (url.searchParams.get('turns') === '1') historyReads++; data = { thread }; }
  await route.fulfill({ json: data });
 });
 await page.goto(`/s/${id}`);
 await expect(page.getByRole('button', { name: 'Stop current turn', exact: true })).toBeVisible();
 expect(historyReads).toBe(0);
 stopped = true; await page.clock.fastForward(16000);
 await expect(page.getByText('Recovered final response', { exact: true })).toBeVisible();
 const reads = historyReads;
 await page.clock.fastForward(16000);
 expect(historyReads).toBe(reads);
 expect(reads).toBe(1);
});
