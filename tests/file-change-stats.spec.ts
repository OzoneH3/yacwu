import { expect, test } from '@playwright/test';

test('file browser shares normalized line counts with transcript file changes', async ({ page }) => {
 const id = 'file-stats';
 const thread = { id, cwd: '/project', status: { type: 'idle' }, turns: [] };
 await page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  let data: object = {};
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (path === '/api/threads') data = { data: [thread], defaultCwd: '/project' };
  else if (path === '/api/threads/loaded') data = { data: [] };
  else if (path.endsWith('/files')) data = { root: '/project', path: '', entries: [
   { name: 'notes.txt', kind: 'file', size: 8, symlink: false },
   { name: 'binary.dat', kind: 'file', size: 8, symlink: false }
  ] };
  else if (path.endsWith('/git/changes')) data = { available: true, files: [
   { path: './notes.txt', additions: 12, deletions: 3 },
   { path: '/project/binary.dat', additions: null, deletions: null }
  ] };
  else if (path.endsWith('/model')) data = { model: 'test', effort: 'medium', models: [] };
  else if (path.endsWith('/runtime')) data = { status: 'idle' };
  else if (path.startsWith('/api/threads/')) data = { thread };
  await route.fulfill({ json: data });
 });
 await page.goto(`/s/${id}`);
 await page.locator('.files-trigger').click();
 await page.getByRole('tab', { name: 'Files', exact: true }).click();
 await expect(page.locator('.fb-row.file').filter({ hasText: 'notes.txt' }).locator('.fb-change-stats')).toHaveText('+12-3', { timeout: 5000 });
 await expect(page.locator('.fb-row.file').filter({ hasText: 'binary.dat' }).locator('.fb-change-stats')).toHaveText('binary');
});
