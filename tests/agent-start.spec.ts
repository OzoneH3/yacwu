import { expect, test, type Page } from '@playwright/test';

// Spawned agents get a "Started <path>" row linking to their transcript, for
// Claude (whose adapter only records the spawn) as for Codex (which also
// sends its own subAgentActivity item) — once each, never twice.

const ROOT = 'agent-root';
const CHILD = '7639120c-6289-4981-ad03-d4df1713c62e';

const spawn = {
	type: 'collabAgentToolCall', id: 'spawn-1', tool: 'spawnAgent', status: 'completed',
	senderThreadId: ROOT, receiverThreadIds: [CHILD], prompt: 'Review phase B of the recipe', agentsStates: {}
};

async function mock(page: Page, items: object[]) {
	const thread = { id: ROOT, name: 'root', cwd: '/tmp', status: { type: 'idle' }, turns: [{ id: 'turn-1', status: 'completed', items: [
		{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Delegate the review' }] },
		...items,
		{ type: 'agentMessage', id: 'a1', text: 'Started the reviewer.' }
	] }] };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/tmp' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [ROOT] } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		if (path === `/api/threads/${CHILD}`) return route.fulfill({ json: { thread: { id: CHILD, cwd: '/tmp', status: { type: 'idle' }, turns: [] } } });
		if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread } });
		return route.fulfill({ json: {} });
	});
	await page.goto(`/s/${ROOT}`);
	await page.getByLabel('Show all activity').check();
}

test('a Claude spawn shows one Started row that opens the agent', async ({ page }) => {
	await mock(page, [spawn]);
	const started = page.locator('.item.subagent');
	await expect(started).toHaveCount(1);
	await expect(started).toContainText('Started /root/agent-7639120c6289');
	await started.getByRole('button', { name: '/root/agent-7639120c6289' }).click();
	await expect(page).toHaveURL(new RegExp(`/s/${ROOT}\\?agent=${CHILD}`));
});

test('a Codex spawn with its own activity item is not shown twice', async ({ page }) => {
	await mock(page, [spawn, { type: 'subAgentActivity', id: 'act-1', kind: 'started', agentThreadId: CHILD, agentPath: '/root/recipe_phase_b_review' }]);
	const started = page.locator('.item.subagent');
	await expect(started).toHaveCount(1);
	await expect(started).toContainText('Started /root/recipe_phase_b_review');
});
