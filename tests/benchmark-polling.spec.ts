import { expect, test } from '@playwright/test';

test('idle benchmark polling backs off and pauses in hidden tabs', async ({ page }) => {
 let reads = 0;
 const id = 'benchmark-idle';
 const thread = { id, host: 'local', name: 'Benchmark polling', cwd: '/workspace', status: { type: 'idle' }, turns: [] };
 await page.clock.install();
 await page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  let data: object = {};
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (path === '/api/threads') data = { data: [thread] };
  else if (path === '/api/threads/loaded') data = { data: [] };
  else if (path === '/api/account') data = { rateLimits: { secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: 9999999999 } } };
  else if (path === '/api/usage/benchmark') { reads++; data = { status: 'idle' }; }
  else if (path === '/api/usage') data = { events: [] };
  else if (path.startsWith(`/api/threads/${id}`)) data = { thread };
  await route.fulfill({ json: data });
 });
 await page.goto(`/s/${id}`);
 await page.getByRole('button', { name: '7d 90% left' }).click();
 await expect(page.getByText('Manual calibration benchmark', { exact: true })).toBeVisible();
 await expect.poll(() => reads).toBe(1);
 await page.clock.fastForward(30000); await page.waitForTimeout(100); expect(reads).toBe(1);
 await page.getByText('Manual calibration benchmark', { exact: true }).click();
 await expect.poll(() => reads).toBe(2);
 await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
  document.dispatchEvent(new Event('visibilitychange'));
 });
 await page.clock.fastForward(60000); await page.waitForTimeout(100); expect(reads).toBe(2);
 await page.evaluate(() => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  document.dispatchEvent(new Event('visibilitychange'));
 });
 await expect.poll(() => reads).toBe(3);
});
