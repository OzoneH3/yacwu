import { expect, test, type Page } from '@playwright/test';

async function mock(page: Page, running = false, fail = false) {
 const sent: any[] = [];
 const thread = { id: 'copilot-ux', name: 'Copilot UX', cwd: '/project', host: 'gh', status: { type: running ? 'active' : 'idle' }, turns: [{ id: 'turn1', status: running ? 'inProgress' : 'completed', items: [
  { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Review the change' }] },
  { type: 'agentMessage', id: 'a1', text: running ? 'Working.' : 'Should I build it?\n\n- Yes\n- No' }
 ] }] };
 await page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (path === '/api/hosts') return route.fulfill({ json: { hosts: [{ name: 'local', kind: 'local', provider: 'codex' }, { name: 'gh', kind: 'backend', provider: 'copilot' }] } });
  if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/project' } });
  if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [thread.id] } });
  if (path.endsWith('/model')) return route.fulfill({ json: { model: 'copilot/gpt-6-luna', effort: 'medium', models: [{ id: 'copilot/gpt-6-luna', displayName: 'GPT-6 Luna', efforts: ['medium'] }] } });
  if (path.endsWith('/message')) { sent.push(route.request().postDataJSON()); return route.fulfill({ status: fail ? 500 : 200, json: fail ? { error: 'Queue rejected' } : { turn: { id: 'turn1', status: 'inProgress' } } }); }
  if (path === '/api/threads/copilot-ux' || path.endsWith('/open')) return route.fulfill({ json: { thread } });
  return route.fulfill({ json: {} });
 });
 await page.goto('/s/copilot-ux');
 return sent;
}

test('Copilot messages clearly queue for the next prompt without claiming immediate steering', async ({ page }) => {
 const sent = await mock(page, true);
 const composer = page.locator('.composer textarea');
 await expect(composer).toHaveAttribute('placeholder', /Queue.*Copilot/, { timeout: 3000 });
 await composer.fill('Also check the docs');
 await page.getByRole('button', { name: 'Queue next message', exact: true }).click();
 await expect(page.getByText('Message queued for Copilot’s next prompt.', { exact: true })).toBeVisible();
 expect(sent).toHaveLength(1);
 expect(sent[0].turnId).toBe('turn1');
});

test('Copilot names appear in the composer, question dock and coordinator handoff', async ({ page, context }) => {
 await context.grantPermissions(['clipboard-read', 'clipboard-write']);
 await mock(page);
 await expect(page.locator('.composer textarea')).toHaveAttribute('placeholder', 'Message Copilot…');
 await expect(page.getByRole('region', { name: 'Copilot has a question' })).toBeVisible();
 await page.getByRole('button', { name: 'Copy for coordinator', exact: true }).click();
 await expect(page.getByRole('button', { name: 'Handoff copied' })).toBeVisible();
 expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('- Agent: Copilot · copilot/gpt-6-luna, medium');
});

test('a rejected queued message retains its draft and keeps the original task running', async ({ page }) => {
 await mock(page, true, true);
 const composer = page.locator('.composer textarea');
 await composer.fill('Keep this draft');
 await page.getByRole('button', { name: 'Queue next message', exact: true }).click();
 await expect(page.getByText('Queue rejected', { exact: true })).toBeVisible();
 await expect(composer).toHaveValue('Keep this draft');
 await expect(page.getByRole('button', { name: 'Queue next message', exact: true })).toBeEnabled();
 await expect(page.getByText('Message queued for Copilot’s next prompt.', { exact: true })).toHaveCount(0);
});
