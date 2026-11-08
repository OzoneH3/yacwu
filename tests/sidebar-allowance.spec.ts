import { expect, test } from '@playwright/test';

test('reload restores Claude allowance countdowns without opening Claude histories', async ({ page }) => {
 let blocked = true;
 await page.clock.install();
 const accountReads: string[] = []; const claudeHistoryReads: string[] = [];
 const sessions = [
  { id: 'selected', host: 'local', name: 'Selected Codex' },
  { id: 'claude-one', host: 'claude', name: 'Waiting Claude one' },
  { id: 'claude-two', host: 'claude', name: 'Waiting Claude two' }
 ].map(s => ({ ...s, cwd: '/workspace', status: { type: 'idle' }, turns: [] }));
 await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), path = url.pathname;
  let data: object = {};
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (path === '/api/hosts') data = { hosts: [{ name: 'local', provider: 'codex', kind: 'local', state: 'connected' }, { name: 'claude', provider: 'claude', kind: 'backend', state: 'connected' }] };
  else if (path === '/api/threads') data = { data: sessions };
  else if (path === '/api/threads/loaded') data = { data: [] };
  else if (path === '/api/account') {
   const host = url.searchParams.get('host') ?? 'local'; accountReads.push(host);
   data = { rateLimits: host === 'claude' ? { primary: { usedPercent: blocked ? 95 : 20, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 } } : {} };
  } else if (path.startsWith('/api/threads/')) {
   const id = path.split('/')[3];
   if (id.startsWith('claude-') && (path.endsWith('/open') || path === `/api/threads/${id}`)) claudeHistoryReads.push(id);
   data = { thread: sessions.find(s => s.id === id) };
  }
  await route.fulfill({ json: data });
 });
 for (let visit = 0; visit < 2; visit++) {
  accountReads.length = 0;
  if (visit) await page.reload(); else await page.goto('/s/selected');
  for (const id of ['claude-one', 'claude-two']) {
   await expect(page.locator(`[data-session-row-id="${id}"] .run-dot`)).toHaveAttribute('aria-label', /Waiting for allowance · resets in/, { timeout: 5000 });
  }
  expect(accountReads.filter(host => host === 'claude')).toHaveLength(1);
  expect(claudeHistoryReads).toEqual([]);
 }
 blocked = false;
 await page.clock.fastForward(5 * 60 * 1000 + 1);
 for (const id of ['claude-one', 'claude-two']) {
  await expect(page.locator(`[data-session-row-id="${id}"] .run-dot`)).toHaveAttribute('aria-label', 'Idle');
 }
 expect(accountReads.filter(host => host === 'claude')).toHaveLength(2);
 expect(claudeHistoryReads).toEqual([]);
});

test('Claude sign-in state appears on all affected sessions and clears together after recovery', async ({ page }) => {
 let signedOut = true, accountReads = 0;
 const histories: string[] = [];
 const sessions = [
  { id: 'codex', host: 'local', name: 'Codex' },
  { id: 'one', host: 'custom-claude', name: 'Claude one' },
  { id: 'two', host: 'custom-claude', name: 'Claude two' },
  { id: 'side', host: 'custom-claude', name: 'Side', ephemeral: true, forkedFromId: 'one' }
 ].map(s => ({ ...s, cwd: '/workspace', status: { type: 'idle' }, turns: [] }));
 await page.clock.install();
 await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), path = url.pathname;
  let data: any = {};
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (path === '/api/hosts') data = { hosts: [{ name: 'local', provider: 'codex', kind: 'local' }, { name: 'custom-claude', provider: 'claude', kind: 'backend' }] };
  else if (path === '/api/threads') data = { data: sessions };
  else if (path === '/api/threads/loaded') data = { data: [] };
  else if (path === '/api/account') {
   if (url.searchParams.get('host') === 'custom-claude') {
    accountReads++;
    data = signedOut ? { rateLimits: {}, usageError: { code: 'authentication_required' } } : {
     rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: null }, secondary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: null } }
    };
   }
  } else if (path.endsWith('/model')) data = { model: 'opus', effort: 'medium', models: [] };
  else if (path.startsWith('/api/threads/')) {
   const id = path.split('/')[3];
   if (path.endsWith('/open') || path === '/api/threads/' + id) histories.push(id);
   data = { thread: sessions.find(s => s.id === id) };
  }
  await route.fulfill({ json: data });
 });
 await page.goto('/s/codex');
 for (const id of ['one', 'two', 'side']) await expect(page.locator(`a.session[data-id="${id}"]`).getByLabel('Claude sign-in required', { exact: true })).toBeVisible();
 await expect(page.locator('a.session[data-id="codex"] .claude-account-badge')).toHaveCount(0);
 expect(histories.filter(id => id !== 'codex')).toEqual([]);
 expect(accountReads).toBe(1);
 await page.locator('a.session[data-id="one"]').click();
 await expect(page.locator('.claude-account-notice')).toHaveText('Claude sign-in required');
 signedOut = false;
 await page.clock.fastForward(5 * 60 * 1000 + 1);
 await expect(page.locator('.claude-account-badge')).toHaveCount(0);
 await expect(page.locator('.claude-account-notice')).toHaveCount(0);
 await expect(page.getByRole('button', { name: /7d 70% left/ })).toBeVisible();
});
