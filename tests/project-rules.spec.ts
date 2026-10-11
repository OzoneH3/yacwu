import { expect, test } from '@playwright/test';

// Project rules: the session bar flags a session that started with older
// rules, and Session details shows and edits the project's rules.

const ID = 'rules-session';

test('outdated rules are flagged, shown and editable', async ({ page }) => {
	const saved: unknown[] = [];
	let version = 4;
	let text = 'Reuse before creating.';
	const thread = { id: ID, name: 'RESEARCH 3', cwd: '/home/u/growpilot/.workspace/wt/zoom', host: 'local', status: { type: 'idle' }, turns: [] };
	await page.route('**/api/**', async (route) => {
		const request = route.request();
		const path = new URL(request.url()).pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/home/u' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [ID] } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		if (path === `/api/threads/${ID}/project-rules`) {
			if (request.method() === 'POST') {
				saved.push(request.postDataJSON());
				text = (request.postDataJSON() as { text: string }).text;
				version += 1;
			}
			return route.fulfill({ json: {
				current: { project: 'local:/home/u/growpilot/.git', name: 'growpilot', identity: '/home/u/growpilot/.git', text, version, updatedAt: 1 },
				applied: { project: 'local:/home/u/growpilot/.git', version: 3, appliedAt: 1 },
				status: 'outdated'
			} });
		}
		if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread } });
		return route.fulfill({ json: {} });
	});
	await page.goto(`/s/${ID}`);
	await expect(page.locator('.fact.rules-outdated')).toHaveText('Rules outdated');
	await page.getByRole('button', { name: /^Session details/ }).click();
	await expect(page.getByRole('heading', { name: 'Project rules · growpilot' })).toBeVisible();
	await expect(page.getByText('this session started with version 3; the project is now at version 4')).toBeVisible();
	const rules = page.getByLabel('Rules (version 4)');
	await expect(rules).toHaveValue('Reuse before creating.');
	await rules.fill('Reuse before creating. Explain why when you cannot.');
	await page.getByRole('button', { name: 'Save project rules' }).click();
	await expect(page.getByText('Saved. New sessions in this project start with these rules.')).toBeVisible();
	expect(saved).toEqual([{ text: 'Reuse before creating. Explain why when you cannot.' }]);
	await expect(page.getByLabel('Rules (version 5)')).toBeVisible();
});
