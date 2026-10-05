import { test, expect, type Page } from '@playwright/test';

const id = 'thr-stop-regression';

async function runningSession(page: Page) {
	const state = { turnId: 'turn-restored', status: 'active', stopError: '', interrupts: [] as string[], diagnostics: [] as string[], messages: [] as any[] };
	await page.route('**/api/**', async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		const thread = {
			id, name: 'Stop regression', cwd: '/tmp', status: { type: state.status },
			turns: [{ id: state.turnId, status: state.status === 'active' ? 'inProgress' : 'completed', items: [] }]
		};
		if (path === '/api/events') {
			return route.fulfill({ contentType: 'text/event-stream', body: 'data: {"method":"yacwu/connected"}\n\n' });
		}
		if (path.endsWith('/diagnostics')) {
			state.diagnostics.push(route.request().postDataJSON().event);
			return route.fulfill({ json: { connection: 'connected' } });
		}
		if (path.endsWith('/interrupt')) {
			state.interrupts.push(route.request().postDataJSON().turnId);
			if (state.stopError) return route.fulfill({ status: 500, json: { error: state.stopError } });
			state.status = 'idle';
			return route.fulfill({ json: {} });
		}
		if (path.endsWith('/message')) {
			state.messages.push(route.request().postDataJSON());
			return route.fulfill({ json: {} });
		}
		if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/tmp' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [id] } });
		if (path === `/api/threads/${id}` || path.endsWith('/open')) return route.fulfill({ json: { thread } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'gpt-6-luna', effort: 'low' } });
		return route.fulfill({ json: { data: [], goal: null } });
	});
	await page.goto(`/s/${id}`);
	await expect(page.getByRole('button', { name: 'Stop current turn', exact: true })).toBeVisible();
	return state;
}

test('reopened running session restores the turn ID for steering and stopping', async ({ page }) => {
	const state = await runningSession(page);
	await page.locator('.composer textarea').fill('Check the current work');
	await page.getByRole('button', { name: 'Steer active task', exact: true }).click();
	await expect.poll(() => state.messages.length).toBe(1);
	expect(state.messages[0].turnId).toBe('turn-restored');
	await page.getByRole('button', { name: 'Stop current turn', exact: true }).click();
	await expect.poll(() => state.interrupts).toEqual(['turn-restored']);
	await expect.poll(() => state.diagnostics).toContain('stop_requested');
	await expect.poll(() => state.diagnostics).toContain('stop_succeeded');
	await expect(page.getByRole('button', { name: 'Stop current turn', exact: true })).toHaveCount(0);
});

test('Stop refreshes a stale turn ID before interrupting', async ({ page }) => {
	const state = await runningSession(page);
	state.turnId = 'turn-current';
	await page.getByRole('button', { name: 'Stop current turn', exact: true }).click();
	await expect.poll(() => state.interrupts).toEqual(['turn-current']);
	await expect(page.getByRole('button', { name: 'Stop current turn', exact: true })).toHaveCount(0);
});

test('failed Stop displays the backend error and can be retried', async ({ page }) => {
	const state = await runningSession(page);
	state.stopError = 'Cancellation unavailable';
	const stop = page.getByRole('button', { name: 'Stop current turn', exact: true });
	await stop.click();
	await expect(page.getByText('Could not stop task: Cancellation unavailable', { exact: true })).toBeVisible();
	await expect(stop).toBeEnabled();
	await expect.poll(() => state.diagnostics).toContain('stop_failed');
	state.stopError = '';
	await stop.click();
	await expect.poll(() => state.interrupts.length).toBe(2);
	await expect(stop).toHaveCount(0);
});

test('Stop clears stale running status when the server has already finished', async ({ page }) => {
	const state = await runningSession(page);
	state.status = 'idle';
	await page.getByRole('button', { name: 'Stop current turn', exact: true }).click();
	await expect(page.getByRole('button', { name: 'Stop current turn', exact: true })).toHaveCount(0);
	expect(state.interrupts).toEqual([]);
});
