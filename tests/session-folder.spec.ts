import { expect, test, type Page } from '@playwright/test';

// Moving a session to another folder: the new folder is checked first, then
// rides on the next message's turn/start, for Codex and Claude sessions alike.

const ID = 'folder-session';

async function mock(page: Page, host = 'local') {
	const sent: Record<string, unknown>[] = [];
	const thread = { id: ID, name: 'folder test', cwd: '/home/u/old', host, status: { type: 'idle' }, turns: [] };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/hosts') return route.fulfill({ json: { hosts: [{ name: 'local', kind: 'local', provider: 'codex' }, { name: 'claude', kind: 'local', provider: 'claude' }] } });
		if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/home/u' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [ID] } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		if (path === `/api/threads/${ID}/cwd`) {
			const { cwd } = route.request().postDataJSON();
			return cwd === '/nope'
				? route.fulfill({ status: 400, json: { error: 'Directory does not exist: /nope' } })
				: route.fulfill({ json: { cwd: cwd.replace(/^~/, '/home/u') } });
		}
		if (path === `/api/threads/${ID}/message`) {
			sent.push(route.request().postDataJSON());
			return route.fulfill({ json: { turn: { id: `turn-${sent.length}`, status: 'inProgress', items: [] } } });
		}
		if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread } });
		return route.fulfill({ json: {} });
	});
	await page.goto(`/s/${ID}${host === 'local' ? '' : `?host=${host}`}`);
	return sent;
}

const details = (page: Page) => page.getByRole('button', { name: /^Session details/ });

test('a checked folder applies with the next message', async ({ page }) => {
	const sent = await mock(page);
	await details(page).click();
	await page.getByRole('button', { name: 'Change folder…' }).click();
	await page.getByLabel('New session folder').fill('/nope');
	await page.getByRole('button', { name: 'Use folder' }).click();
	await expect(page.getByRole('alert')).toContainText('Directory does not exist: /nope');
	await page.getByLabel('New session folder').fill('~/new');
	await page.getByRole('button', { name: 'Use folder' }).click();
	await expect(page.locator('.folder-pending')).toContainText('Moves to /home/u/new with your next message');
	await expect(page.locator('.meta.cwd', { hasText: '→ /home/u/new' })).toBeVisible();
	await page.keyboard.press('Escape');
	await page.getByLabel('Message Codex').fill('carry on');
	await page.getByLabel('Message Codex').press('Enter');
	await expect.poll(() => sent.length).toBe(1);
	expect(sent[0].cwd).toBe('/home/u/new');
	expect(String(sent[0].text)).toContain('/home/u/new/.workspace');
	await expect(page.locator('.meta.cwd', { hasText: '→' })).toHaveCount(0);
	await expect(page.locator('.meta.cwd').first()).toHaveText('/home/u/new');
});

test('Claude sessions can move too, carrying their conversation', async ({ page }) => {
	const sent = await mock(page, 'claude');
	await details(page).click();
	await page.getByRole('button', { name: 'Change folder…' }).click();
	await expect(page.locator('.folder-note')).toContainText('copied to the new folder');
	await page.getByLabel('New session folder').fill('/home/u/elsewhere');
	await page.getByRole('button', { name: 'Use folder' }).click();
	await expect(page.locator('.folder-pending')).toContainText('Moves to /home/u/elsewhere');
	await page.keyboard.press('Escape');
	await page.getByLabel(/^Message /).fill('continue there');
	await page.getByLabel(/^Message /).press('Enter');
	await expect.poll(() => sent.length).toBe(1);
	expect(sent[0].cwd).toBe('/home/u/elsewhere');
});
