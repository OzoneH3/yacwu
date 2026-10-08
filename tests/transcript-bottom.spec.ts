import { expect, test } from '@playwright/test';

test('bottom button reaches the real end of a long virtualized transcript and returning from an agent does too', async ({ page }) => {
	const items = Array.from({ length: 100 }, (_, i) => ({ id: `message-${i}`, type: 'agentMessage', text: i === 99 ? 'Very last response' : (`Message ${i}\n\n` + 'A paragraph with enough content to wrap and change estimated row height. '.repeat(20)).repeat(i % 4 + 1) }));
	items.unshift({ id: 'agent-activity', type: 'collabAgentToolCall', tool: 'spawnAgent', senderThreadId: 'root-test', receiverThreadIds: ['agent-one'], agentsStates: { 'agent-one': { status: 'completed' } } } as any);
	const root = { id: 'root-test', name: 'Scroll test', cwd: '/tmp', status: { type: 'idle' }, turns: [{ id: 'turn-one', status: 'completed', items }] };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		let data: object = {};
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') data = { data: [root], defaultCwd: '/tmp' };
		else if (path === '/api/threads/loaded') data = { data: ['root-test', 'agent-one'] };
		else if (path.endsWith('/model')) data = { model: 'test', effort: 'medium', models: [] };
		else if (path.includes('/agent-one')) data = { thread: { id: 'agent-one', name: 'Agent one', forkedFromId: 'root-test', status: { type: 'idle' }, turns: [{ id: 'agent-turn', status: 'completed', items: [{ id: 'agent-message', type: 'agentMessage', text: 'Agent response' }] }] } };
		else if (path.startsWith('/api/threads/root-test')) data = { thread: root };
		await route.fulfill({ json: data });
	});
	await page.goto('/s/root-test');
	const transcript = page.locator('.transcript');
	const remaining = () => transcript.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
	await expect(page.getByText('Very last response', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: /^Session details,/ }).click();
	const details = page.getByRole('dialog', { name: 'Session details', exact: true });
	await expect(details.getByRole('heading', { name: 'Agents', exact: true })).toHaveCount(0);
	await expect(details.getByRole('heading', { name: 'Session rules', exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Close session details', exact: true }).click();
	await expect.poll(remaining).toBeLessThanOrEqual(2);
	await transcript.evaluate((el) => { el.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, bubbles: true })); el.scrollTop = 0; });
	await page.getByRole('button', { name: 'Scroll to bottom', exact: true }).click();
	await expect.poll(remaining).toBeLessThanOrEqual(2);
	await expect(page.getByText('Very last response', { exact: true })).toBeVisible();
	await page.locator('.agent-row button').filter({ hasText: /agent|Agent/ }).last().click();
	await expect(page.getByText('Agent response', { exact: true })).toBeVisible();
	await page.getByRole('button', { name: 'Session', exact: true }).click();
	await expect(page.getByText('Very last response', { exact: true })).toBeVisible();
	await expect.poll(remaining).toBeLessThanOrEqual(2);
});
