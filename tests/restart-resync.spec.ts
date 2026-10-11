import { expect, test } from '@playwright/test';

// When the event stream comes back after a Yacwu restart, nothing that
// happened meanwhile was streamed: the open transcript reloads, running
// sessions in the list refresh their progress, and a turn that ended
// during the restart stops showing as running.

test('a reconnected event stream catches the page up on what it missed', async ({ page }) => {
	let restarted = false;
	const open = () => ({ id: 'open-session', name: 'Open session', cwd: '/tmp', host: 'local', status: { type: 'active' },
		turns: [{ id: 't1', status: 'inProgress', items: [
			{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Work on it' }] },
			{ id: 'a1', type: 'agentMessage', text: 'Before the restart.' },
			...(restarted ? [{ id: 'a2', type: 'agentMessage', text: 'Written while Yacwu restarted.' }] : [])
		] }] });
	const busy = () => ({ id: 'busy-session', name: 'Busy session', cwd: '/tmp', host: 'local', status: { type: 'active' },
		turns: [{ id: 't2', status: 'inProgress', items: [
			{ id: 'u2', type: 'userMessage', content: [{ type: 'text', text: 'Long task' }] },
			{ id: 'b1', type: 'agentMessage', text: restarted ? '[[YACWU_PROGRESS percent=60 remaining_minutes=4]]' : '[[YACWU_PROGRESS percent=10 remaining_minutes=20]]' }
		] }] });
	const ending = () => ({ id: 'ending-session', name: 'Ending session', cwd: '/tmp', host: 'local', status: { type: restarted ? 'idle' : 'active' },
		turns: [{ id: 't3', status: restarted ? 'completed' : 'inProgress', items: [] }] });
	const all = () => [open(), busy(), ending()];
	await page.addInitScript(() => {
		const w = window as any;
		class FakeEventSource {
			onopen: any = null; onmessage: any = null; onerror: any = null; readyState = 1;
			constructor(public url: string) { w.__sse = this; setTimeout(() => w.__connected(), 0); }
			addEventListener() {} close() { this.readyState = 2; }
		}
		w.EventSource = FakeEventSource;
		w.__connected = () => { w.__sse.onopen?.({}); w.__sse.onmessage?.({ data: JSON.stringify({ method: 'yacwu/connected', params: {} }) }); };
	});
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/threads') return route.fulfill({ json: { data: all().map((thread) => ({ ...thread, turns: undefined })), defaultCwd: '/tmp' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: all().map((thread) => thread.id) } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		const thread = all().find((thread) => path.startsWith(`/api/threads/${thread.id}`));
		if (thread) return route.fulfill({ json: { thread } });
		return route.fulfill({ json: {} });
	});
	await page.goto('/s/open-session');
	await expect(page.getByText('Before the restart.')).toBeVisible();
	await expect(page.getByRole('link', { name: 'Running Busy session' })).toBeVisible();
	await expect(page.getByRole('link', { name: 'Running Ending session' })).toBeVisible();

	// Yacwu restarts: the stream drops and connects again.
	restarted = true;
	await page.evaluate(() => { const w = window as any; w.__sse.onerror?.({}); w.__connected(); });

	await expect(page.getByText('Written while Yacwu restarted.')).toBeVisible();
	await expect(page.locator('.item.agent', { hasText: 'Before the restart.' })).toHaveCount(1);
	await expect(page.getByRole('link', { name: 'Idle Ending session' })).toBeVisible();
	const busyRow = page.locator('.session-row', { has: page.getByRole('link', { name: 'Running Busy session' }) });
	await expect(busyRow.locator('.session-progress-percent')).toHaveText('60%');
});
