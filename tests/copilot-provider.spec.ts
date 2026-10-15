import { expect, test } from '@playwright/test';

// A configured Copilot backend is offered as a provider for new local
// sessions, next to Codex and Claude, and sessions picked with it start there.

test('Copilot is a provider for new sessions and starts them on its backend', async ({ page }) => {
	const created: Array<Record<string, unknown>> = [];
	await page.route('**/api/**', async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/hosts') return route.fulfill({ json: { hosts: [
			{ name: 'local', kind: 'local', provider: 'codex', state: 'connected' },
			{ name: 'claude', kind: 'backend', provider: 'claude', state: 'disconnected' },
			{ name: 'copilot', kind: 'backend', provider: 'copilot', state: 'disconnected' },
			{ name: 'pi', kind: 'remote', provider: 'codex', state: 'disconnected' }
		] } });
		if (path === '/api/threads' && route.request().method() === 'POST') {
			created.push(route.request().postDataJSON());
			return route.fulfill({ status: 500, json: { error: 'stop here' } });
		}
		if (path === '/api/threads') return route.fulfill({ json: { data: [], defaultCwd: '/tmp' } });
		return route.fulfill({ json: {} });
	});
	await page.goto('/');
	await page.getByRole('button', { name: 'New session' }).click();
	const provider = page.locator('#new-provider');
	await expect(provider.locator('option')).toHaveText(['Codex', 'Claude', 'Copilot']);
	await provider.selectOption('copilot');
	await page.getByRole('button', { name: 'Start session' }).click();
	await expect.poll(() => created.at(-1)?.host).toBe('copilot');
	// Copilot, like Claude, runs on this machine only.
	await page.locator('#new-host').selectOption('pi');
	await expect(provider).toHaveValue('codex');
	await expect(provider.locator('option[value="copilot"]')).toBeDisabled();
});
