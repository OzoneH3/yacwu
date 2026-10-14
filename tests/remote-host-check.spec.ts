import { expect, test } from '@playwright/test';

// Picking a remote machine for a new session checks it right away and says
// what happened, including what to do when Codex is missing there.

test('a remote machine that lacks Codex says so under the picker', async ({ page }) => {
	await page.route('**/api/**', async (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
		if (path === '/api/hosts') return route.fulfill({ json: { hosts: [{ name: 'local', kind: 'local', provider: 'codex', state: 'connected' }, { name: 'pi', kind: 'remote', provider: 'codex', state: 'disconnected' }, { name: 'box', kind: 'remote', provider: 'codex', state: 'disconnected' }] } });
		if (path === '/api/threads') {
			const host = url.searchParams.get('host');
			if (host === 'pi') return route.fulfill({ status: 502, json: { error: 'pi: codex not found on the remote PATH' } });
			return route.fulfill({ json: { data: [], defaultCwd: host === 'box' ? '/home/me' : '/tmp' } });
		}
		return route.fulfill({ json: {} });
	});
	await page.goto('/');
	await page.getByRole('button', { name: 'New session' }).click();
	const machine = page.locator('#new-host');
	await machine.selectOption('pi');
	const status = page.locator('.host-check');
	await expect(status).toContainText("Codex isn't installed there");
	await expect(status).toContainText('npm install -g @openai/codex');
	await machine.selectOption('box');
	await expect(status).toHaveText('Connected to box.');
});
