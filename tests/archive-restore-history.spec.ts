import { expect, test } from '@playwright/test';

// Archiving a session that was open and restoring it in the same page must
// show its history again when it is opened, without a page reload.

test('a session archived and restored in the same page shows its history again', async ({ page }) => {
	let archived = false;
	let opens = 0;
	const id = 'restore-history';
	const summary = { id, name: 'Restorable task', preview: 'Earlier question', cwd: '/project', createdAt: 1, updatedAt: 2 };
	const thread = { ...summary, status: { type: 'idle' }, turns: [{ id: 'turn1', status: 'completed', items: [
		{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Earlier question' }] },
		{ type: 'agentMessage', id: 'a1', phase: 'final', text: 'The earlier answer.' }
	] }] };
	await page.route('**/api/**', async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		let data: object = {};
		if (path === '/api/hosts') data = { hosts: [{ name: 'local', kind: 'local', provider: 'codex', state: 'connected' }] };
		else if (path === '/api/threads') data = { data: (url.searchParams.get('archived') === 'true') === archived ? [summary] : [], defaultCwd: '/project' };
		else if (path === '/api/threads/loaded') data = { data: [] };
		else if (path.endsWith('/archive')) archived = true;
		else if (path.endsWith('/unarchive')) { archived = false; data = { thread: summary }; }
		else if (path.endsWith('/open')) { opens++; data = { thread }; }
		else if (path === `/api/threads/${id}`) data = { thread };
		await route.fulfill({ json: data });
	});
	await page.goto(`/s/${id}`);
	const answer = page.getByText('The earlier answer.');
	await expect(answer).toBeVisible();

	await page.locator('.composer textarea').fill('/archive');
	await page.locator('.composer textarea').press('Enter');
	const entry = page.locator('.sidebar nav.sessions a.session', { hasText: 'Restorable task' });
	await expect(entry).toHaveCount(0);

	await page.getByRole('button', { name: 'Archived sessions', exact: true }).click();
	const row = page.locator('.archive-browser-row').filter({ hasText: 'Restorable task' });
	await row.getByRole('button', { name: 'Restore', exact: true }).click();
	await expect(row).toHaveCount(0);
	await page.keyboard.press('Escape');

	// Open it from the sidebar: in-page navigation, no reload.
	const openedBefore = opens;
	await entry.click();
	await expect(answer).toBeVisible();
	expect(opens).toBeGreaterThan(openedBefore);
});
