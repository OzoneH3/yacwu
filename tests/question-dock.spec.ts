import { expect, test, type Page } from '@playwright/test';

// An agent's question docks under the transcript instead of a modal dialog,
// so the message that asks it stays readable and the page stays usable.

const ID = 'question-session';
const report = 'The adapter looks up the transcript by folder. Copying it first would keep the history.';

async function mock(page: Page) {
	const sent: Record<string, unknown>[] = [];
	const thread = { id: ID, name: 'question', cwd: '/tmp', host: 'local', status: { type: 'idle' }, turns: [{ id: 'turn-1', status: 'completed', items: [
		{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Is there a way around this?' }] },
		{ type: 'agentMessage', id: 'a1', text: `${report}\n\nShould I build it?\n\n- Yes\n- No` }
	] }] };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/tmp' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [ID] } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		if (path === `/api/threads/${ID}/message`) {
			sent.push(route.request().postDataJSON());
			return route.fulfill({ json: { turn: { id: 'turn-2', status: 'inProgress', items: [] } } });
		}
		if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread } });
		return route.fulfill({ json: {} });
	});
	await page.goto(`/s/${ID}`);
	return sent;
}

test('the question docks below the message that asks it, without blocking the page', async ({ page }) => {
	const sent = await mock(page);
	const panel = page.getByRole('region', { name: 'Codex has a question' });
	await expect(panel).toBeVisible();
	await expect(panel).toContainText('Should I build it?');
	await expect(page.locator('dialog[open]')).toHaveCount(0);
	await expect(page.getByText(report)).toBeVisible();
	// The rest of the page remains usable while the question waits.
	await page.getByLabel('Show all activity').check();
	const panelTop = (await panel.boundingBox())!.y;
	expect((await page.getByText(report).boundingBox())!.y).toBeLessThan(panelTop);
	await panel.getByRole('button', { name: /No$/ }).click();
	await expect.poll(() => sent.length).toBe(1);
	expect(String(sent[0].text)).toContain('I choose: No');
});

test('Escape dismisses the docked question', async ({ page }) => {
	await mock(page);
	const panel = page.getByRole('region', { name: 'Codex has a question' });
	await panel.getByRole('button', { name: /Yes$/ }).focus();
	await page.keyboard.press('Escape');
	await expect(panel).toHaveCount(0);
});
