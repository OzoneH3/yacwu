import { expect, test, type Page } from '@playwright/test';

// Live finishes and questions play a short sound; loading history stays
// silent; the top-right speaker button mutes them.

const ID = 'sound-session';
const FINISH = [659.25, 880];
const QUESTION = [783.99, 1046.5];

async function mock(page: Page) {
	await page.addInitScript(() => {
		const w = window as any;
		w.__played = [];
		class FakeAudioContext {
			state = 'running'; currentTime = 0; destination = {};
			createOscillator() {
				const oscillator = { type: '', frequency: { value: 0 }, connect: (node: unknown) => node, start: () => w.__played.push(oscillator.frequency.value), stop() {} };
				return oscillator;
			}
			createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (node: unknown) => node }; }
			resume() { return Promise.resolve(); }
		}
		w.AudioContext = FakeAudioContext;
		class FakeEventSource {
			onopen: any = null; onmessage: any = null; onerror: any = null; readyState = 1;
			constructor(public url: string) { w.__sse = this; setTimeout(() => { this.onopen?.({}); this.onmessage?.({ data: JSON.stringify({ method: 'yacwu/connected', params: {} }) }); }, 0); }
			addEventListener() {} close() { this.readyState = 2; }
		}
		w.EventSource = FakeEventSource;
		w.__emit = (msg: unknown) => w.__sse?.onmessage?.({ data: JSON.stringify(msg) });
	});
	// History already ends with a question: opening it must stay silent.
	const thread = { id: ID, name: 'sounds', cwd: '/tmp', host: 'local', status: { type: 'idle' }, turns: [{ id: 't0', status: 'completed', items: [
		{ type: 'userMessage', id: 'u0', content: [{ type: 'text', text: 'Earlier' }] },
		{ type: 'agentMessage', id: 'a0', text: 'Should I continue?' }
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
	await expect(page.getByText('Should I continue?').first()).toBeVisible();
	await page.mouse.click(5, 5); // a user gesture unlocks audio
}

const played = (page: Page) => page.evaluate(() => (window as any).__played as number[]);
const emit = (page: Page, msg: unknown) => page.evaluate((m) => (window as any).__emit(m), msg);

async function turn(page: Page, turnId: string, text: string) {
	await emit(page, { method: 'turn/started', params: { threadId: ID, turn: { id: turnId, status: 'inProgress', items: [] } } });
	await emit(page, { method: 'item/started', params: { threadId: ID, turnId, item: { type: 'userMessage', id: `u-${turnId}`, content: [{ type: 'text', text: 'go' }] } } });
	await emit(page, { method: 'item/completed', params: { threadId: ID, turnId, item: { type: 'agentMessage', id: `a-${turnId}`, text } } });
	await emit(page, { method: 'turn/completed', params: { threadId: ID, turn: { id: turnId, status: 'completed', items: [] } } });
}

test('history is silent; a live finish chimes, a live question pings once', async ({ page }) => {
	await mock(page);
	await page.waitForTimeout(400);
	expect(await played(page)).toEqual([]);
	await turn(page, 't1', 'All done.');
	await expect.poll(() => played(page)).toEqual(FINISH);
	await page.waitForTimeout(2_600); // past the per-session cooldown
	await turn(page, 't2', 'Which branch should I use?');
	await expect.poll(() => played(page)).toEqual([...FINISH, ...QUESTION]);
	await page.waitForTimeout(500);
	expect(await played(page)).toEqual([...FINISH, ...QUESTION]);
});

test('the speaker button mutes sounds', async ({ page }) => {
	await mock(page);
	await page.getByRole('button', { name: 'Mute sounds' }).click();
	await expect(page.getByRole('button', { name: 'Unmute sounds' })).toBeVisible();
	await turn(page, 't1', 'All done.');
	await page.waitForTimeout(600);
	expect(await played(page)).toEqual([]);
});
