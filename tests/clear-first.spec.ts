import { expect, test, type Page } from '@playwright/test';

// "Clear first" in the composer replaces the session with an empty
// conversation (as Session details → Clear session does) and sends the
// message there; if clearing fails, nothing is sent and the draft stays.

const OLD = 'clear-old';
const FRESH = 'clear-fresh';

async function mock(page: Page, createFails = false) {
	const calls: string[] = [];
	const sent: Record<string, Record<string, unknown>> = {};
	const thread = (id: string, items: object[] = []) => ({ id, name: 'Research', cwd: '/home/u/project', host: 'local', status: { type: 'idle' },
		turns: items.length ? [{ id: `${id}-turn`, status: 'completed', items }] : [] });
	const old = thread(OLD, [{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Earlier task' }] }, { type: 'agentMessage', id: 'a1', text: 'Earlier answer' }]);
	let list = [old];
	await page.route('**/api/**', async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (request.method() === 'POST') calls.push(path);
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads' && request.method() === 'POST') {
			if (createFails) return route.fulfill({ status: 500, json: { error: 'backend unavailable' } });
			list = [...list, thread(FRESH)];
			return route.fulfill({ json: { thread: thread(FRESH) } });
		}
		if (path === '/api/threads') return route.fulfill({ json: { data: list, defaultCwd: '/home/u' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: list.map((t) => t.id) } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		const message = path.match(/^\/api\/threads\/([^/]+)\/message$/);
		if (message) {
			sent[message[1]] = request.postDataJSON();
			return route.fulfill({ json: { turn: { id: 'turn-new', status: 'inProgress', items: [] } } });
		}
		if (path === `/api/threads/${FRESH}` || path.startsWith(`/api/threads/${FRESH}/`)) return route.fulfill({ json: { thread: thread(FRESH) } });
		if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread: old } });
		return route.fulfill({ json: {} });
	});
	await page.goto(`/s/${OLD}`);
	await expect(page.getByText('Earlier answer')).toBeVisible();
	return { calls, sent };
}

test('Clear first sends the message into a fresh conversation and archives the old one', async ({ page }) => {
	const { calls, sent } = await mock(page);
	const clearFirst = page.getByLabel('Clear first');
	await expect(clearFirst).toBeEnabled();
	await clearFirst.check();
	await page.locator('.composer textarea').fill('Start over on the audit');
	await page.locator('button.send').click();
	await expect(page).toHaveURL(new RegExp(`/s/${FRESH}`));
	await expect.poll(() => String(sent[FRESH]?.text ?? '')).toContain('Start over on the audit');
	expect(sent[OLD]).toBeUndefined();
	expect(calls).toContain(`/api/threads/${OLD}/archive`);
	expect(calls.indexOf(`/api/threads/${OLD}/archive`)).toBeLessThan(calls.indexOf(`/api/threads/${FRESH}/message`));
	await expect(page.getByText('Earlier answer')).toHaveCount(0);
	await expect(page.getByLabel('Clear first')).not.toBeChecked();
});

test('if clearing fails, nothing is sent and the draft stays', async ({ page }) => {
	const { sent } = await mock(page, true);
	await page.getByLabel('Clear first').check();
	await page.locator('.composer textarea').fill('Keep this draft');
	await page.locator('button.send').click();
	await expect(page.getByText(/backend unavailable/).filter({ visible: true })).toBeVisible();
	expect(Object.keys(sent)).toEqual([]);
	await expect(page).toHaveURL(new RegExp(`/s/${OLD}`));
	await expect(page.locator('.composer textarea')).toHaveValue('Keep this draft');
});
