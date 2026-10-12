import { expect, test } from '@playwright/test';

// Codex reports its own stream retries ("Reconnecting… 1/5") as error
// notifications with willRetry. They are a passing notice on a running
// turn, gone once the stream resumes; only a final error marks the session.

const ID = 'retry-session';

test('a retry notice is transient and a final error still shows', async ({ page }) => {
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
	const thread = { id: ID, name: 'retry', cwd: '/tmp', host: 'local', status: { type: 'idle' }, turns: [] };
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
	await emit({ method: 'turn/started', params: { threadId: ID, turn: { id: 't1', status: 'inProgress', items: [] } } });
	await expect(details).toHaveAttribute('aria-label', /running/);

	await emit({ method: 'error', params: { threadId: ID, turnId: 't1', willRetry: true, error: { message: 'Reconnecting... 1/5' } } });
	await expect(page.locator('.item.note.retrying')).toContainText('Reconnecting... 1/5');
	await expect(page.locator('.item.err')).toHaveCount(0);
	await expect(details).toHaveAttribute('aria-label', /running/);

	// The stream resumes: the notice goes away.
	await emit({ method: 'item/started', params: { threadId: ID, turnId: 't1', item: { type: 'agentMessage', id: 'a1', text: '' } } });
	await expect(page.locator('.item.note.retrying')).toHaveCount(0);

	await emit({ method: 'error', params: { threadId: ID, turnId: 't1', willRetry: false, error: { message: 'stream disconnected: gave up' } } });
	await expect(page.locator('.item.err')).toContainText('gave up');
	await expect(details).toHaveAttribute('aria-label', /error/);
});
