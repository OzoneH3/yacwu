import { expect, test } from '@playwright/test';

// An event stream can die without an error (sleep, a network change): the
// page then saw nothing new until a reload. A stream that stays silent past
// the server's pings is reopened, and the reconnect catches the page up.

const ID = 'watchdog-session';

test('a silent event stream is reopened and the page catches up', async ({ page }) => {
	await page.clock.install();
	await page.addInitScript(() => {
		const w = window as any;
		w.__streams = 0;
		class SilentEventSource {
			onopen: any = null; onmessage: any = null; onerror: any = null; readyState = 1;
			constructor(public url: string) {
				w.__streams += 1;
				setTimeout(() => { this.onopen?.({}); this.onmessage?.({ data: JSON.stringify({ method: 'yacwu/connected', params: {} }) }); }, 0);
				// Then nothing: no pings, no error, like a half-open connection.
			}
			addEventListener() {} close() { this.readyState = 2; }
		}
		w.EventSource = SilentEventSource;
	});
	let listReads = 0;
	const thread = { id: ID, name: 'watchdog', cwd: '/tmp', host: 'local', status: { type: 'idle' }, turns: [] };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/threads') { listReads += 1; return route.fulfill({ json: { data: [thread], defaultCwd: '/tmp' } }); }
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [ID] } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread } });
		return route.fulfill({ json: {} });
	});
	await page.goto(`/s/${ID}`);
	await expect(page.locator('.brand .dot.on')).toBeVisible();
	expect(await page.evaluate(() => (window as any).__streams)).toBe(1);
	const readsBefore = listReads;
	await page.clock.runFor(30_000);
	expect(await page.evaluate(() => (window as any).__streams)).toBe(1);
	await page.clock.runFor(30_000);
	await expect.poll(() => page.evaluate(() => (window as any).__streams)).toBe(2);
	await expect.poll(() => listReads).toBeGreaterThan(readsBefore);
});
