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
	await row.getByRole('button', { name: 'Delete', exact: true }).hover({ force: true });
	const tooltip = page.getByRole('tooltip');
	await expect(tooltip).toContainText('Claude backend does not support permanent deletion');
	await expect.poll(() => tooltip.evaluate((el) => el.matches(':popover-open'))).toBe(true);
	await expect(page.locator('.archive-browser-row').filter({ hasText: 'Codex archived task' }).getByRole('button', { name: 'Delete', exact: true })).toBeEnabled();
	await row.getByRole('button', { name: 'Restore', exact: true }).click();
	await expect(row).toHaveCount(0);
	expect(restoredHost).toBe('claude');
});

test('archive filter resets to All and bulk deletion confirms scope, skips Claude, and reports failures in the modal', async ({ page }) => {
	const removed = new Set<string>();
	const requests: string[] = [];
	const summary = (id: string) => ({ id, name: id, cwd: '/tmp', createdAt: 1, updatedAt: 1 });
	await page.route('**/api/**', async (route) => {
		const url = new URL(route.request().url());
		let data: object = {};
		if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (url.pathname === '/api/hosts') data = { hosts: [{ name: 'local', kind: 'local', provider: 'codex', state: 'connected' }, { name: 'claude', kind: 'backend', provider: 'claude', state: 'connected' }] };
		else if (url.pathname === '/api/threads') data = { data: url.searchParams.get('archived') === 'true' ? (url.searchParams.get('host') === 'claude' ? ['claude-one'] : ['codex-one', 'codex-failed']).filter((id) => !removed.has(id)).map(summary) : [] };
		else if (url.pathname.endsWith('/delete')) {
			const id = url.pathname.split('/')[3]; requests.push(id);
			if (id === 'codex-failed') return route.fulfill({ status: 500, json: { error: 'Delete failed' } });
			removed.add(id);
		}
		await route.fulfill({ json: data });
	});
	await page.goto('/');
	await page.getByRole('button', { name: 'Archived sessions', exact: true }).click();
	const provider = page.getByLabel('Archived session provider');
	await expect(page.locator('.archive-browser-row')).toHaveCount(3);
	await provider.selectOption('claude');
	await expect(page.locator('.archive-browser-row')).toHaveCount(1);
	await expect(page.getByRole('button', { name: 'Delete all', exact: true })).toBeDisabled();
	await page.getByRole('button', { name: 'Close archived sessions', exact: true }).click();
	await page.getByRole('button', { name: 'Archived sessions', exact: true }).click();
	await expect(provider).toHaveValue('all');
	await expect(page.locator('.archive-browser-row')).toHaveCount(3);
	page.once('dialog', (dialog) => dialog.dismiss());
	await page.getByRole('button', { name: 'Delete all', exact: true }).click();
	expect(requests).toEqual([]);
	page.once('dialog', async (dialog) => { expect(dialog.message()).toContain('2 archived session'); expect(dialog.message()).toContain('Claude'); await dialog.accept(); });
	await page.getByRole('button', { name: 'Delete all', exact: true }).click();
	await expect(page.locator('.archive-browser-row')).toHaveCount(2);
	await expect(page.getByRole('dialog', { name: 'Archived sessions', exact: true }).getByRole('alert')).toContainText('1 failed');
	expect(requests).toEqual(['codex-one', 'codex-failed']);
});
