import { expect, test } from '@playwright/test';

// A running turn shows evidence that it is moving even when nothing visible
// is produced: its latest update and the tokens used so far.

const ID = 'live-session';

test('a running turn shows its latest update and tokens used', async ({ page }) => {
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
	const thread = { id: ID, name: 'live', cwd: '/tmp', host: 'local', status: { type: 'idle' }, turns: [] };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/tmp' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [ID] } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread } });
		return route.fulfill({ json: {} });
	});
	await page.goto(`/s/${ID}`);
	await expect(page.locator('.brand .dot.on')).toBeVisible();
	await expect(page.locator('.composer')).toBeVisible();
	const emit = (msg: unknown) => page.evaluate((m) => (window as any).__emit(m), msg);
	const details = page.getByRole('button', { name: /^Session details/ });
	const usage = (totalTokens: number) => ({ method: 'thread/tokenUsage/updated', params: { threadId: ID, turnId: 't1', tokenUsage: {
		total: { totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0 },
		last: { totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0 }, modelContextWindow: 200000 } } });
	await emit(usage(40_000));
	await emit({ method: 'turn/started', params: { threadId: ID, turn: { id: 't1', status: 'inProgress', items: [] } } });
	await emit({ method: 'item/reasoning/textDelta', params: { threadId: ID, turnId: 't1', itemId: 'r1', delta: 'hmm' } });
	const live = page.locator('.working-live');
	await expect(live).toHaveText('thinking just now');
	await emit(usage(52_400));
	await expect(live).toHaveText('tokens just now · 12k tokens this turn');
});
