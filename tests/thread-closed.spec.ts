import { expect, test } from '@playwright/test';

// Codex sends thread/closed when it unloads an idle thread from memory, not
// when the thread is deleted. Only an ephemeral side chat leaves the list.

test('an unloaded session keeps its place in the list; a closed side chat goes', async ({ page }) => {
	const summary = (id: string, name: string, extra: object = {}) => ({ id, name, cwd: '/tmp', host: 'local', status: { type: 'idle' }, ...extra });
	const threads = [summary('first-session', 'First'), summary('research-session', 'RESEARCH'), summary('last-session', 'Last'),
		summary('side-chat', 'Side question', { ephemeral: true, forkedFromId: 'first-session' })];
	await page.addInitScript(() => {
		const w = window as any;
		class FakeEventSource {
			onopen: any = null; onmessage: any = null; onerror: any = null; readyState = 1;
			constructor(public url: string) { w.__sse = this; setTimeout(() => { this.onopen?.({}); this.onmessage?.({ data: JSON.stringify({ method: 'yacwu/connected', params: {} }) }); }, 0); }
			addEventListener() {} close() { this.readyState = 2; }
		}
		w.EventSource = FakeEventSource;
		w.__emit = (msg: unknown) => w.__sse?.onmessage?.({ data: JSON.stringify(msg) });
		sessionStorage.setItem('yacwu:side:side-chat', 'first-session');
	});
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/threads') return route.fulfill({ json: { data: threads.filter((t) => !('ephemeral' in t)), defaultCwd: '/tmp' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: threads.map((t) => t.id) } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		const thread = threads.find((t) => path.startsWith(`/api/threads/${t.id}`));
		if (thread) return route.fulfill({ json: { thread: { ...thread, turns: [] } } });
		return route.fulfill({ json: {} });
	});
	await page.goto('/s/first-session');
	const names = () => page.locator('.sidebar nav.sessions a.session').allInnerTexts();
	await expect(page.locator('.sidebar nav.sessions a.session', { hasText: 'RESEARCH' })).toBeVisible();
	const before = await names();

	await page.evaluate(() => (window as any).__emit({ method: 'thread/closed', params: { threadId: 'research-session' } }));
	await page.waitForTimeout(300);
	expect(await names()).toEqual(before);
	// The saved order still includes it, so a reload keeps its position.
	const saved = await page.evaluate(() => localStorage.getItem('yacwu-session-order'));
	if (saved) expect(JSON.parse(saved)).toContain('research-session');

	// A side chat (ephemeral fork) is gone for good once closed.
	const side = page.locator('.sidebar nav.sessions a', { hasText: 'Side question' });
	await expect(side).toBeVisible();
	await page.evaluate(() => (window as any).__emit({ method: 'thread/closed', params: { threadId: 'side-chat' } }));
	await expect(side).toHaveCount(0);
});
