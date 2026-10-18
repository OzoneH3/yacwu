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

test('reloading restores the journal cursor and requests only a delta', async ({ page }) => {
 const cursors: (string | null)[] = [];
 const thread = { id: 'cache-session', host: 'local', cwd: '/workspace', status: { type: 'idle' }, turns: [] };
 await page.context().route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (url.pathname === '/api/hosts') return route.fulfill({ json: { hosts: [{ name: 'local', label: 'Local', state: 'connected', kind: 'local' }] } });
  if (url.pathname === '/api/usage') {
   cursors.push(url.searchParams.get('cursor'));
   return route.fulfill({ json: { cursor: 'persisted', reset: !url.searchParams.has('cursor'), events: [] } });
  }
  if (url.pathname === '/api/threads') return route.fulfill({ json: { data: [thread] } });
  if (url.pathname.startsWith('/api/threads/')) return route.fulfill({ json: { thread, data: [], models: [] } });
  return route.fulfill({ json: { data: [], models: [] } });
 });
 await page.goto('/s/cache-session');
 await expect.poll(() => cursors.length).toBeGreaterThan(0);
 // Wait for the atomic cache transaction before destroying the worker.
 await expect.poll(() => page.evaluate(async () => {
  return new Promise(resolve => {
   const request = indexedDB.open('yacwu-usage-journal');
   request.onsuccess = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('meta')) { db.close(); resolve(null); return; }
    const tx = db.transaction('meta'); const get = tx.objectStore('meta').get('cursor');
    tx.oncomplete = () => { db.close(); resolve(get.result); };
   };
  });
 })).toBe('persisted');
 cursors.length = 0;
 await page.reload();
 await expect.poll(() => cursors.length).toBeGreaterThan(0);
 expect(cursors[0]).toBe('persisted');
});

test('hidden tabs pause usage polling but keep bounded runtime recovery and refresh when shown', async ({ page }) => {
 const ids = Array.from({ length: 12 }, (_, i) => `poll-session-${i}`);
 let usageReads = 0, runtimeReads = 0, activeReads = 0, peakReads = 0;
 const thread = (id: string) => ({ id, host: 'local', name: id, cwd: '/workspace', status: { type: 'active' }, turns: [{ id: `turn-${id}`, status: 'inProgress', items: [] }] });
 await page.addInitScript(ids => {
  localStorage.setItem('yacwu-running-tasks', JSON.stringify(Object.fromEntries(ids.map(id => [id, id]))));
  let visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  (window as any).setTestVisibility = (value: string) => { visibility = value; document.dispatchEvent(new Event('visibilitychange')); };
  (window as any).usageReplies = [];
  const OriginalWorker = window.Worker;
  window.Worker = class extends OriginalWorker {
   constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options);
    this.addEventListener('message', event => { (window as any).usageReplies.push({ unchanged: event.data.unchanged, hasResult: Boolean(event.data.result) }); });
   }
  };
 }, ids);
 await page.clock.install();
 await page.context().route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (url.pathname === '/api/hosts') return route.fulfill({ json: { hosts: [{ name: 'local', state: 'connected', kind: 'local' }] } });
  if (url.pathname === '/api/usage') {
   usageReads++;
   return route.fulfill({ json: { cursor: 'stable', reset: usageReads === 1, events: [] } });
  }
  if (url.pathname.endsWith('/runtime')) {
   runtimeReads++; peakReads = Math.max(peakReads, ++activeReads);
   await new Promise(resolve => setTimeout(resolve, 30));
   await route.fulfill({ json: { thread: thread(url.pathname.split('/')[3]) } }); activeReads--; return;
  }
  if (url.pathname === '/api/threads') return route.fulfill({ json: { data: ids.map(thread) } });
  if (url.pathname.endsWith('/model')) return route.fulfill({ json: { model: 'gpt-6-luna', effort: 'medium', models: [] } });
  if (url.pathname.startsWith('/api/threads/')) return route.fulfill({ json: { thread: thread(url.pathname.split('/')[3]), data: [] } });
  return route.fulfill({ json: {} });
 });
 await page.goto(`/s/${ids[0]}`);
 await expect.poll(() => runtimeReads, { timeout: 5000 }).toBeGreaterThanOrEqual(ids.length);
 expect(peakReads).toBeLessThanOrEqual(4);
 await expect.poll(() => usageReads, { timeout: 5000 }).toBeGreaterThan(0);
 await expect.poll(() => page.evaluate(() => (window as any).usageReplies.length), { timeout: 5000 }).toBeGreaterThan(0);
 await page.evaluate(() => (window as any).setTestVisibility('hidden'));
 const usageBefore = usageReads, runtimeBefore = runtimeReads;
 await page.clock.fastForward(61000);
 await expect.poll(() => runtimeReads, { timeout: 5000 }).toBeGreaterThan(runtimeBefore);
 expect(usageReads).toBe(usageBefore);
 await page.evaluate(() => (window as any).setTestVisibility('visible'));
 await expect.poll(() => usageReads, { timeout: 5000 }).toBeGreaterThan(usageBefore);
 await expect.poll(() => page.evaluate(() => (window as any).usageReplies.some((reply: any) => reply.unchanged && !reply.hasResult)), { timeout: 5000 }).toBe(true);
 expect(peakReads).toBeLessThanOrEqual(4);
});
