import { expect, test } from '@playwright/test';

// After a page reload, sessions the backend reports as active show as running
// in the session list without being opened, and turn idle when they finish.

test('active sessions are marked running in the list right after a reload', async ({ page }) => {
	let busyFinished = false;
	const busy = () => ({ id: 'busy-session', name: 'Busy session', cwd: '/tmp', host: 'local', status: { type: busyFinished ? 'idle' : 'active' },
		turns: [{ id: 'turn-busy', status: busyFinished ? 'completed' : 'inProgress', items: [] }] });
	const quiet = { id: 'quiet-session', name: 'Quiet session', cwd: '/tmp', host: 'local', status: { type: 'idle' }, turns: [] };
	await page.clock.install();
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') return route.fulfill({ json: { data: [{ ...busy(), turns: undefined }, { ...quiet, turns: undefined }], defaultCwd: '/tmp' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: ['busy-session', 'quiet-session'] } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		if (path.startsWith('/api/threads/busy-session')) return route.fulfill({ json: { thread: busy() } });
		if (path.startsWith('/api/threads/quiet-session')) return route.fulfill({ json: { thread: quiet } });
		return route.fulfill({ json: {} });
	});
	await page.goto('/s/quiet-session');
	await expect(page.getByRole('link', { name: 'Running Busy session' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Idle Quiet session' })).toBeVisible();
	// The turn ends while the session is never opened.
	busyFinished = true;
	await page.clock.fastForward(20_000);
	await page.clock.fastForward(20_000);
	await expect(page.getByRole('link', { name: 'Idle Busy session' })).toBeVisible();
});
