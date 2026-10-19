import { expect, test } from '@playwright/test';

// "/todo rm " lists the session's tasks like the slash command list: queued
// ones can be picked to fill in their number, finished and running ones are
// marked and cannot be picked.

test('/todo rm offers the tasks and fills in the picked number', async ({ page }) => {
	const thread = { id: 'todo-pick', cwd: '/tmp', status: { type: 'active' }, turns: [{ id: 'running', status: 'inProgress', items: [{ id: 'initial', type: 'userMessage', content: [{ type: 'text', text: 'Existing task' }] }] }] };
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
	await expect(page.getByRole('button', { name: 'Stop current turn', exact: true })).toBeVisible();
	const box = page.locator('.composer textarea');
	for (const task of ['Write the docs', 'Run the benchmark']) {
		await box.fill(`/todo ${task}`);
		await page.locator('button.send').click();
		await expect(page.locator('.item.note').last()).toContainText('Todo queued');
	}

	await box.fill('/todo rm ');
	const list = page.getByRole('listbox', { name: 'Tasks to remove' });
	await expect(list.getByRole('option')).toHaveCount(3);
	const running = list.getByRole('option').filter({ hasText: 'Existing task' });
	await expect(running).toContainText('working');
	await expect(running).toBeDisabled();
	await expect(list.getByRole('option').filter({ hasText: 'Write the docs' })).toContainText('queued');

	// Keyboard: the first queued task is highlighted; Down moves to the next.
	await box.press('ArrowDown');
	await box.press('Enter');
	await expect(box).toHaveValue('/todo rm 3');
	await expect(list).toHaveCount(0);
	await box.press('Enter');
	await expect(page.locator('.item.note').last()).toContainText('Removed queued todo 3.');

	// Mouse: clicking a queued task fills in its number too.
	await box.fill('/todo rm');
	await list.getByRole('option').filter({ hasText: 'Write the docs' }).click();
	await expect(box).toHaveValue('/todo rm 2');
	// Escape hides the list until the text changes.
	await box.fill('/todo rm ');
	await box.press('Escape');
	await expect(list).toHaveCount(0);
});
