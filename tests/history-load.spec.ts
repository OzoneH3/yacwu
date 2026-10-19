import { expect, test } from '@playwright/test';

test('opening a long history visits transcript order linearly', async ({ page }) => {
 const count = 2000;
 const turns = Array.from({ length: 500 }, (_, t) => ({ id: `turn-${t}`, status: 'completed', items:
  Array.from({ length: 4 }, (_, j) => ({ id: `history-item-${t * 4 + j}`, type: 'agentMessage', text: t * 4 + j === count - 1 ? 'History is ready' : 'Earlier response.' }))
 }));
 const thread = { id: 'history-session', name: 'Long history', cwd: '/project', host: 'local', status: { type: 'idle' }, turns };
 await page.addInitScript(() => {
  (window as any).__orderVisits = 0;
  const iterator = Array.prototype[Symbol.iterator];
  Array.prototype[Symbol.iterator] = function() {
   if (this[0] === 'history-item-0') (window as any).__orderVisits += this.length;
   return iterator.call(this);
  };
 });
 await page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (path === '/api/threads') return route.fulfill({ json: { data: [{ ...thread, turns: [] }], defaultCwd: '/project' } });
  if (path === '/api/threads/loaded') return route.fulfill({ json: { data: ['history-session'] } });
  if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
  if (path.endsWith('/open')) return route.fulfill({ json: { thread } });
  return route.fulfill({ json: {} });
 });
 await page.goto('/s/history-session');
 await expect(page.getByText('History is ready', { exact: true })).toBeVisible();
 expect(await page.evaluate(() => (window as any).__orderVisits)).toBeLessThan(count * 30);
});
