import { expect, test, type Page } from '@playwright/test';

// "Clear first" in the composer replaces the session with an empty
// conversation (as Session details → Clear session does) and sends the
// message there; if clearing fails, nothing is sent and the draft stays.

const OLD = 'clear-old';
const FRESH = 'clear-fresh';

async function mock(page: Page, createFails = false) {
	const calls: string[] = [];
	const modelUpdates: Record<string, unknown>[] = [];
	let model = 'test';
	let effort = 'medium';
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
		if (path.endsWith('/model')) {
			if (request.method() === 'POST') {
				const update = request.postDataJSON();
				modelUpdates.push(update);
				model = update.model ?? model;
				effort = update.effort ?? effort;
			}
			return route.fulfill({ json: { model, effort, models: ['test', 'other'].map(id => ({ id, displayName: id, efforts: ['medium', 'high'], defaultEffort: 'medium' })) } });
		}
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
	return { calls, sent, modelUpdates };
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

test('Clear first can clear immediately without sending a prompt', async ({ page }) => {
	const { calls, sent, modelUpdates } = await mock(page);
	await page.getByLabel('Model', { exact: true }).selectOption('other');
	await page.getByLabel('Thinking strength').selectOption('high');
	await page.getByLabel('Clear first').check();
	await page.getByRole('button', { name: 'Clear now' }).click();
	await expect(page).toHaveURL(new RegExp(`/s/${FRESH}`));
	await expect(page.getByLabel('Clear first')).not.toBeChecked();
	await expect(page.getByText('Earlier answer')).toHaveCount(0);
	expect(calls).toContain(`/api/threads/${OLD}/archive`);
	expect(modelUpdates.at(-1)).toEqual({ model: 'other', effort: 'high' });
	expect(Object.keys(sent)).toEqual([]);
});


test('model and thinking changes are saved before a session receives any message', async ({ page }) => {
	const { sent, modelUpdates } = await mock(page);
	await page.getByLabel('Model', { exact: true }).selectOption('other');
	await page.getByLabel('Thinking strength').selectOption('high');
	await expect.poll(() => modelUpdates.length).toBe(2);
	expect(modelUpdates).toEqual([{ model: 'other' }, { effort: 'high' }]);
	expect(Object.keys(sent)).toEqual([]);
});

test('Clear now cannot discard a draft', async ({ page }) => {
	const { sent } = await mock(page);
	await page.getByLabel('Clear first').check();
	const button = page.getByRole('button', { name: 'Clear now' });
	await expect(button).toBeEnabled();
	await page.locator('.composer textarea').fill('Keep this draft');
	await expect(button).toBeDisabled();
	await expect(page.locator('.composer textarea')).toHaveValue('Keep this draft');
	expect(Object.keys(sent)).toEqual([]);
});


test('Clear now keeps the old session if creating its replacement fails', async ({ page }) => {
	const { calls, sent } = await mock(page, true);
	await page.getByLabel('Clear first').check();
	await page.getByRole('button', { name: 'Clear now' }).click();
	await expect(page.getByText(/backend unavailable/).filter({ visible: true })).toBeVisible();
	await expect(page).toHaveURL(new RegExp(`/s/${OLD}`));
	expect(calls).not.toContain(`/api/threads/${OLD}/archive`);
	expect(Object.keys(sent)).toEqual([]);
});
