import { expect, test } from '@playwright/test';

// A new session is named after its folder, so the session list and the
// session header show the same name from the start.

test('a new session takes its folder name in the list and the header', async ({ page }) => {
	const names: unknown[] = [];
	let created: object | null = null;
	await page.route('**/api/**', async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads' && request.method() === 'POST') {
			created = { id: 'fresh-1', name: null, preview: '', cwd: '/home/u/Apps/yacwu', status: { type: 'idle' }, turns: [] };
			return route.fulfill({ json: { thread: created, host: 'local' } });
		}
		if (path === '/api/threads') return route.fulfill({ json: { data: created ? [created] : [], defaultCwd: '/home/u' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [] } });
		if (path === '/api/directories') return route.fulfill({ json: { path: '/home/u', entries: [] } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		if (path === '/api/threads/fresh-1/name') {
			names.push(request.postDataJSON());
			return route.fulfill({ json: {} });
		}
		if (path.startsWith('/api/threads/') && created) return route.fulfill({ json: { thread: created } });
		return route.fulfill({ json: {} });
	});
	await page.goto('/');
	await page.getByRole('button', { name: 'New session' }).click();
	await page.locator('.cwd-input').fill('/home/u/Apps/yacwu');
	await page.getByRole('button', { name: 'Start session' }).click();
	await expect(page).toHaveURL(/\/s\/fresh-1/);
	await expect(page.locator('h1')).toHaveText('yacwu');
	await expect(page.getByRole('link', { name: /yacwu$/ })).toBeVisible();
	expect(names).toEqual([{ name: 'yacwu' }]);
});
