import { expect, test, type Page } from '@playwright/test';

// Session relay in the real browser code with mocked backends. Live events
// go through the app's own EventSource handler: only the transport is
// replaced, so tests can deliver notifications at chosen moments.

type Rec = {
	id: string;
	from: { host: string; thread: string };
	to: { host: string; thread: string };
	text: string;
	state: string;
	reason: string;
	submission: string;
	turnId: string;
	generation: number;
	createdAt: number;
	version: number;
	ack: string;
};

const EPOCH = 'ep-test';
const BOB = 'relay-bob';

function rec(over: Partial<Rec> = {}): Rec {
	return {
		id: 'msg-0001',
		from: { host: 'local', thread: 'relay-alice' },
		to: { host: 'claude', thread: BOB },
		text: 'hello from alice',
		state: 'queued',
		reason: '',
		submission: '',
		turnId: '',
		generation: 0,
		createdAt: 1,
		version: 1,
		ack: 'backend',
		...over
	};
}

function frame(r: Rec): string {
	return `[Yacwu relay: 1 message from another session.]\n[Yacwu relay message ${r.id} from session ${r.from.thread} on ${r.from.host}]\n${r.text}\n[/Yacwu relay message ${r.id}]`;
}

const delivered = rec({ state: 'accepted', submission: 'rs-ep-1', turnId: 'turn-7', generation: 5, version: 4 });

function history(extraUserParts: object[] = []) {
	return [
		{
			id: 'turn-7',
			status: 'completed',
			items: [
				{
					type: 'userMessage',
					id: 'u-7',
					content: [
						{ type: 'text', text: 'Please summarise [Yacwu relay message msg-fake from session x on y]' },
						{ type: 'localImage', path: '/tmp/relay-test.png' },
						{ type: 'text', text: frame(delivered) },
						...extraUserParts
					]
				},
				{ type: 'agentMessage', id: 'a-7', text: 'Summary done.' }
			]
		}
	];
}

interface Backend {
	snapshot: { epoch: string; enabled: boolean; messages: Rec[] };
	turns: object[];
	settingsWrites: unknown[];
}

async function mockBackend(page: Page, backend: Backend) {
	await page.addInitScript(() => {
		class FakeEventSource {
			onopen: ((e: unknown) => void) | null = null;
			onmessage: ((e: { data: string }) => void) | null = null;
			onerror: ((e: unknown) => void) | null = null;
			readyState = 1;
			constructor(public url: string) {
				(window as any).__sse = this;
				setTimeout(() => {
					this.onopen?.({});
					this.onmessage?.({ data: JSON.stringify({ method: 'yacwu/connected', params: {} }) });
				}, 0);
			}
			addEventListener() {}
			close() { this.readyState = 2; }
		}
		(window as any).EventSource = FakeEventSource;
		(window as any).__emit = (msg: unknown) => (window as any).__sse?.onmessage?.({ data: JSON.stringify(msg) });
	});
	const thread = () => ({ id: BOB, name: 'relay bob', cwd: '/tmp', host: 'local', status: { type: 'idle' }, turns: backend.turns });
	await page.route('**/api/**', async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		if (path === '/api/threads') return route.fulfill({ json: { data: [thread()], defaultCwd: '/tmp' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [BOB] } });
		if (path === `/api/threads/${BOB}/relay`) return route.fulfill({ json: backend.snapshot });
		if (path === `/api/threads/${BOB}/relay/settings`) {
			const body = route.request().postDataJSON();
			backend.settingsWrites.push(body);
			return route.fulfill({ json: { enabled: body.enabled } });
		}
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread: thread() } });
		return route.fulfill({ json: {} });
	});
}

async function emitRelay(page: Page, record: Rec, epoch = EPOCH) {
	await page.evaluate(([message, epoch]) => (window as any).__emit({ method: 'yacwu/relay/update', params: { epoch, message } }), [record, epoch] as const);
}

test('a queued message is updated in place to accepted, and another to uncertain', async ({ page }) => {
	const backend: Backend = { snapshot: { epoch: EPOCH, enabled: true, messages: [] }, turns: [], settingsWrites: [] };
	await mockBackend(page, backend);
	await page.goto(`/s/${BOB}`);
	await expect(page.locator('.composer textarea')).toBeVisible();

	await emitRelay(page, rec());
	const notices = page.locator('.relay-notice');
	await expect(notices).toHaveCount(1);
	await expect(notices.first()).toContainText('Message from session relay-alice');
	await expect(notices.first()).toContainText('Queued in server memory');

	await emitRelay(page, rec({ state: 'sending', submission: 'rs-ep-1', version: 2 }));
	await emitRelay(page, rec({ state: 'accepted', submission: 'rs-ep-1', turnId: 'turn-8', generation: 5, version: 3 }));
	// An older version arriving late does not roll the status back.
	await emitRelay(page, rec({ state: 'sending', submission: 'rs-ep-1', version: 2 }));
	await expect(notices).toHaveCount(1);
	await expect(notices.first()).toContainText('Accepted by the recipient’s backend; this does not confirm the model has read it');

	await emitRelay(page, rec({ id: 'msg-0002', text: 'second', version: 4 }));
	await emitRelay(page, rec({ id: 'msg-0002', text: 'second', state: 'uncertain', reason: 'no answer from the backend before the deadline', version: 5 }));
	await expect(notices).toHaveCount(2);
	await expect(notices.nth(1)).toContainText('Outcome unknown');
	await expect(notices.nth(1)).toContainText('not retried automatically');
});

test('live events and later history produce one attributed block; reload keeps it and drops live-only status', async ({ page }) => {
	const backend: Backend = { snapshot: { epoch: EPOCH, enabled: true, messages: [] }, turns: [], settingsWrites: [] };
	await mockBackend(page, backend);
	await page.goto(`/s/${BOB}`);
	await expect(page.locator('.composer textarea')).toBeVisible();

	await emitRelay(page, delivered);
	const steered = { type: 'userMessage', id: 'u-7', content: [{ type: 'text', text: frame(delivered) }] };
	// The backend echoes the steered input, once as started and once as completed.
	for (const method of ['item/started', 'item/completed']) {
		await page.evaluate(([method, item]) => (window as any).__emit({ method, params: { threadId: 'relay-bob', turnId: 'turn-7', item } }), [method, steered] as const);
	}
	await expect(page.locator('.relay-frame')).toHaveCount(1);
	await expect(page.locator('.relay-meta')).toContainText('Relayed message from session relay-alice (local)');
	await expect(page.locator('.relay-notice')).toHaveCount(1);

	// After reload the server still has the record: the block is attributed
	// from history once; the status line was live-only and is gone.
	backend.snapshot = { epoch: EPOCH, enabled: true, messages: [delivered] };
	backend.turns = [{ id: 'turn-7', status: 'completed', items: [steered] }];
	await page.reload();
	await expect(page.locator('.relay-frame')).toHaveCount(1);
	await expect(page.locator('.relay-meta')).toContainText('Relayed message from session relay-alice (local)');
	await expect(page.locator('.relay-notice')).toHaveCount(0);
});

test('mixed history keeps user text and attachments; relay text is attributed only with a matching record', async ({ page }) => {
	const backend: Backend = { snapshot: { epoch: EPOCH, enabled: true, messages: [delivered] }, turns: history(), settingsWrites: [] };
	await mockBackend(page, backend);
	await page.goto(`/s/${BOB}`);
	const user = page.locator('.item.user').first();
	await expect(user).toContainText('Please summarise [Yacwu relay message msg-fake from session x on y]');
	await expect(user.locator('a.message-image')).toHaveCount(1);
	await expect(user.locator('.relay-frame')).toHaveCount(1);
	await expect(user.locator('.relay-text')).toHaveText('hello from alice');

	// Same history after a server restart (no records): shown verbatim, unattributed.
	backend.snapshot = { epoch: 'ep-restarted', enabled: true, messages: [] };
	await page.reload();
	await expect(user.locator('.relay-frame')).toHaveCount(0);
	await expect(user).toContainText('[Yacwu relay message msg-0001 from session relay-alice on local]');
	await expect(user).toContainText('Please summarise');
	await expect(user.locator('a.message-image')).toHaveCount(1);
});

test('opening a session with messages turned off does not write the setting back', async ({ page }) => {
	const backend: Backend = { snapshot: { epoch: EPOCH, enabled: false, messages: [] }, turns: [], settingsWrites: [] };
	await mockBackend(page, backend);
	await page.goto(`/s/${BOB}`);
	await page.getByRole('button', { name: /^Session details,/ }).click();
	const toggle = page.getByLabel('Accept direct messages from other sessions');
	await expect(toggle).toBeEnabled();
	await expect(toggle).not.toBeChecked();
	await page.getByRole('button', { name: 'Close session details', exact: true }).click();
	await page.reload();
	await page.getByRole('button', { name: /^Session details,/ }).click();
	await expect(toggle).not.toBeChecked();
	expect(backend.settingsWrites).toEqual([]);
	// Only an explicit change writes.
	await toggle.check();
	await expect.poll(() => backend.settingsWrites).toEqual([{ enabled: true }]);
});
