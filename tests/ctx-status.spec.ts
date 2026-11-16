import { expect, test } from '@playwright/test';

for (const wrapped of [false, true]) {
	test(`/ctx-status renders ${wrapped ? 'wrapped' : 'bare'} Magic Context status`, async ({ page }) => {
		const thread = { id: 'ctx-test', cwd: '/project', status: { type: 'idle' }, turns: [] };
		const status = { usagePercentage: 42.5, inputTokens: 71400, contextLimit: 168000, pluginVersion: '0.49.56' };
		await page.route('**/api/**', async route => {
			const path = new URL(route.request().url()).pathname;
			if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
			let data: object = {};
			if (path === '/api/hosts') data = { hosts: [{ name: 'opencode', kind: 'backend', provider: 'opencode', state: 'connected' }] };
			else if (path === '/api/threads') data = { data: [thread], defaultCwd: '/project' };
			else if (path.endsWith('/ctx-status')) data = wrapped ? { status } : status;
			else if (path.endsWith('/model')) data = { model: 'opencode/openai/gpt-6-luna', effort: 'medium', models: [] };
			else if (path.endsWith('/file-access')) data = { mode: 'read-write', readOnlySupported: false };
			else if (path.startsWith('/api/threads/')) data = { thread };
			await route.fulfill({ json: data });
		});
		await page.goto('/s/ctx-test?host=opencode');
		await page.locator('.composer textarea').fill('/ctx-status');
		await page.locator('button.send').click();
		await expect(page.locator('.item.note').last()).toContainText('Context: 42.5%');
		await expect(page.locator('.item.note').last()).toContainText('71,400 / 168,000 tokens');
		await expect(page.locator('.item.note').last()).not.toContainText('returned no status');
	});
}
