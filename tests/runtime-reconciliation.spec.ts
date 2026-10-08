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
