import { expect, test } from '@playwright/test';

// /mode shows and changes the session's file access mode, and sessions with
// read-only access display a lock icon in the sidebar.

test('mode command shows and changes file access', async ({ page }) => {
	const thread = { id: 'mode-test', cwd: '/tmp', status: { type: 'idle' }, turns: [] };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		let data: object = {};
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') data = { data: [thread], defaultCwd: '/tmp' };
		else if (path === '/api/threads/loaded') data = { data: [thread.id] };
		else if (path.endsWith('/model')) data = { model: 'test', effort: 'medium', models: [] };
		else if (path.endsWith('/file-access')) {
			if (route.request().method() === 'POST') {
				const body = route.request().postDataJSON() as any;
				data = { mode: body.mode, readOnlySupported: true };
			} else {
				data = { mode: 'read-write', readOnlySupported: true };
			}
		}
		else if (path.startsWith('/api/threads/')) data = { thread };
		await route.fulfill({ json: data });
	});
	await page.goto(`/s/${thread.id}`);
	const box = page.locator('.composer textarea');

	// /mode shows the current mode
	await box.fill('/mode');
	await page.locator('button.send').click();
	await expect(page.locator('.item.note').last()).toContainText('File access: Read/write');

	// /mode r changes to read-only
	await box.fill('/mode r');
	await page.locator('button.send').click();
	await expect(page.locator('.item.note').last()).toContainText('File access set to Read-only');

	// Read-only autocomplete offers the command that restores write access.
	await box.fill('/mode');
	const option = page.getByRole('option').filter({ hasText: 'set read-write file access' });
	await expect(option.locator('.slash-args')).toHaveText('rw', { timeout: 5000 });
	await box.press('Tab');
	await expect(box).toHaveValue('/mode rw');
	await box.press('Enter');
	await expect(page.locator('.item.note').last()).toContainText('File access set to Read/write');

	// Exact shortcuts: /mode read-only and /mode read-write
	await box.fill('/mode read-only');
	await page.locator('button.send').click();
	await expect(page.locator('.item.note').last()).toContainText('File access set to Read-only');

	// Enter on the suggestion executes the same explicit read-write command.
	await box.fill('/mode');
	await expect(option.locator('.slash-args')).toHaveText('rw');
	await box.press('Enter');
	await expect(page.locator('.item.note').last()).toContainText('File access set to Read/write');
	await box.fill('/mode');
	await expect(page.getByRole('option').filter({ hasText: 'show the current file access mode' }).locator('.slash-args')).toHaveText('r');
});

test('read-only sessions show a lock icon in the sidebar', async ({ page }) => {
	let fileAccess = 'read-write';
	const thread = { id: 'mode-ro', cwd: '/tmp', status: { type: 'idle' }, turns: [] };
	const session = { ...thread, name: 'Read-only task', preview: '', createdAt: 1, updatedAt: 1 };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		let data: object = {};
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') data = { data: [session], defaultCwd: '/tmp' };
		else if (path === '/api/threads/loaded') data = { data: [thread.id] };
		else if (path === '/api/hosts') data = { hosts: [{ name: 'local', kind: 'local', provider: 'codex', state: 'connected' }] };
		else if (path.endsWith('/file-access')) {
			if (route.request().method() === 'POST') {
				const body = route.request().postDataJSON() as any;
				fileAccess = body.mode;
			}
			data = { mode: fileAccess, readOnlySupported: true };
		}
		else if (path.startsWith('/api/threads/')) data = { thread };
		await route.fulfill({ json: data });
	});
	await page.goto(`/s/${thread.id}`);
	const sessionEntry = page.locator('.sidebar nav.sessions a.session', { hasText: 'Read-only task' });

	// Initially read-write, no lock
	await expect(sessionEntry.locator('.readonly-badge')).toHaveCount(0);

	// Change to read-only
	await page.locator('.composer textarea').fill('/mode r');
	await page.locator('button.send').click();
	await expect(page.locator('.item.note').last()).toContainText('File access set to Read-only');

	// Lock appears in sidebar
	await expect(sessionEntry.locator('.readonly-badge')).toHaveText('🔒');
});
