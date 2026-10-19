import { expect, test, type Page } from '@playwright/test';

async function mockAccess(page: Page, provider = 'codex', running = false) {
 const modeById: Record<string, string> = { existing: 'read-write' };
 const created: any[] = []; let next = 0;
 const host = provider === 'codex' ? 'local' : provider;
 const thread = (id = 'existing') => ({ id, name: 'Access test', host, cwd: '/workspace', status: { type: running ? 'active' : 'idle' }, turns: [] });
 await page.route('**/api/**', async route => {
  const url = new URL(route.request().url()), path = url.pathname; let data: object = {};
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (path === '/api/hosts') data = { hosts: [{ name: 'local', provider: 'codex', kind: 'local', state: 'connected' }, ...(provider === 'codex' ? [] : [{ name: host, provider, kind: 'backend', state: 'connected' }])] };
  else if (path === '/api/threads') {
   if (route.request().method() === 'POST') {
    const body = route.request().postDataJSON(); created.push(body); const id = `new-${++next}`; modeById[id] = body.fileAccess; data = { host: 'local', thread: thread(id) };
   } else data = { data: [thread()] };
  } else if (path === '/api/threads/loaded') data = { data: [] };
  else if (path.endsWith('/file-access')) {
   const id = path.split('/')[3];
   if (route.request().method() === 'POST') modeById[id] = route.request().postDataJSON().mode;
   data = { mode: modeById[id] ?? 'read-write', readOnlySupported: provider === 'codex' };
  } else if (path.endsWith('/model')) data = { model: 'test', effort: 'medium', models: [] };
  else if (path.startsWith('/api/threads/')) data = { thread: thread(path.split('/')[3]) };
  await route.fulfill({ json: data });
 });
 await page.goto('/s/existing');
 return { created, modeById };
}

test('default access survives reload, creation can override it, and details persist a session choice', async ({ page }) => {
 const { created, modeById } = await mockAccess(page);
 await page.getByRole('button', { name: 'Settings', exact: true }).click();
 await page.getByLabel('Default file access', { exact: true }).selectOption('read-only');
 await page.getByRole('button', { name: 'Close settings' }).click();
 await page.reload();
 await page.getByRole('button', { name: /^Session details,/ }).click();
 const details = page.getByRole('dialog', { name: 'Session details' });
 await expect(details.getByLabel('File access', { exact: true })).toHaveValue('read-write');
 await details.getByLabel('File access', { exact: true }).selectOption('read-only');
 await expect.poll(() => modeById.existing).toBe('read-only');
 await details.getByRole('button', { name: 'Close session details' }).click();
 await expect(page.getByLabel('Read-only session', { exact: true })).toBeVisible();
 await page.reload();
 await expect(page.getByLabel('Read-only session', { exact: true })).toBeVisible();
 await page.getByRole('button', { name: 'New session', exact: true }).click();
 await expect(page.getByRole('group', { name: 'Start a session', exact: true }).getByLabel('File access', { exact: true })).toHaveValue('read-only');
 await page.getByRole('group', { name: 'Start a session', exact: true }).getByLabel('File access', { exact: true }).selectOption('read-write');
 await page.getByRole('button', { name: 'Start session', exact: true }).click();
 await expect.poll(() => created.length).toBe(1); expect(created[0].fileAccess).toBe('read-write');
 await page.getByRole('button', { name: 'New session', exact: true }).click();
 await expect(page.getByRole('group', { name: 'Start a session', exact: true }).getByLabel('File access', { exact: true })).toHaveValue('read-only');
 await page.getByRole('button', { name: 'Start session', exact: true }).click();
 await expect.poll(() => created.length).toBe(2); expect(created[1].fileAccess).toBe('read-only');
});

test('access changes are unavailable during a running turn', async ({ page }) => {
 await mockAccess(page, 'codex', true);
 await page.getByRole('button', { name: /^Session details,/ }).click();
 await expect(page.getByRole('dialog', { name: 'Session details' }).getByLabel('File access', { exact: true })).toBeDisabled();
});

test('unsupported providers explain why read-only access is unavailable', async ({ page }) => {
 await mockAccess(page, 'claude');
 await page.getByRole('button', { name: /^Session details,/ }).click();
 const details = page.getByRole('dialog', { name: 'Session details' });
 await expect(details.getByLabel('File access', { exact: true })).toBeEnabled();
 await expect(details.locator('option[value="read-only"]')).toBeDisabled();
 await expect(details).toContainText('Enforced read-only access is currently available for Codex.');
});

test('real API persists access, rejects unsandboxed shortcuts and file saves, and lets idle sessions change access', async ({ request }) => {
 const response = await request.post('/api/threads', { data: { cwd: process.cwd(), fileAccess: 'read-only' } });
 expect(response.ok(), await response.text()).toBe(true);
 const { thread } = await response.json(); const base = `/api/threads/${thread.id}`;
 expect(await (await request.get(`${base}/file-access`)).json()).toMatchObject({ mode: 'read-only', readOnlySupported: true });
 const shell = await request.post(`${base}/shell`, { data: { command: 'echo forbidden' } });
 expect(shell.ok()).toBe(false); expect((await shell.json()).error).toContain('read-only');
 const save = await request.put(`${base}/file?path=forbidden.txt`, { data: { content: 'forbidden' } });
 expect(save.status()).toBe(403);
 const change = await request.post(`${base}/file-access`, { data: { mode: 'read-write' } });
 expect(change.ok(), await change.text()).toBe(true);
 expect(await (await request.get(`${base}/file-access`)).json()).toMatchObject({ mode: 'read-write' });
 const invalid = await request.post(`${base}/file-access`, { data: { mode: 'invalid' } });
 expect(invalid.ok()).toBe(false);
 expect(await (await request.get(`${base}/file-access`)).json()).toMatchObject({ mode: 'read-write' });
 await request.post(`${base}/file-access`, { data: { mode: 'read-only' } });
 const replacement = await request.post('/api/threads', { data: { cwd: process.cwd(), inheritAccessFrom: thread.id, fileAccess: 'read-write' } });
 expect(replacement.ok(), await replacement.text()).toBe(true);
 const child = await replacement.json();
 expect(await (await request.get(`/api/threads/${child.thread.id}/file-access`)).json()).toMatchObject({ mode: 'read-only' });
});


test('a rejected access change keeps the saved choice visible', async ({ page }) => {
 await mockAccess(page);
 await page.route('**/api/threads/*/file-access', async route => {
  if (route.request().method() === 'POST') return route.fulfill({ status: 409, json: { error: 'Access change rejected' } });
  return route.fallback();
 });
 await page.getByRole('button', { name: /^Session details,/ }).click();
 const details = page.getByRole('dialog', { name: 'Session details' });
 const select = details.getByLabel('File access', { exact: true });
 await expect(select).toBeEnabled();
 await select.selectOption('read-only');
 await expect(details.getByRole('alert')).toHaveText('Access change rejected');
 await expect(select).toHaveValue('read-write');
 await expect(page.getByLabel('Read-only session', { exact: true })).toHaveCount(0);
});
