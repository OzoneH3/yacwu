import { expect, test } from '@playwright/test';

test('applying suggested settings closes the panel and sends the selected settings', async ({ page }) => {
	let applied: { model?: string; effort?: string } | null = null;
	const thread = { id: 'suggestion-test', cwd: '/tmp', status: { type: 'idle' }, turns: [] };
	const settings = { model: 'gpt-6.1-sol', effort: 'medium', models: [{ id: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol', efforts: ['low', 'medium'], defaultEffort: 'medium' }] };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		let data: object = {};
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') data = { data: [thread], defaultCwd: '/tmp' };
		else if (path === '/api/threads/loaded') data = { data: [thread.id] };
		else if (path.endsWith('/model')) {
			if (route.request().method() === 'POST') applied = route.request().postDataJSON();
			data = { ...settings, ...applied };
		} else if (path.startsWith('/api/threads/')) data = { thread };
		await route.fulfill({ json: data });
	});
	await page.goto(`/s/${thread.id}`);
	await page.locator('.composer textarea').fill('Fix a typo in README');
	await expect(page.locator('.model-picker')).toBeVisible();
	await page.locator('.model-picker').hover();
	await expect(page.getByRole('tooltip')).toHaveCount(0);
	await page.locator('.effort').hover();
	await expect(page.getByRole('tooltip')).toHaveCount(0);
	await page.getByRole('button', { name: 'Suggest settings', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Suggested prompt settings' })).toBeVisible();
	await page.getByRole('button', { name: 'Apply settings', exact: true }).click();
	await expect(page.getByRole('region', { name: 'Suggested prompt settings' })).toHaveCount(0);
	await expect.poll(() => applied?.model).toBe('gpt-6.1-sol');
	await expect.poll(() => applied?.effort).toMatch(/^(low|medium)$/);
});
