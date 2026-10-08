import { expect, test } from '@playwright/test';

test('archive browser includes unopened Claude, identifies providers, and restores through the original backend', async ({ page }) => {
	let restoredHost: string | null = null;
	const claude = { id: 'claude-archive', host: 'claude', name: 'Claude archived task', preview: '', cwd: '/project', createdAt: 1, updatedAt: 3 };
	const codex = { id: 'codex-archive', host: 'local', name: 'Codex archived task', preview: '', cwd: '/project', createdAt: 1, updatedAt: 2 };
	await page.route('**/api/**', async (route) => {
		const url = new URL(route.request().url());
		if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		let data: object = {};
		if (url.pathname === '/api/hosts') data = { hosts: [{ name: 'local', kind: 'local', provider: 'codex', state: 'connected' }, { name: 'claude', kind: 'backend', provider: 'claude', state: 'disconnected' }] };
		else if (url.pathname === '/api/threads') data = { data: url.searchParams.get('archived') === 'true' ? url.searchParams.get('host') === 'claude' ? [claude] : [codex] : [], defaultCwd: '/project' };
		else if (url.pathname.endsWith('/unarchive')) {
			restoredHost = url.searchParams.get('host');
			data = { thread: { ...claude, host: undefined } };
		}
		await route.fulfill({ json: data });
	});
	await page.goto('/');
	await page.getByRole('button', { name: 'Archived sessions', exact: true }).click();
	const row = page.locator('.archive-browser-row').filter({ hasText: 'Claude archived task' });
	await expect(row).toBeVisible();
	await expect(row.getByRole('button', { name: 'Delete', exact: true })).toBeDisabled();
	await expect(page.locator('.archive-browser-row').filter({ hasText: 'Codex archived task' }).getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
	await row.getByRole('button', { name: 'Restore', exact: true }).click();
	await expect(row).toHaveCount(0);
	expect(restoredHost).toBe('claude');
});
