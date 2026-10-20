import { expect, test } from '@playwright/test';

test('todo attachments stay queued across reload and reach only their task', async ({ page }) => {
	let running = true;
	const messages: string[] = [];
	const thread = () => ({ id: 'todo-files', cwd: '/project', status: { type: running ? 'active' : 'idle' }, turns: running ? [{ id: 'running', status: 'inProgress', items: [{ id: 'initial', type: 'userMessage', content: [{ type: 'text', text: 'Existing task' }] }] }] : [] });
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		let data: object = {};
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') data = { data: [thread()], defaultCwd: '/project' };
		else if (path === '/api/threads/loaded') data = { data: ['todo-files'] };
		else if (path.endsWith('/message')) { messages.push(route.request().postDataBuffer()?.toString() ?? ''); }
		else if (path.endsWith('/model')) data = { model: 'test', effort: 'medium', models: [] };
		else if (path.endsWith('/runtime')) data = { status: running ? 'active' : 'idle' };
		else if (path.startsWith('/api/threads/')) data = { thread: thread() };
		await route.fulfill({ json: data });
	});
	await page.goto('/s/todo-files');
	await expect(page.getByRole('button', { name: 'Stop current turn', exact: true })).toBeVisible();
	const box = page.locator('.composer textarea');
	await page.locator('input[type=file]').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Attached task instructions') });
	await box.fill('/todo');
	await page.locator('button.send').click();
	await expect(page.locator('.item.note').last()).toContainText('no queued todos');
	await expect(page.getByLabel('Attached files')).toBeVisible();
	expect(messages).toHaveLength(0);
	// A quota failure keeps the complete draft, and must not enqueue partial work.
	await page.evaluate(() => {
		const original = Storage.prototype.setItem;
		Storage.prototype.setItem = function(key, value) {
			if (key === 'yacwu-todo-queues') throw new DOMException('full', 'QuotaExceededError');
			original.call(this, key, value);
		};
		(window as any).restoreTodoStorage = () => { Storage.prototype.setItem = original; };
	});
	await box.fill('/todo Read these notes');
	await page.locator('button.send').click();
	await expect(page.locator('.item.note').last()).toContainText('Your draft has been kept');
	await expect(box).toHaveValue('/todo Read these notes');
	await expect(page.getByLabel('Attached files')).toBeVisible();
	expect(messages).toHaveLength(0);
	await page.evaluate(() => (window as any).restoreTodoStorage());
	await page.locator('button.send').click();
	await expect(page.locator('.item.note').last()).toContainText('Todo queued', { timeout: 5000 });
	expect(messages).toHaveLength(0);
	await expect(page.getByLabel('Attached files')).toHaveCount(0);
	await page.reload();
	await box.fill('/todo');
	await page.locator('button.send').click();
	await expect(page.locator('.item.note').last()).toContainText('Read these notes');
	expect(messages).toHaveLength(0);
	running = false;
	await page.reload();
	await expect.poll(() => messages.length).toBe(1);
	expect(messages[0]).toContain('Read these notes');
	expect(messages[0]).not.toContain('/todo Read');
	expect(messages[0]).toContain('notes.txt');
	expect(messages[0]).toContain('Attached task instructions');
});
