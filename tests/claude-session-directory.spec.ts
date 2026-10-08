import { expect, test } from '@playwright/test';

test('browsing into a folder selects that working directory for a Claude session', async ({ page }) => {
	let created: Record<string, string> | null = null;
	await page.route('**/api/**', async (route) => {
		const url = new URL(route.request().url());
		let data: object = {};
		if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (url.pathname === '/api/hosts') data = { hosts: [{ name: 'local', kind: 'local', state: 'connected' }, { name: 'claude', kind: 'local', state: 'connected' }] };
		else if (url.pathname === '/api/threads' && route.request().method() === 'POST') {
			created = route.request().postDataJSON();
			data = { host: 'claude', thread: { id: 'claude-folder-test', cwd: created?.cwd, status: { type: 'idle' }, turns: [] } };
		} else if (url.pathname === '/api/threads') data = { data: [], defaultCwd: '/home/test' };
		else if (url.pathname === '/api/directories') data = { path: url.searchParams.get('path') || '/home/test', entries: [{ name: 'project', kind: 'dir' }] };
		else if (url.pathname.endsWith('/model')) data = { model: 'sonnet', effort: 'medium', models: [{ id: 'sonnet', displayName: 'Claude Sonnet 5', efforts: ['medium'] }] };
		await route.fulfill({ json: data });
	});
	await page.goto('/');
	await page.getByRole('button', { name: 'New session', exact: true }).click();
	await page.locator('#new-host').selectOption('claude');
	await page.getByRole('button', { name: 'Browse', exact: true }).click();
	await page.locator('.cwd-directory').filter({ hasText: 'project' }).click();
	await expect(page.locator('#new-cwd')).toHaveValue('/home/test/project');
	await page.getByRole('button', { name: 'Start session', exact: true }).click();
	await expect(page).toHaveURL(/\/s\/claude-folder-test/);
	expect(created).toMatchObject({ host: 'claude', cwd: '/home/test/project' });
});
