import { test, expect } from '@playwright/test';

test('cleared empty session survives refresh and navigation before its first prompt', async ({ page }) => {
	const oldId = 'refresh-old-session', newId = 'refresh-cleared-session';
	let archived = false;
	const thread = (id: string) => ({ id, name: 'Coordinator', cwd: '/tmp', preview: '',
		status: { type: 'idle' }, turns: [], ephemeral: false });
	await page.route('**/api/**', async (route) => {
		const url = new URL(route.request().url()), path = url.pathname;
		let data: object = {};
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') data = route.request().method() === 'POST'
			? { thread: thread(newId), host: 'local' }
			: { data: archived ? [] : [thread(oldId)], defaultCwd: '/tmp' };
		else if (path === '/api/threads/loaded') data = { data: archived ? [newId] : [oldId] };
		else if (path.endsWith('/archive')) archived = true;
		else if (path.endsWith('/model')) data = { model: 'gpt-6.1-sol', effort: 'medium', models: [] };
		else if (path.startsWith('/api/threads/')) data = { thread: thread(path.split('/')[3]) };
		await route.fulfill({ json: data });
	});
	await page.goto(`/s/${oldId}`);
	await expect(page.locator(`.session[data-id="${oldId}"]`)).toBeVisible();
	await page.getByRole('button', { name: /^Session details,/ }).click();
	await page.getByRole('button', { name: 'Clear session', exact: true }).click();
	await expect(page).toHaveURL(new RegExp(`/s/${newId}`));
	await expect(page.locator(`.session[data-id="${newId}"]`)).toBeVisible();
	await page.reload();
	await expect(page.locator(`.session[data-id="${newId}"]`)).toBeVisible();
	await expect(page.locator(`.session[data-id="${oldId}"]`)).toHaveCount(0);
	await page.goto('/');
	await expect(page.locator(`.session[data-id="${newId}"]`)).toBeVisible();
	await page.locator(`.session[data-id="${newId}"]`).click();
	await expect(page.locator('.composer')).toBeVisible();
});
