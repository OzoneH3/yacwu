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

test('the answer box spans the panel and sends with Enter like the message box', async ({ page }) => {
	const sent = await mock(page);
	const panel = page.getByRole('region', { name: 'Codex has a question' });
	const answer = panel.getByLabel('Other');
	await expect(answer).toBeVisible();
	const [box, label, form] = await Promise.all([answer.boundingBox(), panel.getByText('Other', { exact: true }).boundingBox(), panel.locator('.interactive-choice-other').boundingBox()]);
	expect(box!.y).toBeGreaterThan(label!.y + label!.height - 1);
	expect(box!.width).toBeGreaterThan(form!.width - 2);
	await answer.fill('Build it,');
	await answer.press('Shift+Enter');
	await answer.pressSequentially('but smaller');
	await expect(answer).toHaveValue('Build it,\nbut smaller');
	expect(sent).toHaveLength(0);
	await answer.press('Enter');
	await expect.poll(() => sent.length).toBe(1);
	expect(String(sent[0].text)).toContain('Build it,\nbut smaller');
});

test("a tool call's questions dock too and are answered to the tool, not as a message", async ({ page }) => {
	const sent: Record<string, unknown>[] = [];
	const answered: Record<string, unknown>[] = [];
	const thread = { id: ID, name: 'question', cwd: '/tmp', host: 'claude', status: { type: 'active', activeFlags: ['waitingOnUserInput'] }, turns: [{ id: 'turn-1', status: 'inProgress', items: [
		{ type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Set up auth' }] },
		{ type: 'dynamicToolCall', id: 'ask-1', namespace: 'claude', tool: 'AskUserQuestion', status: 'inProgress', arguments: { questions: [
			{ id: 'q0', header: 'Auth', question: 'Which auth method do you want?', isOther: false, isSecret: false, options: [{ label: 'OAuth', description: '' }, { label: 'API Key', description: '' }] },
			{ id: 'q1', header: 'Scope', question: 'Who should it cover?', isOther: false, isSecret: false, options: [{ label: 'Everyone', description: '' }, { label: 'Admins', description: '' }] }
		] } }
	] }] };
	await page.route('**/api/**', async (route) => {
		const path = new URL(route.request().url()).pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/tmp' } });
		if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [ID] } });
		if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
		if (path === `/api/threads/${ID}/message`) { sent.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); }
		if (path === `/api/threads/${ID}/user-input`) { answered.push(route.request().postDataJSON()); return route.fulfill({ json: { ok: true } }); }
		if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread } });
		return route.fulfill({ json: {} });
	});
	await page.goto(`/s/${ID}?host=claude`);
	const panel = page.getByRole('region', { name: /has a question/ });
	await expect(panel).toContainText('Which auth method do you want?');
	await panel.getByRole('button', { name: /API Key/ }).click();
	await expect(panel).toContainText('Who should it cover?');
	expect(answered).toHaveLength(0);
	await panel.getByLabel('Other').fill('Admins and auditors');
	await panel.getByLabel('Other').press('Enter');
	await expect.poll(() => answered.length).toBe(1);
	expect(answered[0]).toEqual({ itemId: 'ask-1', answers: { q0: { answers: ['API Key'] }, q1: { answers: ['Admins and auditors'] } } });
	expect(sent).toHaveLength(0);
	await expect(panel).toHaveCount(0);
});
