import { expect, test } from '@playwright/test';

// A backend that never echoes sent messages (claude-codex) must not show a
// message twice after its connection comes back and history is reloaded.

const ID = 'echo-session';

test('a sent message shows once after the backend reconnects', async ({ page }) => {
	let sent = false;
	const thread = () => ({ id: ID, name: 'echo', cwd: '/tmp', host: 'claude', status: { type: 'idle' }, turns: sent
		? [{ id: 't1', status: 'completed', items: [
			{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'do one trial run\n\n<!-- YACWU_TASK_PROGRESS -->\nhidden\n[/YACWU_TASK_PROGRESS]' }] },
			{ type: 'agentMessage', id: 'a1', text: 'Done.' }
		] }]
		: [] });
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
		if (path === '/api/hosts') return route.fulfill({ json: { hosts: [{ name: 'local', kind: 'local', provider: 'codex', state: 'connected' }, { name: 'claude', kind: 'backend', provider: 'claude', state: 'connected' }] } });
		if (path === '/api/threads') return route.fulfill({ json: { data: [thread()], defaultCwd: '/tmp' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [ID] } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'sonnet', effort: 'medium', models: [] } });
		if (path === `/api/threads/${ID}/message`) { sent = true; return route.fulfill({ json: { turn: { id: 't1', status: 'inProgress', items: [] } } }); }
		if (path.startsWith(`/api/threads/${ID}`)) return route.fulfill({ json: { thread: thread() } });
		return route.fulfill({ json: {} });
	});
	await page.goto(`/s/${ID}?host=claude`);
	await page.locator('.composer textarea').fill('do one trial run');
	await page.locator('button.send').click();
	const copies = page.locator('.item.user', { hasText: 'do one trial run' });
	await expect(copies).toHaveCount(1);
	// The backend restarts away and comes back; Yacwu reloads the transcript.
	const status = (state: string) => page.evaluate((s) => (window as any).__emit({ method: 'yacwu/host/status', params: { host: 'claude', state: s } }), state);
	await status('disconnected');
	await status('connected');
	await expect(page.getByText('Done.')).toBeVisible();
	await expect(copies).toHaveCount(1);
});
