import { expect, test } from '@playwright/test';

// A global Codex reset announced on codex-resets.com shows next to the Codex
// usage, so the rest of this week's allowance can be used first; once the
// reset has landed, the notice goes away.

const ID = 'reset-session';

test('an announced global reset shows next to Codex usage until it lands', async ({ page }) => {
	const preview = { kind: 'reset_preview', text: 'Global reset landing by EOD PST time. Enjoy', url: 'https://x.com/thsottiaux/status/1', at: new Date(Date.now() - 2 * 3600_000).toISOString() };
	let feed = [preview];
	const thread = { id: ID, name: 'reset', cwd: '/tmp', host: 'local', status: { type: 'idle' }, turns: [] };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/tmp' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [ID] } });
		if (path === '/api/reset-feed') return route.fulfill({ json: { entries: feed } });
		if (path === '/api/account') return route.fulfill({ json: { rateLimits: {
			primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 9999999999 },
			// This week began yesterday, before the announcement.
			secondary: { usedPercent: 52, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 6 * 86400 } } } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'gpt-6.1-sol', effort: 'medium', models: [] } });
		if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread } });
		return route.fulfill({ json: {} });
	});
	await page.goto(`/s/${ID}`);
	await expect(page.locator('.usage-limits')).toContainText('7d 48% left');
	const notice = page.locator('.reset-announced');
	await expect(notice).toContainText('Reset announced');
	await expect(notice).toHaveAttribute('href', 'https://x.com/thsottiaux/status/1');
	await expect(notice).toHaveAttribute('data-yacwu-tooltip', /Expected by .+ \(in \d+ (h|min)/);

	feed = [{ kind: 'reset', text: "It's done.", url: 'https://x.com/thsottiaux/status/2', at: new Date().toISOString() }, preview];
	await page.reload();
	await expect(page.locator('.usage-limits')).toContainText('7d 48% left');
	await expect(notice).toHaveCount(0);
});
