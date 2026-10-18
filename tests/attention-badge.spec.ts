import { expect, test } from '@playwright/test';

// "!" is for errors; a finished message that ends in a question shows "?".

test('a closing question gets the ? badge, not the error mark', async ({ page }) => {
	const thread = (id: string, name: string, text: string) => ({ id, name, cwd: '/tmp', host: 'local', status: { type: 'idle' },
		turns: [{ id: `${id}-t`, status: 'completed', items: [
			{ type: 'userMessage', id: `${id}-u`, content: [{ type: 'text', text: 'go' }] },
			{ type: 'agentMessage', id: `${id}-a`, text }
		] }] });
	const threads = [thread('quiet-one', 'Quiet', 'All done.'), thread('asking-one', 'Asking', 'Decisions open:\n1. Start on save?\n2. Share the cap?\n3. Which time?\n4. Where stored?\n5. Show by default?\n6. What order?\n7. Fix first or together?')];
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
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') return route.fulfill({ json: { data: threads, defaultCwd: '/tmp' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: threads.map((t) => t.id) } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		const found = threads.find((t) => path.startsWith(`/api/threads/${t.id}`));
		if (found) return route.fulfill({ json: { thread: found } });
		return route.fulfill({ json: {} });
	});
	await page.goto('/s/quiet-one');
	await page.locator('.sidebar nav.sessions a.session', { hasText: 'Asking' }).click();
	await expect(page.getByText('Fix first or together?')).toBeVisible();
	const item = { ...threads[1].turns[0].items[1], id: 'asking-late', text: 'One more thing — shall I go ahead?' };
	await page.evaluate((item) => (window as any).__emit({ method: 'item/completed', params: { threadId: 'asking-one', turnId: 'asking-one-t', item } }), item);
	await page.locator('.sidebar nav.sessions a.session', { hasText: 'Quiet' }).click();
	await expect(page.locator('.needs-input-indicator.choice')).toHaveText('?');
	await expect(page.locator('.needs-input-indicator:not(.choice)')).toHaveCount(0);
});

test('a question in the commentary of a running turn gets no badge until the turn ends on it', async ({ page }) => {
	const working = { id: 'working-one', name: 'Working', cwd: '/tmp', host: 'local', status: { type: 'active', activeFlags: [] },
		turns: [{ id: 'working-t', status: 'inProgress', items: [
			{ type: 'userMessage', id: 'w-u', content: [{ type: 'text', text: 'go' }] }
		] }] };
	const commentary = { type: 'agentMessage', id: 'w-a', phase: 'commentary', text: "While the UI owner writes their requirements, I'll prepare the contract answer: can a quick-set already be built from existing calls?" };
	const quiet = { id: 'quiet-two', name: 'Quiet', cwd: '/tmp', host: 'local', status: { type: 'idle' }, turns: [] };
	const threads = [quiet, working];
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
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') return route.fulfill({ json: { data: threads, defaultCwd: '/tmp' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: threads.map((t) => t.id) } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		const found = threads.find((t) => path.startsWith(`/api/threads/${t.id}`));
		if (found) return route.fulfill({ json: { thread: found } });
		return route.fulfill({ json: {} });
	});
	await page.goto('/s/working-one');
	await expect(page.locator('.composer textarea')).toBeVisible();
	// The agent posts it as progress commentary while it keeps working.
	await page.evaluate((item) => (window as any).__emit({ method: 'item/completed', params: { threadId: 'working-one', turnId: 'working-t', item } }), commentary);
	await expect(page.getByRole('paragraph').filter({ hasText: 'can a quick-set already be built' })).toBeVisible();
	await page.locator('.sidebar nav.sessions a.session', { hasText: 'Quiet' }).click();
	const workingEntry = page.locator('.sidebar nav.sessions a.session', { hasText: 'Working' });
	await expect(workingEntry).toBeVisible();
	await expect(page.locator('.needs-input-indicator')).toHaveCount(0);
	// The turn ends on that question: now it waits for an answer.
	await page.evaluate(() => (window as any).__emit({ method: 'turn/completed', params: { threadId: 'working-one', turn: { id: 'working-t', status: 'completed' } } }));
	await expect(page.locator('.needs-input-indicator.choice')).toHaveText('?');
});
