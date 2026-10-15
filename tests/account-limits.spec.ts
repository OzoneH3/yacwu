import { expect, test } from '@playwright/test';

test('account usage limits save on the server and survive browser storage being cleared', async ({ page, request }) => {
 await request.post('/api/account/limits', { data: { codexReservePercent: 0, copilotCreditLimit: 0 } });
 await page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/account/limits') return route.continue();
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (path === '/api/threads') return route.fulfill({ json: { data: [], defaultCwd: '/project' } });
  return route.fulfill({ json: {} });
 });
 try {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const codex = page.getByLabel('Codex reserve (% remaining)', { exact: true });
  const copilot = page.getByLabel('Copilot credit limit (used this cycle)', { exact: true });
  await expect(codex).toHaveValue('0', { timeout: 4000 });
  await codex.fill('15'); await copilot.fill('2500');
  await page.getByRole('button', { name: 'Save account limits', exact: true }).click();
  await expect(page.getByText('Account limits saved on the server.', { exact: true })).toBeVisible();
  expect(await (await request.get('/api/account/limits')).json()).toEqual({ codexReservePercent: 15, copilotCreditLimit: 2500 });
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(codex).toHaveValue('15'); await expect(copilot).toHaveValue('2500');
  const invalid = await request.post('/api/account/limits', { data: { codexReservePercent: 110, copilotCreditLimit: -1 } });
  expect(invalid.status()).toBe(400);
  expect(await (await request.get('/api/account/limits')).json()).toEqual({ codexReservePercent: 15, copilotCreditLimit: 2500 });
 } finally {
  await request.post('/api/account/limits', { data: { codexReservePercent: 0, copilotCreditLimit: 0 } });
 }
});

test('account stop notifications explain why a task was interrupted', async ({ page }) => {
 await page.addInitScript(() => {
  const w = window as any;
  class FakeEventSource {
   onopen: any = null; onmessage: any = null; onerror: any = null; readyState = 1;
   constructor(public url: string) { w.__sse = this; setTimeout(() => this.onopen?.({}), 0); }
   addEventListener() {} close() {}
  }
  w.EventSource = FakeEventSource;
 });
 const thread = { id: 'limit-session', cwd: '/project', status: { type: 'active' }, turns: [{ id: 'turn1', status: 'inProgress', items: [] }] };
 await page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/project' } });
  if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [thread.id] } });
  if (path.endsWith('/model')) return route.fulfill({ json: { model: 'gpt-6-luna', models: [], effort: 'medium' } });
  if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread } });
  return route.fulfill({ json: {} });
 });
 await page.goto('/s/limit-session');
 await expect(page.locator('.composer')).toBeVisible();
 await page.evaluate(() => (window as any).__sse.onmessage({ data: JSON.stringify({ method: 'yacwu/accountLimit/stopped', params: { threadId: 'limit-session', reason: 'Codex allowance reserve reached (15% remaining).' } }) }));
 await expect(page.getByText('Task stopped. Codex allowance reserve reached (15% remaining).', { exact: true })).toBeVisible();
});
