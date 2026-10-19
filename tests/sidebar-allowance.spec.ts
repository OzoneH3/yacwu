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
