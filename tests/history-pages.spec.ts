import { expect, test } from '@playwright/test';

test('opens recent history first and retries older pages without losing current messages', async ({ page }) => {
 const latest = { id: 'current', type: 'agentMessage', text: 'Current answer' };
 const thread = { id: 'pages', name: 'Pages', cwd: '/project', host: 'local', status: { type: 'idle' }, turns: [{ id: 'new-turn', status: 'completed', items: [latest] }] };
 let attempts = 0;
 await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), path = url.pathname;
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/project' } });
  if (path === '/api/threads/loaded') return route.fulfill({ json: { data: ['pages'] } });
  if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
  if (path.endsWith('/open')) {
   const recent = route.request().postDataJSON().recent;
   return route.fulfill({ json: { thread, ...(recent ? { historyCursor: 'opaque-page' } : {}) } });
  }
  if (path.endsWith('/history')) {
   expect(url.searchParams.get('cursor')).toBe('opaque-page');
   if (++attempts === 1) return route.fulfill({ status: 502, json: { error: 'Temporary history error' } });
   return route.fulfill({ json: { turns: [{ id: 'old-turn', status: 'completed', items: [
    { id: 'old', type: 'agentMessage', text: 'Earlier answer' },
    { id: 'old-stop', type: 'localNote', text: 'Task stopped.', resumeAvailable: true },
    { ...latest, text: 'Stale overlapping answer' }
   ] }], cursor: null } });
  }
  return route.fulfill({ json: {} });
 });
 await page.goto('/s/pages');
 await expect(page.getByText('Current answer', { exact: true })).toBeVisible();
 await expect(page.getByText('Earlier answer', { exact: true })).toHaveCount(0);
 const earlier = page.getByRole('button', { name: 'Load earlier messages', exact: true });
 await earlier.click();
 await expect(page.getByRole('alert')).toHaveText('Temporary history error');
 await earlier.click();
 await expect(page.getByText('Earlier answer', { exact: true })).toBeVisible();
 await expect(page.getByText('Current answer', { exact: true })).toBeVisible();
 await expect(page.getByText('Stale overlapping answer', { exact: true })).toHaveCount(0);
 await expect(page.getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
 await expect(earlier).toHaveCount(0);
});

test('startup progress for another running Codex session requests recent turns', async ({ page }) => {
 let historyQuery: string | null = null;
 const current = { id: 'front', name: 'Front', cwd: '/project', host: 'local', status: { type: 'idle' }, turns: [] };
 const running = { id: 'worker', name: 'Worker', cwd: '/project', host: 'local', status: { type: 'active' }, turns: [] };
 await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), path = url.pathname;
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (path === '/api/threads') return route.fulfill({ json: { data: [current, running], defaultCwd: '/project' } });
  if (path === '/api/threads/loaded') return route.fulfill({ json: { data: ['front', 'worker'] } });
  if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
  if (path === '/api/threads/worker') { historyQuery = url.searchParams.get('turns'); return route.fulfill({ json: { thread: running } }); }
  if (path.endsWith('/open')) return route.fulfill({ json: { thread: current } });
  return route.fulfill({ json: {} });
 });
 await page.goto('/s/front');
 await expect.poll(() => historyQuery).toBe('recent');
});
