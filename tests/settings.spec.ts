import { expect, test, type Page } from '@playwright/test';

// The global settings menu: opened from the sidebar, applied immediately to
// every session, and kept across reloads.

async function mock(page: Page, host = 'local') {
	const posted: string[] = [];
	const summary = { id: 'settings-a', name: 'settings-a', cwd: '/tmp', host, status: { type: 'idle' }, turns: [] };
	const hosts = [
		{ name: 'local', kind: 'local', provider: 'codex', state: 'connected' },
		{ name: 'claude', kind: 'backend', provider: 'claude', state: 'connected' }
	];
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/hosts') return route.fulfill({ json: { hosts } });
		if (path === '/api/threads') return route.fulfill({ json: { data: [summary], defaultCwd: '/tmp' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: ['settings-a'] } });
		if (path.endsWith('/message')) {
			posted.push(route.request().postDataJSON().text);
			return route.fulfill({ json: { turn: { id: `turn-${posted.length}`, status: 'inProgress', items: [] } } });
		}
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread: summary } });
		return route.fulfill({ json: {} });
	});
	return posted;
}

async function openSettings(page: Page) {
	await page.getByRole('button', { name: 'Settings', exact: true }).click();
	await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
}

test('Enter-to-send can be switched off and the choice survives a reload', async ({ page }) => {
	const posted = await mock(page);
	await page.goto('/s/settings-a');
	await openSettings(page);
	await page.getByLabel('Enter sends the message').uncheck();
	await page.getByRole('button', { name: 'Close settings' }).click();

	const composer = page.locator('.composer textarea');
	await composer.fill('first line');
	await composer.press('Enter');
	await composer.pressSequentially('second line');
	await expect(composer).toHaveValue('first line\nsecond line');
	expect(posted).toHaveLength(0);
	await composer.press('Control+Enter');
	await expect.poll(() => posted.length).toBe(1);
	expect(posted[0]).toContain('first line\nsecond line');

	await page.reload();
	await openSettings(page);
	await expect(page.getByLabel('Enter sends the message')).not.toBeChecked();
});

test('defaults for activity view and session rules apply to every session', async ({ page }) => {
	const posted = await mock(page);
	await page.goto('/s/settings-a');
	await openSettings(page);
	await page.getByLabel('Show all activity by default').check();
	await page.getByLabel('Default: progress reporting').uncheck();
	await page.getByRole('button', { name: 'Close settings' }).click();

	await page.reload();
	await expect(page.getByLabel('Show all activity', { exact: true })).toBeChecked();
	await page.locator('.composer textarea').fill('Do the task');
	await page.locator('.composer textarea').press('Enter');
	await expect.poll(() => posted.length).toBe(1);
	expect(posted[0]).not.toContain('<!-- YACWU_TASK_PROGRESS -->');
	// The session itself shows the inherited default.
	await page.getByRole('button', { name: /^Session details,/ }).click();
	await expect(page.locator('.session-rules').getByLabel('Progress reporting', { exact: true })).not.toBeChecked();
});

test('theme and reset to defaults', async ({ page }) => {
	await mock(page);
	await page.goto('/s/settings-a');
	await openSettings(page);
	await page.getByLabel('Theme').selectOption('dark');
	await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
	await page.getByLabel('Enter sends the message').uncheck();
	await page.getByRole('button', { name: 'Reset to defaults' }).click();
	await expect(page.getByLabel('Enter sends the message')).toBeChecked();
	const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('yacwu-settings') ?? '{}'));
	expect(stored.enterToSend).toBe(true);
});

test('Claude prompts carry the allowance lockout percentage, hidden from the transcript', async ({ page }) => {
	const posted = await mock(page, 'claude');
	await page.goto('/s/settings-a');
	await openSettings(page);
	await page.getByLabel('Lockout at % remaining').fill('20');
	await page.getByLabel('Lockout at % remaining').press('Tab');
	await page.getByRole('button', { name: 'Close settings' }).click();
	await page.locator('.composer textarea').fill('Check the build');
	await page.locator('.composer textarea').press('Enter');
	await expect.poll(() => posted.length).toBe(1);
	expect(posted[0]).toContain('<!-- YACWU_ALLOWANCE_RESERVE percent=20 -->');
	await expect(page.locator('.item.user').last()).toHaveText('Check the build');
});
