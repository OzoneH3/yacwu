import { expect, test } from '@playwright/test';

// Reading scrolled up: new activity at the end folds the previous one into
// "Background work" above the reader. The text being read must stay put.

const ID = 'anchor-session';

test('new activity folding rows above the reader does not move the text being read', async ({ page }) => {
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
	const long = (n: number) => `Paragraph ${n}. ` + 'Enough words to wrap over several lines of the reading column. '.repeat(25);
	const command = (id: string, status: string) => ({ id, type: 'commandExecution', command: `run ${id}`, status, exitCode: status === 'completed' ? 0 : null,
		aggregatedOutput: Array.from({ length: 8 }, (_, i) => `${id} line ${i}`).join('\n') });
	const items = [
		{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: 'Do the work' }] },
		...Array.from({ length: 12 }, (_, i) => ({ id: `early-${i}`, type: 'agentMessage', text: long(i) })),
		command('cmd-a', 'completed'),
		{ id: 'reading', type: 'agentMessage', text: 'READ-MARKER ' + long(99) },
		...Array.from({ length: 6 }, (_, i) => ({ id: `late-${i}`, type: 'agentMessage', text: long(100 + i) }))
	];
	const thread = { id: ID, name: 'anchor', cwd: '/tmp', host: 'local', status: { type: 'active' }, turns: [{ id: 't1', status: 'inProgress', items }] };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/tmp' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [ID] } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		if (path.endsWith('/file-access')) return route.fulfill({ json: { mode: 'read-write', readOnlySupported: true } });
		if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread } });
		return route.fulfill({ json: {} });
	});
	await page.goto(`/s/${ID}`);
	const transcript = page.locator('.transcript');
	const marker = page.getByText(/^READ-MARKER/);
	// Scroll up the way a reader does, until the marked message sits near the top.
	await transcript.evaluate((el) => el.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true })));
	for (let i = 0; i < 40; i += 1) {
		const offset = await marker.evaluate((m) => m.getBoundingClientRect().top - m.closest('.transcript')!.getBoundingClientRect().top).catch(() => null);
		if (offset !== null && offset > 40 && offset < 200) break;
		await transcript.evaluate((el, step) => { el.scrollTop += step; }, offset === null ? -400 : offset - 120);
		await page.waitForTimeout(50);
	}
	const top = () => marker.evaluate((m) => m.getBoundingClientRect().top);
	const before = await top();
	expect(before - (await transcript.evaluate((el) => el.getBoundingClientRect().top))).toBeLessThan(260);
	// The running turn keeps its latest command expanded, just above the reader.
	await expect(page.locator('.item.cmd')).toHaveCount(1);
	// The next activity arrives at the end: cmd-a folds into "Background work".
	const emit = (msg: unknown) => page.evaluate((m) => (window as any).__emit(m), msg);
	await emit({ method: 'item/started', params: { threadId: ID, turnId: 't1', item: command('cmd-b', 'inProgress') } });
	await emit({ method: 'item/completed', params: { threadId: ID, turnId: 't1', item: { id: 'late-new', type: 'agentMessage', text: long(200).repeat(4) } } });
	await expect(page.getByRole('button', { name: /Background work · 1/ })).toHaveCount(1);
	await page.waitForTimeout(300);
	expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(2);
});
