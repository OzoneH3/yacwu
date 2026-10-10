import { expect, test } from '@playwright/test';

// Paths that name folders are not file links: they render as plain code or
// text, while real files keep their open/copy controls.

const ID = 'dir-links';

test('folder paths are shown plain, file paths stay links', async ({ page }) => {
	const asked: string[][] = [];
	const thread = { id: ID, name: 'links', cwd: '/home/u/project', host: 'local', status: { type: 'idle' }, turns: [{ id: 't1', status: 'completed', items: [
		{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Where is it?' }] },
		{ type: 'agentMessage', id: 'a1', text: 'See `src/lib` and `src/lib/relay.ts`, the [workspace](.workspace) and `docs/`.' }
	] }] };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/home/u' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [ID] } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		if (path === `/api/threads/${ID}/path-kinds`) {
			const { paths } = route.request().postDataJSON() as { paths: string[] };
			asked.push(paths);
			return route.fulfill({ json: { kinds: Object.fromEntries(paths.map((p) => [p, p.endsWith('.ts') ? 'file' : 'dir'])) } });
		}
		if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread } });
		return route.fulfill({ json: {} });
	});
	await page.goto(`/s/${ID}`);
	const message = page.locator('.markdown-body').filter({ hasText: 'See' });
	await expect(message.getByRole('button', { name: 'src/lib/relay.ts', exact: true })).toBeVisible();
	await expect(message.getByRole('button', { name: 'src/lib', exact: true })).toHaveCount(0);
	await expect(message.locator('code', { hasText: /^src\/lib$/ })).toBeVisible();
	await expect(message.getByRole('button', { name: 'workspace', exact: true })).toHaveCount(0);
	await expect(message.getByRole('link', { name: 'workspace' })).toHaveCount(0);
	await expect(message.getByText('workspace')).toBeVisible();
	// A trailing slash is a folder without asking the server.
	await expect(message.getByRole('button', { name: 'docs/', exact: true })).toHaveCount(0);
	expect(asked.flat()).not.toContain('docs');
});
