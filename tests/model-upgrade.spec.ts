import { expect, test } from '@playwright/test';
test('red model warning names the upgrade and clears when a good tradeoff is selected', async ({ page }) => {
	const thread = { id: 'upgrade', cwd: '/project', status: { type: 'idle' }, turns: [] };
	const ids = ['gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.2-sol'];
	let current = 'gpt-6.1-sol', changes = 0;
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/events')
			return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		let data: object = {};
		if (path === '/api/threads')
			data = { data: [thread], defaultCwd: '/project' };
		else if (path.endsWith('/model')) {
			if (route.request().method() === 'POST') {
				current = route.request().postDataJSON().model;
				changes++;
			}
			data = { model: current, effort: 'medium', models: ids.map(id => ({ id, displayName: id, efforts: ['low', 'medium'], defaultEffort: 'medium' })) };
		}
		else if (path.endsWith('/file-access'))
			data = { mode: 'read-write', readOnlySupported: true };
		else if (path.startsWith('/api/threads/'))
			data = { thread };
		await route.fulfill({ json: data });
	});
	await page.goto('/s/upgrade');
	const warning = page.getByRole('img', { name: 'Better model available: gpt-6.2-sol' });
	await expect(warning).toHaveText('!');
	await expect(warning).toBeVisible();
	await expect(warning).toHaveCSS('font-weight', '800');
	const color = await warning.evaluate(el => {
		const ref = document.createElement('span');
		ref.style.color = 'var(--color-error)';
		document.body.append(ref);
		const expected = getComputedStyle(ref).color;
		ref.remove();
		return { expected, actual: getComputedStyle(el).color };
	});
	expect(color.actual).toBe(color.expected);
	await warning.hover();
	await expect(page.getByRole('tooltip')).toContainText('gpt-6.2-sol');
	const picker = page.getByLabel('Model', { exact: true });
	await expect(picker).toHaveValue('gpt-6.1-sol');
	expect(changes).toBe(0);
	await picker.selectOption('gpt-6.2-sol');
	await expect(warning).toHaveCount(0);
	await picker.selectOption('gpt-6-luna');
	await expect(page.locator('.model-upgrade-warning')).toHaveCount(0);
});
