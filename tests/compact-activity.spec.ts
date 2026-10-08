import { expect, test } from '@playwright/test';

test('compact activity keeps the latest row and expands older activity under a single-line label', async ({ page }) => {
	const command = (id: string, status = 'completed') => ({ id, type: 'commandExecution', command: `echo ${id}`, status, exitCode: status === 'failed' ? 1 : 0, aggregatedOutput: `${id} output` });
	const thread = { id: 'compact-test', cwd: '/tmp', status: { type: 'active' }, turns: [{ id: 'turn', status: 'inProgress', items: [
		{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Do work' }] },
		command('first'), command('second'),
		{ id: 'file', type: 'fileChange', changes: [{ path: 'example.ts', kind: { type: 'update' }, diff: '+changed' }] },
		command('failed', 'failed'), command('third'),
		{ id: 'answer', type: 'agentMessage', text: 'Useful final message' }
	] }] };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		let data: object = {};
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') data = { data: [thread], defaultCwd: '/tmp' };
		else if (path === '/api/threads/loaded') data = { data: [thread.id] };
		else if (path.endsWith('/model')) data = { model: 'test', effort: 'medium', models: [] };
		else if (path.startsWith('/api/threads/')) data = { thread };
		await route.fulfill({ json: data });
	});
	await page.goto(`/s/${thread.id}`);
	await expect(page.getByLabel('Show all activity')).not.toBeChecked();
	await expect(page.getByText('Useful final message', { exact: true })).toBeVisible();
	await expect(page.getByRole('button', { name: 'example.ts', exact: true })).toHaveCount(0);
	await expect(page.locator('.item.cmd')).toHaveCount(1);
	await expect(page.locator('.item.cmd')).toContainText('third');
	const group = page.getByRole('button', { name: /Background work · 4 activities · 1 failed/ });
	expect(await group.evaluate((el) => getComputedStyle(el.parentElement!).display)).toBe('block');
	expect(await group.evaluate((el) => getComputedStyle(el.querySelector('.activity-group-label')!).whiteSpace)).toBe('nowrap');
	expect(await group.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(60);
	await group.click();
	await expect(group).toHaveAttribute('aria-expanded', 'true');
	await expect(page.locator('.item.cmd')).toHaveCount(4);
	await expect(page.getByRole('button', { name: 'example.ts', exact: true })).toBeVisible();
	await expect(page.locator('.item.cmd').filter({ hasText: 'failed' })).toBeVisible();
	await expect(page.getByText('first output', { exact: true })).toBeVisible();
	await page.getByLabel('Show all activity').check();
	await expect(page.locator('.activity-group-toggle')).toHaveCount(0);
	await expect(page.locator('.item.cmd')).toHaveCount(4);
	await page.getByLabel('Show all activity').uncheck();
	await group.click();
	await expect(page.locator('.item.cmd')).toHaveCount(1);
	thread.status.type = 'idle';
	thread.turns[0].status = 'completed';
	await page.reload();
	await expect(page.getByText('Useful final message', { exact: true })).toBeVisible();
	await expect(page.locator('.item.cmd')).toHaveCount(0);
	thread.turns[0].items = thread.turns[0].items.map((item) => item.id === 'third' ? command('third', 'failed') : item);
	await page.reload();
	await expect(page.locator('.item.cmd')).toHaveCount(1);
	await expect(page.locator('.item.cmd')).toContainText('third');
	await expect(page.locator('.item.cmd .cmd-result')).toHaveAttribute('aria-label', /Failed/);
});
