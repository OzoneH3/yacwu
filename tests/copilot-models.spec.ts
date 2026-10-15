import { expect, test } from '@playwright/test';

// A Copilot session's model picker groups explicit models by maker, hides
// dominated GPT/Claude options without learned costs, and offers each
// model's own thinking levels.

test('Copilot models are grouped by maker with their own thinking levels', async ({ page }) => {
	const thread = { id: 'copilot-models', cwd: '/tmp', status: { type: 'idle' }, turns: [] };
	const models = [
		{ id: 'copilot/auto', displayName: 'Auto · Copilot picks · 1x', efforts: [], defaultEffort: 'medium' },
		{ id: 'copilot/claude-opus-5.5', displayName: 'Claude Opus 5.5 · 15x', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
		{ id: 'copilot/claude-sonnet-4.5', displayName: 'Claude Sonnet 4.5 · 1x', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
		{ id: 'copilot/gpt-6-luna', displayName: 'GPT-6 Luna · 0.33x', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
		{ id: 'copilot/gpt-6-sol', displayName: 'GPT-6 Sol · 1x', efforts: ['low', 'medium'], defaultEffort: 'medium' },
		{ id: 'copilot/claude-sonnet-5.5', displayName: 'Claude Sonnet 5.5 · 1x', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
		{ id: 'copilot/gpt-6.1-sol', displayName: 'GPT-6.1 Sol · 1x', efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
		{ id: 'copilot/grok-4.7', displayName: 'Grok 4.7 · 1x', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' }
	].map(choice => ({ ...choice, displayName: `Copilot · ${choice.displayName}` }));
	let settings = { model: 'copilot/auto', effort: 'medium', models };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		let data: object = {};
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') data = { data: [thread], defaultCwd: '/tmp' };
		else if (path === '/api/threads/loaded') data = { data: [thread.id] };
		else if (path.endsWith('/model')) {
			if (route.request().method() === 'POST') settings = { ...settings, ...route.request().postDataJSON() };
			data = settings;
		} else if (path.startsWith('/api/threads/')) data = { thread };
		await route.fulfill({ json: data });
	});
	await page.goto(`/s/${thread.id}`);
	const picker = page.getByLabel('Model', { exact: true });
	await expect(picker).toBeVisible();
	await expect(picker).toHaveValue('copilot/gpt-6-luna');
	await expect(picker.locator('optgroup')).toHaveCount(3);
	expect(await picker.locator('optgroup').evaluateAll((groups) => groups.map((g) => g.getAttribute('label')))).toEqual(['Claude', 'OpenAI', 'xAI']);
	await expect(picker.locator('option')).toHaveText(['Claude Sonnet 5.5 · 1x', 'Claude Opus 5.5 · 15x', 'GPT-6 Luna · 0.33x', 'GPT-6.1 Sol · 1x', 'Grok 4.7 · 1x']);
	await expect(page.getByLabel('Thinking strength').locator('option')).toHaveText(['None', 'Low', 'Medium', 'High', 'Xhigh', 'Max']);
	await picker.selectOption('copilot/grok-4.7');
	await expect(page.getByLabel('Thinking strength').locator('option')).toHaveText(['Low', 'Medium', 'High', 'Xhigh']);
});
