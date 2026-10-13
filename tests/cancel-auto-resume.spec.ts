import { expect, test, type Page } from '@playwright/test';

test.setTimeout(30_000);

async function mock(page: Page, quotaStop = true, fail = false) {
 const interrupts: unknown[] = [], messages: unknown[] = [];
 const note = { type: 'localNote', id: 'quota-stop:limited', text: "Task stopped.\nYou've hit your session limit · resets 1am (Europe/Berlin)", quotaStop, resumeAvailable: true };
 const thread = { id: 'paused', name: 'paused', cwd: '/project', host: 'claude', status: { type: 'idle' }, turns: [{ id: 'limited', status: 'failed', items: [note] }] };
 await page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (path === '/api/hosts') return route.fulfill({ json: { hosts: [{ name: 'local', provider: 'codex', kind: 'local', state: 'connected' }, { name: 'claude', provider: 'claude', kind: 'backend', state: 'connected' }] } });
  if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/project' } });
  if (path === '/api/threads/loaded') return route.fulfill({ json: { data: ['paused'] } });
  if (path.endsWith('/interrupt')) { interrupts.push(route.request().postDataJSON()); return route.fulfill({ status: fail ? 500 : 200, json: fail ? { error: 'Cannot cancel now' } : {} }); }
  if (path.endsWith('/message')) { messages.push(route.request().postDataJSON()); return route.fulfill({ json: { turn: { id: 'resumed', status: 'inProgress', items: [] } } }); }
  if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
  if (path === '/api/threads/paused' || path.endsWith('/open')) return route.fulfill({ json: { thread } });
  return route.fulfill({ json: {} });
 });
 await page.goto('/s/paused');
 await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
 return { interrupts, messages };
}

test('cancel automatic continuation clears the queue and survives reload while preserving manual Resume', async ({ page }) => {
 const { interrupts, messages } = await mock(page);
 const cancel = page.getByRole('button', { name: 'Cancel automatic continuation', exact: true });
 await expect(cancel).toBeVisible({ timeout: 3000 });
 await cancel.click();
 await expect(page.getByText('Automatic continuation cancelled.', { exact: true })).toBeVisible();
 expect(interrupts).toEqual([{ turnId: 'limited' }]);
 expect(messages).toHaveLength(0);
 await expect(cancel).toHaveCount(0);
 await page.reload();
 await expect(page.getByText('Automatic continuation cancelled.', { exact: true })).toBeVisible();
 await expect(cancel).toHaveCount(0);
 await page.getByRole('button', { name: 'Resume', exact: true }).click();
 await expect.poll(() => messages.length).toBe(1);
});

test('a failed cancellation reports the error and keeps the action available', async ({ page }) => {
 await mock(page, true, true);
 const cancel = page.getByRole('button', { name: 'Cancel automatic continuation', exact: true });
 await cancel.click();
 await expect(page.getByText('Cannot cancel now', { exact: true })).toBeVisible();
 await expect(cancel).toBeEnabled();
 await expect(page.getByText('Automatic continuation cancelled.', { exact: true })).toHaveCount(0);
});

test('ordinary manually stopped tasks do not offer automatic cancellation', async ({ page }) => {
 await mock(page, false);
 await expect(page.getByRole('button', { name: 'Cancel automatic continuation', exact: true })).toHaveCount(0);
});
