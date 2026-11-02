import { expect, test } from '@playwright/test';

test('pasted attachment opens without removing it; only the remove button removes it', async ({ page }) => {
	test.setTimeout(15000);
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
	await page.locator('.composer textarea').evaluate(element => {
		const clipboardData = new DataTransfer();
		clipboardData.items.add(new File(['Pasted file contents'], 'notes.txt', { type: 'text/plain' }));
		element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
	});
	await expect(page.getByLabel('Attached files')).toBeVisible();
	const popupPromise = page.waitForEvent('popup', { timeout: 5000 });
	await page.getByText('notes.txt', { exact: true }).click();
	const popup = await popupPromise;
	await expect(popup.locator('body')).toContainText('Pasted file contents');
	await expect(page.getByLabel('Attached files')).toBeVisible();
	await popup.close();
	await page.getByRole('button', { name: 'Remove notes.txt', exact: true }).click();
	await expect(page.getByLabel('Attached files')).toHaveCount(0);
	expect(messages).toHaveLength(0);
});
