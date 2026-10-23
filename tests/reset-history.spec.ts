import { expect, test } from '@playwright/test';

for (const provider of ['codex', 'claude']) {
	test(`reset history appears only for Codex: ${provider}`, async ({ page }) => {
		const now = Date.parse('2026-10-23T12:00:00Z');
		await page.clock.install({ time: now });
		const host = provider === 'claude' ? 'claude' : 'local';
		const thread = { id: 'reset-history', host, name: 'Reset history', cwd: '/project', status: { type: 'idle' }, turns: [] };
		let feed = [
			...['2026-10-20', '2026-10-17', '2026-10-15', '2026-10-11'].map((day) => ({ kind: 'reset', text: `Completed report ${day}`, at: day+'T00:00:00Z', url: `https://willreset.com/r/${day}` })),
			{ kind: 'banked', text: 'Banked grant', at: '2026-10-21T00:00:00Z', url: 'https://willreset.com/r/banked' },
			{ kind: 'reset_preview', text: 'Reset by EOD', at: '2026-10-23T10:00:00Z', url: 'https://willreset.com/r/preview' }
		];
		await page.route('**/api/**', async (route) => {
			const path = new URL(route.request().url()).pathname;
			if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
			if (path === '/api/hosts') return route.fulfill({ json: { hosts: [{ name: 'local', provider: 'codex', kind: 'local', state: 'connected' }, { name: 'claude', provider: 'claude', kind: 'backend', state: 'connected' }] } });
			if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/project' } });
			if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [thread.id] } });
			if (path === '/api/reset-feed') return route.fulfill({ json: { entries: feed } });
			if (path === '/api/account') return route.fulfill({ json: { rateLimits: { secondary: { usedPercent: 52, windowDurationMins: 10080, resetsAt: Math.floor(now/1000) + 6*86400 } } } });
			if (path.endsWith('/model')) return route.fulfill({ json: { model: provider === 'claude' ? 'claude-opus-5' : 'gpt-6.1-sol', effort: 'medium', models: [] } });
			if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread } });
			return route.fulfill({ json: {} });
		});
		await page.goto(`/s/${thread.id}${provider === 'claude' ? '?host=claude' : ''}`);
		await page.locator('.usage-limits .usage-details').click();
		const dialog = page.getByRole('dialog', { name: 'Task allowance usage' });
		await expect(dialog).toBeVisible();
		const section = dialog.getByRole('region', { name: 'Codex public reset reports' });
		if (provider === 'claude') { await expect(section).toHaveCount(0); return; }
		await expect(section).toContainText('Latest recorded reset report');
		await expect(section.locator('time').first()).toHaveAttribute('datetime', '2026-10-20T00:00:00Z');
		await expect(section).toContainText('Median gap 3.0 days');
		await expect(section).toContainText('typical gap already elapsed');
		await expect(section).toContainText('Reset announced');
		await expect(section).toContainText('cached records');
		await section.locator('summary').click();
		await expect(section.locator('tbody tr')).toHaveCount(4);
		await expect(section.getByRole('link', { name: 'Completed report 2026-10-20' })).toHaveAttribute('href', 'https://willreset.com/r/2026-10-20');
		await expect(section.locator('tbody')).not.toContainText('Banked grant');
		feed = [];
		await dialog.getByRole('button', { name: 'Refresh', exact: true }).click();
		await expect(section).toContainText('No completed reset reports available');
		await expect(section).not.toContainText('Historical estimate:');
	});
}
