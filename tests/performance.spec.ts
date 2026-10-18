import { expect, test } from '@playwright/test';

test('usage runs in a worker and refreshes incrementally; runtime polling avoids full histories', async ({ page }) => {
 const id = 'performance-session';
 const other = 'unseen-running-session';
 const requests: string[] = [];
 const workers: string[] = [];
 const events = Array.from({ length: 150000 }, (_, at) => ({ at, host: 'local', event: 'metadata', threadId: 'old-thread', model: 'gpt-6-luna' }));
 let usageReads = 0;
 page.on('worker', worker => workers.push(worker.url()));
 await page.addInitScript(({ other }) => {
  localStorage.setItem('yacwu-running-tasks', JSON.stringify({ [other]: other }));
 }, { other });
 await page.clock.install();
 await page.context().route('**/api/**', async route => {
  const url = new URL(route.request().url()); requests.push(url.pathname + url.search);
  const path = url.pathname;
  let data: object = {};
  const thread = { id, host: 'local', name: 'Performance session', cwd: '/workspace', status: { type: 'active' }, turns: [{ id: 'turn', status: 'inProgress', items: [] }] };
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (path === '/api/hosts') data = { hosts: [{ name: 'local', label: 'Local', state: 'connected', kind: 'local' }] };
  else if (path === '/api/threads') data = { data: [thread], defaultCwd: '/workspace' };
  else if (path === '/api/threads/loaded') data = { data: [] };
  else if (path === '/api/usage') { usageReads++; data = { cursor: 'after-first-read', reset: usageReads === 1, events: usageReads === 1 ? events : [] }; }
  else if (path.endsWith('/model')) data = { model: 'gpt-6-luna', effort: 'medium', models: [] };
  else if (path.startsWith('/api/threads/')) data = { thread: { ...thread, id: path.split('/')[3] } };
  await route.fulfill({ json: data });
 });
 await page.goto(`/s/${id}`);
 await expect.poll(() => workers.some(url => url.includes('usage-worker')), { timeout: 5000 }).toBe(true);
 await expect.poll(() => usageReads).toBeGreaterThan(0);
 await expect(page.getByRole('button', { name: 'Stop current turn', exact: true })).toBeVisible();
 // Wait for worker analysis to finish, then advance the UI's periodic timers.
 await page.waitForTimeout(1500);
 await page.clock.fastForward(31000);
 await expect.poll(() => usageReads).toBeGreaterThan(1);
 expect(requests.filter(url => url.startsWith('/api/usage')).every(url => url.includes('incremental=1'))).toBe(true);
 expect(requests.some(url => url.startsWith('/api/usage') && url.includes('cursor=after-first-read'))).toBe(true);
 expect(requests.filter(url => url.startsWith(`/api/threads/${other}/runtime`)).length).toBeGreaterThan(0);
 expect(requests.some(url => url.startsWith(`/api/threads/${other}?`) && url.includes('turns=1'))).toBe(false);
});
