import { expect, test } from '@playwright/test';
// Completion folds the latest activity while the final response stays visible.
// Earlier messages must remain reachable without reloading the page.
const ID = 'completion-session';
for (const delivery of ['stream', 'completion', 'history'] as const) {
	test(`completion keeps the latest response visible when it arrives via ${delivery}`, async ({ page }) => {
		await page.addInitScript(() => {
			const w = window as any;
			class FakeEventSource {
				onopen: any = null;
				onmessage: any = null;
				onerror: any = null;
				readyState = 1;
				constructor(public url: string) { w.__sse = this; setTimeout(() => { this.onopen?.({}); this.onmessage?.({ data: JSON.stringify({ method: 'yacwu/connected', params: {} }) }); }, 0); }
				addEventListener() { }
				close() { this.readyState = 2; }
			}
			w.EventSource = FakeEventSource;
			w.__emit = (msg: unknown) => w.__sse?.onmessage?.({ data: JSON.stringify(msg) });
		});
		const command = { id: 'command', type: 'commandExecution', command: 'Run a final command', status: 'completed', exitCode: 0, aggregatedOutput: 'Output\n'.repeat(400) };
		const items = [
			...Array.from({ length: 100 }, (_, i) => ({ id: `message-${i}`, type: 'agentMessage', phase: 'commentary', text: `Message ${i}\n\n` + 'Long paragraph for virtualization. '.repeat(80) })),
			command
		];
		const finalItem = { id: 'final', type: 'agentMessage', phase: 'final_answer', text: 'FINAL RESPONSE stays visible after completion' };
		let reads = 0;
		const thread = { id: ID, name: 'completion', cwd: '/project', status: { type: 'active' }, turns: [{ id: 'turn-one', status: 'inProgress', items }] };
		await page.route('**/api/**', async (route) => {
			const path = new URL(route.request().url()).pathname;
			let data: object = {};
			if (path === '/api/threads')
				data = { data: [thread], defaultCwd: '/project' };
			else if (path === '/api/threads/loaded')
				data = { data: [ID] };
			else if (path.endsWith('/history')) {
				reads++;
				data = { turns: [{ id: 'turn-one', status: 'completed', items: [...items, finalItem] }] };
			} else if (path.endsWith('/project-rules'))
				data = { current: { project: 'local:test', name: 'test', identity: '/project', text: '', version: 0, updatedAt: null }, applied: null, status: 'unknown' };
			else if (path.endsWith('/model'))
				data = { model: 'test', effort: 'medium', models: [] };
			else if (path.endsWith('/file-access'))
				data = { mode: 'read-write', readOnlySupported: true };
			else if (path.startsWith('/api/threads/'))
				data = { thread };
			await route.fulfill({ json: data });
		});
		const errors: string[] = [];
		page.on('pageerror', e => errors.push(e.message));
		await page.goto(`/s/${ID}`);
		const transcript = page.locator('.transcript');
		const final = page.getByText('FINAL RESPONSE stays visible after completion', { exact: true });
		await expect(page.locator('.item.cmd')).toBeInViewport();
		if (delivery === 'stream') {
			await page.evaluate(({ id, item }) => (window as any).__emit({
				method: 'item/completed', params: { threadId: id, turnId: 'turn-one', item }
			}), { id: ID, item: finalItem });
			await expect(final).toBeInViewport();
		}
		await page.evaluate(({ id, completionItems }) => (window as any).__emit({
			method: 'turn/completed',
			params: { threadId: id, turn: { id: 'turn-one', status: 'completed', items: completionItems } }
		}), { id: ID, completionItems: delivery === 'completion' ? [finalItem] : [] });
		await expect(page.getByRole('img', { name: 'Working', exact: true })).toHaveCount(0);
		await expect(final).toBeInViewport({ timeout: 3000 });
		expect(reads).toBe(delivery === 'history' ? 1 : 0);
		await transcript.evaluate(el => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -600, bubbles: true })); el.scrollTop = 0; });
		await expect(page.getByText(/^Message 0\b/)).toBeVisible();
		expect(errors).toEqual([]);
	});
}
