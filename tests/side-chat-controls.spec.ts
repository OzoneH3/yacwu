import { expect, test } from '@playwright/test';

for (const command of ['/btw', '/btw A side question']) {
 test(`${command} focuses the composer and exposes Close beside its parent link`, async ({ page }) => {
  let created = false, closed = false, unsubscribeCalls = 0, archiveCalls = 0;
  const messages: string[] = [];
  const parent = { id: 'parent', name: 'GP DEPLOY', cwd: '/project', status: { type: 'idle' }, turns: [] };
  const side = { ...parent, id: 'side', name: 'Side question', ephemeral: true, forkedFromId: parent.id };
  await page.route('**/api/**', async route => {
   const path = new URL(route.request().url()).pathname;
   let data: object = {};
   if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
   if (path === '/api/hosts') data = { hosts: [{ name: 'local', kind: 'local', provider: 'codex', state: 'connected' }] };
   else if (path === '/api/threads') data = { data: [parent, ...(created && !closed ? [side] : [])] };
   else if (path === '/api/threads/loaded') data = { data: [] };
   else if (path === '/api/threads/parent/fork') { created = true; data = { thread: side, host: 'local' }; }
   else if (path === '/api/threads/side/unsubscribe') { unsubscribeCalls++; closed = true; }
   else if (path.endsWith('/archive')) archiveCalls++;
   else if (path.endsWith('/message')) { messages.push(route.request().postDataJSON().text); data = { turn: { id: 'side-turn' } }; }
   else if (path.endsWith('/model')) data = { model: 'gpt-6-luna', effort: 'medium', models: [] };
   else if (path.startsWith('/api/threads/')) data = { thread: path.split('/')[3] === 'side' ? side : parent };
   await route.fulfill({ json: data });
  });
  await page.goto('/s/parent');
  const composer = page.locator('.composer textarea');
  await composer.fill(command);
  await page.locator('button.send').click();
  await expect(page).toHaveURL(/\/s\/side$/);
  await expect(composer).toBeFocused({ timeout: 3000 });
  await page.keyboard.type('Ready to ask another question');
  await expect(composer).toHaveValue('Ready to ask another question');
  const banner = page.locator('.side-banner');
  await expect(banner.getByRole('button')).toHaveText(['← GP DEPLOY', 'Close']);
  await banner.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page).toHaveURL(/\/s\/parent$/);
  await expect(page.locator('a.session[data-id="side"]')).toHaveCount(0);
  expect(unsubscribeCalls).toBe(1);
  expect(archiveCalls).toBe(0);
  expect(messages).toHaveLength(command === '/btw' ? 0 : 1);
 });
}
