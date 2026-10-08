import { expect, test } from '@playwright/test';

test('queued todo confirmation does not duplicate a long task description', async ({ page }) => {
	const thread = { id: 'todo-test', cwd: '/tmp', status: { type: 'active' }, turns: [{ id: 'running', status: 'inProgress', items: [{ id: 'initial', type: 'userMessage', content: [{ type: 'text', text: 'Existing task' }] }] }] };
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
	await expect(page.getByRole('button', { name: 'Stop current turn', exact: true })).toBeVisible();
	await page.locator('.composer textarea').fill('/todo Long task description\n\nKeep every detail without repeating it in the confirmation.');
	await page.locator('button.send').click();
	await expect(page.locator('.item.note').last()).toContainText('Todo queued (2 total).');
	await expect(page.locator('.item.note').last()).not.toContainText('Long task description');
	await expect(page.locator('.item').filter({ hasText: 'Long task description' })).toHaveCount(1);
});
