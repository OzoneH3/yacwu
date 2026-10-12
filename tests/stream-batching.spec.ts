import { expect, test, type Page } from '@playwright/test';

// Streamed deltas reach the transcript once per frame, not once per SSE
// message, and other notifications still see every delta before them.

const ID = 'batch-session';

async function open(page: Page) {
	await page.addInitScript(() => {
		const w = window as any;
		class FakeEventSource {
			onopen: any = null; onmessage: any = null; onerror: any = null; readyState = 1;
			constructor(public url: string) { w.__sse = this; setTimeout(() => { this.onopen?.({}); this.onmessage?.({ data: JSON.stringify({ method: 'yacwu/connected', params: {} }) }); }, 0); }
			addEventListener() {} close() { this.readyState = 2; }
		}
		w.EventSource = FakeEventSource;
		w.__emit = (msg: unknown) => w.__sse?.onmessage?.({ data: JSON.stringify(msg) });
	});
	const thread = { id: ID, name: 'batching', cwd: '/tmp', host: 'local', status: { type: 'idle' }, turns: [{ id: 't0', status: 'completed', items: [
		{ type: 'userMessage', id: 'u0', content: [{ type: 'text', text: 'Earlier' }] },
		{ type: 'agentMessage', id: 'a0', text: 'Earlier answer.' }
	] }] };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/tmp' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [ID] } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread } });
		return route.fulfill({ json: {} });
	});
	await page.goto(`/s/${ID}`);
	await expect(page.getByText('Earlier answer.').first()).toBeVisible();
	await page.evaluate((id) => {
		const w = window as any;
		w.__emit({ method: 'turn/started', params: { threadId: id, turn: { id: 't1', status: 'inProgress', items: [] } } });
		w.__emit({ method: 'item/started', params: { threadId: id, turnId: 't1', item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'go' }] } } });
		w.__emit({ method: 'item/started', params: { threadId: id, turnId: 't1', item: { type: 'agentMessage', id: 'a1', text: '' } } });
	}, ID);
}

const pieces = Array.from({ length: 40 }, (_, i) => `word${i} `);
const full = pieces.join('').trim();

test('a burst of deltas renders on the next frame, in full', async ({ page }) => {
	await open(page);
	const renderedBeforeFrame = await page.evaluate(async ({ id, pieces, full }) => {
		const w = window as any;
		for (const delta of pieces) w.__emit({ method: 'item/agentMessage/delta', params: { threadId: id, turnId: 't1', itemId: 'a1', delta } });
		// Let Svelte flush its microtask batch; a per-message update would render now.
		for (let i = 0; i < 5; i++) await Promise.resolve();
		return document.body.innerText.includes(full);
	}, { id: ID, pieces, full });
	expect(renderedBeforeFrame).toBe(false);
	await expect(page.getByText(full)).toBeVisible();
});

test('a completion right after deltas keeps the text exactly once', async ({ page }) => {
	await open(page);
	await page.evaluate(({ id, pieces, full }) => {
		const w = window as any;
		for (const delta of pieces) w.__emit({ method: 'item/agentMessage/delta', params: { threadId: id, turnId: 't1', itemId: 'a1', delta } });
		w.__emit({ method: 'item/completed', params: { threadId: id, turnId: 't1', item: { type: 'agentMessage', id: 'a1', text: full } } });
		w.__emit({ method: 'turn/completed', params: { threadId: id, turn: { id: 't1', status: 'completed', items: [] } } });
	}, { id: ID, pieces, full });
	await expect(page.getByText(full)).toBeVisible();
	await page.waitForTimeout(300); // past any pending frame or fallback flush
	const text = await page.locator('main').innerText();
	expect(text.split('word0 word1').length - 1).toBe(1);
	expect(text).toContain('word39');
});
