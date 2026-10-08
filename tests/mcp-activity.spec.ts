import { expect, test } from '@playwright/test';

test('Claude MCP calls have readable activity and expandable data inside Background work', async ({ page }) => {
	const thread = { id: 'mcp-test', cwd: '/tmp', status: { type: 'active' }, turns: [{ id: 'turn', status: 'inProgress', items: [
		{ id: 'read', type: 'mcpToolCall', server: 'claude-code', tool: 'Read', status: 'completed', arguments: { file_path: '/project/README.md' }, result: { content: [{ type: 'text', text: 'File contents' }] }, durationMs: 123 },
		{ id: 'grep', type: 'mcpToolCall', server: 'claude-code', tool: 'Grep', status: 'inProgress', arguments: { pattern: 'temperature' } }
	] }] };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		let data: object = {};
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') data = { data: [thread], defaultCwd: '/tmp' };
		else if (path === '/api/threads/loaded') data = { data: [thread.id] };
		else if (path.endsWith('/model')) data = { model: 'test', effort: 'medium', models: [] };
		else if (path.startsWith('/api/threads/')) data = { thread };
		await route.fulfill({ json: data });
	});
	await page.goto(`/s/${thread.id}`);
	await expect(page.locator('.mcp-activity')).toHaveCount(1);
	await expect(page.locator('.mcp-activity')).toContainText('claude-code · Grep — temperature');
	await expect(page.locator('.working-description')).toContainText('Grep — temperature');
	await page.getByRole('button', { name: /Background work · 1 activity · completed/ }).click();
	const read = page.locator('.mcp-activity').filter({ hasText: 'claude-code · Read' });
	await read.locator('summary').click();
	await expect(read.locator('pre')).toContainText('/project/README.md');
	await expect(read.locator('pre')).toContainText('File contents');
	await expect(page.locator('.item.generic').filter({ hasText: 'mcpToolCall' })).toHaveCount(0);
});
