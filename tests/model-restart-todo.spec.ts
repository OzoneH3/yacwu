import { expect, test } from '@playwright/test';

test('model restart stays available with todos and restarts the current task without advancing the queue', async ({ page }) => {
	const thread = { id: 'restart-todo', cwd: '/project', status: { type: 'active' }, turns: [{ id: 'running', status: 'inProgress', items: [{ id: 'initial', type: 'userMessage', content: [{ type: 'text', text: 'Original task' }] }] }] };
	let model = 'gpt-6.1-sol';
	const messages: string[] = [];
	await page.addInitScript(() => {
		localStorage.setItem('yacwu-todo-queues', JSON.stringify({ 'restart-todo': { tasks: ['Next task'], startedCount: 0, currentTask: null, initialTask: 'Original task' } }));
		(window as any).EventSource = class {
			onmessage: any; onopen: any; onerror: any;
			constructor() { (window as any).__events = this; }
			close() {}
		};
	});
	await page.route('**/api/**', async route => {
		const path = new URL(route.request().url()).pathname;
		let data: any = {};
		if (path === '/api/threads') data = { data: [thread], defaultCwd: '/project' };
		else if (path === '/api/threads/loaded') data = { data: [thread.id] };
		else if (path.endsWith('/model')) {
			if (route.request().method() === 'POST') model = route.request().postDataJSON().model ?? model;
			data = { model, effort: 'medium', models: ['gpt-6.1-sol', 'gpt-6-luna'].map(id => ({ id, displayName: id, efforts: ['low', 'medium'], defaultEffort: 'medium' })) };
		} else if (path.endsWith('/interrupt')) {
			thread.status.type = 'idle';
			thread.turns[0].status = 'interrupted';
			await page.evaluate(() => (window as any).__events.onmessage({ data: JSON.stringify({ method: 'turn/completed', params: { threadId: 'restart-todo', turn: { id: 'running', status: 'interrupted' } } }) }));
		} else if (path.endsWith('/message')) {
			messages.push(route.request().postDataJSON().text);
			data = { turn: { id: 'restarted' } };
		} else if (path.startsWith('/api/threads/')) data = { thread };
		await route.fulfill({ json: data });
	});
	await page.goto(`/s/${thread.id}`);
	await expect(page.getByRole('button', { name: 'Stop current turn', exact: true })).toBeVisible();
	await page.locator('.model-picker select').selectOption('gpt-6-luna');
	await expect(page.locator('.switch-prompt-model')).toBeVisible();
	await page.locator('.switch-prompt-model').click();
	await expect.poll(() => messages.length).toBe(1);
	expect(messages[0]).toMatch(/^Original task/);
	expect(await page.evaluate(() => JSON.parse(localStorage.getItem('yacwu-todo-queues')!)['restart-todo'])).toMatchObject({ tasks: ['Next task'], startedCount: 0 });
});
