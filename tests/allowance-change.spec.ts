import { expect, test } from '@playwright/test';

test('doubled Codex allowance updates learned costs without rewriting account readings', async ({ page }) => {
 const at = Date.parse('2026-10-28T12:00:00Z');
 const id = 'doubled-allowance';
 const event = (offset: number, kind: string, extra: object = {}) => ({ at: at + offset, host: 'local', event: kind, ...extra });
 const quota = (offset: number, usedPercent: number) => event(offset, 'quota', { usedPercent, resetsAt: 1794000000, limitId: 'codex', planType: 'prolite' });
 const events = [event(0, 'newThread', { threadId: id }), event(1, 'metadata', { threadId: id, model: 'gpt-6-luna', effort: 'high' }), quota(2, 10),
  event(3, 'turn/started', { threadId: id, turnId: 't' }), event(4, 'tokens', { threadId: id, turnId: 't', total: { totalTokens: 100000, inputTokens: 100000 }, last: { totalTokens: 100000, inputTokens: 100000 } }),
  event(5, 'turn/completed', { threadId: id, turnId: 't' }), quota(60005, 14), quota(120005, 14)];
 const thread = { id, host: 'local', cwd: '/project', status: { type: 'idle' }, turns: [] };
 await page.context().route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  let data: object = {};
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (path === '/api/threads') data = { data: [thread] };
  else if (path === '/api/threads/loaded') data = { data: [] };
  else if (path === '/api/usage') data = { events, reset: true, cursor: 'sample' };
  else if (path === '/api/account') data = { rateLimits: { primary: { usedPercent: 58, windowDurationMins: 10080, resetsAt: 1794000000 } } };
  else if (path.endsWith('/model')) data = { model: 'gpt-6-luna', effort: 'high', models: [] };
  else if (path.startsWith('/api/threads/')) data = { thread };
  await route.fulfill({ json: data });
 });
 await page.goto(`/s/${id}`);
 await expect(page.locator('.usage-limits')).toContainText('42%');
 await page.locator('.usage-limits .usage-details').click();
 const dialog = page.getByRole('dialog', { name: 'Task allowance usage' });
 await expect(dialog.locator('.allowance-adjustment')).toContainText('half their old percentage cost');
 await expect(dialog.locator('table').first()).toContainText('~20.00%');
 await expect(dialog.locator('.pool').first()).toContainText('4% account change');
 await expect(dialog.locator('.pool-rate').first()).toContainText('~20.00%');
 await page.reload();
 await page.locator('.usage-limits .usage-details').click();
 await expect(page.getByRole('dialog', { name: 'Task allowance usage' }).locator('table').first()).toContainText('~20.00%');
});
