import { expect, test } from '@playwright/test';

// "Copy for coordinator" puts the task's context, request, response, changed
// files and linked file contents on the clipboard as one Markdown handoff.

const ID = 'handoff-session';

test('the handoff includes text and linked files', async ({ page, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	const thread = { id: ID, name: 'History zoom', cwd: '/home/u/growpilot', host: 'local', status: { type: 'idle' }, turns: [{ id: 't1', status: 'completed', items: [
		{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Add zoom to the History page\n\n<!-- YACWU_TASK_PROGRESS -->\nProgress reporting is required.\n[/YACWU_TASK_PROGRESS]' }] },
		{ type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: '/home/u/growpilot/web/history.js', kind: { type: 'update' } }] },
		{ type: 'agentMessage', id: 'a1', text: 'Zoom works. Notes in `docs/zoom.md` and code in `web/history.js`; assets in `web/static`.' }
	] }] };
	await page.route('**/api/**', async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/home/u' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [ID] } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'gpt-test', effort: 'high', models: [] } });
		if (path.endsWith('/git/changes')) return route.fulfill({ json: { available: true, branch: 'feature/history-zoom', files: [] } });
		if (path.endsWith('/path-kinds')) {
			const { paths } = route.request().postDataJSON() as { paths: string[] };
			return route.fulfill({ json: { kinds: Object.fromEntries(paths.map((p) => [p, p === 'web/static' ? 'dir' : 'file'])) } });
		}
		if (path.endsWith('/file')) {
			const file = url.searchParams.get('path');
			if (file === 'docs/zoom.md') return route.fulfill({ json: { content: '# Zoom\nPinch or scroll.\n' } });
			if (file === 'web/history.js') return route.fulfill({ json: { content: 'export const zoom = 2;\n' } });
			return route.fulfill({ status: 404, json: { error: 'not a file' } });
		}
		if (path.endsWith('/files')) return route.fulfill({ json: { entries: [{ name: 'app.css', kind: 'file' }] } });
		if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread } });
		return route.fulfill({ json: {} });
	});
	await page.goto(`/s/${ID}`);
	await page.getByRole('button', { name: 'Copy for coordinator' }).click();
	await expect(page.getByRole('button', { name: 'Handoff copied' })).toBeVisible();
	const copied = await page.evaluate(() => navigator.clipboard.readText());
	expect(copied).toContain('# Session result: History zoom');
	expect(copied).toContain('- Project folder: /home/u/growpilot');
	expect(copied).toContain('- Agent: Codex · gpt-test, high');
	expect(copied).toContain('- Git branch: feature/history-zoom');
	expect(copied).toContain('## Request\n\nAdd zoom to the History page\n\n## Result');
	expect(copied).not.toContain('YACWU_TASK_PROGRESS');
	expect(copied).toContain('Zoom works.');
	expect(copied).toContain('## Files changed in this task\n\n- web/history.js');
	expect(copied).toContain('### docs/zoom.md\n\n```md\n# Zoom\nPinch or scroll.\n```');
	expect(copied).toContain('### web/history.js\n\n```js\nexport const zoom = 2;\n```');
	expect(copied).not.toContain('### web/static');
});

test('Copy full result takes every response since the last prompt, with their files', async ({ page, context }) => {
	await context.grantPermissions(['clipboard-read', 'clipboard-write']);
	const thread = { id: ID, name: 'History zoom', cwd: '/home/u/growpilot', host: 'local', status: { type: 'idle' }, turns: [
		{ id: 't0', status: 'completed', items: [
			{ type: 'userMessage', id: 'u0', content: [{ type: 'text', text: 'Earlier question' }] },
			{ type: 'agentMessage', id: 'a0', text: 'Earlier answer about `old/file.js`.' }
		] },
		{ id: 't1', status: 'completed', items: [
			{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Finish the zoom work\nstep 2\nstep 3\nstep 4\nstep 5\nstep 6\nstep 7' }] },
			{ type: 'agentMessage', id: 'a1', text: 'Plan written to `docs/zoom.md`.\n\n[[YACWU_PROGRESS percent=40 remaining_minutes=5]]' },
			{ type: 'fileChange', id: 'f1', status: 'completed', changes: [{ path: '/home/u/growpilot/web/history.js', kind: { type: 'update' } }] },
			{ type: 'agentMessage', id: 'a2', text: 'Done. Code in `web/history.js`.' }
		] }
	] };
	await page.route('**/api/**', async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/home/u' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [ID] } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'gpt-test', effort: 'high', models: [] } });
		if (path.endsWith('/git/changes')) return route.fulfill({ json: { available: true, branch: 'feature/history-zoom', files: [] } });
		if (path.endsWith('/path-kinds')) return route.fulfill({ json: { kinds: {} } });
		if (path.endsWith('/file')) {
			const file = url.searchParams.get('path');
			if (file === 'docs/zoom.md') return route.fulfill({ json: { content: 'zoom plan\n' } });
			if (file === 'web/history.js') return route.fulfill({ json: { content: 'export const zoom = 2;\n' } });
			if (file === 'old/file.js') return route.fulfill({ json: { content: 'old\n' } });
			return route.fulfill({ status: 404, json: { error: 'missing' } });
		}
		if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread } });
		return route.fulfill({ json: {} });
	});
	await page.goto(`/s/${ID}`);
	await page.getByRole('button', { name: 'Copy full result' }).click();
	await expect(page.getByRole('button', { name: 'Full result copied' })).toBeVisible();
	const copied = await page.evaluate(() => navigator.clipboard.readText());
	// Only the start of a long prompt: the responses are what matter here.
	expect(copied).toContain('## Request\n\nFinish the zoom work\nstep 2\nstep 3\nstep 4\nstep 5\n\n[… prompt shortened: 2 more lines]\n\n## Result\n\nPlan written to `docs/zoom.md`.\n\n---\n\nDone. Code in `web/history.js`.');
	expect(copied).not.toContain('step 6');
	expect(copied).not.toContain('YACWU_PROGRESS');
	expect(copied).not.toContain('Earlier');
	expect(copied).toContain('## Files changed in this task\n\n- web/history.js');
	expect(copied).toContain('### docs/zoom.md');
	expect(copied).toContain('### web/history.js');
	expect(copied).not.toContain('old/file.js');
});
