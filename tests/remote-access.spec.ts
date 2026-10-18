import { expect, test } from '@playwright/test';

test('password setup confirms fingerprint, selects the new machine and revokes temporary access', async ({ page }) => {
 const expiry = Date.now() + 3600000;
 const host = 'yacwu-user@server.example';
 let installed = false;
 const requests: any[] = [];
 await page.route('**/api/**', async route => {
  const url = new URL(route.request().url());
  if (url.pathname === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (url.pathname === '/api/hosts') return route.fulfill({ json: { hosts: [{ name: 'local', kind: 'local', state: 'connected' }, ...(installed ? [{ name: host, kind: 'remote', state: 'disconnected', temporaryAccessExpiresAt: expiry }] : [])] } });
  if (url.pathname === '/api/hosts/access') {
   const body = route.request().postDataJSON(); requests.push(body);
   if (!body.confirmedFingerprint) return route.fulfill({ status: 400, json: { confirmationRequired: true, fingerprint: 'SHA256:verified-host', prompt: 'Host identity confirmation' } });
   installed = true; return route.fulfill({ json: { ok: true, host, expiresAt: expiry } });
  }
  if (url.pathname === '/api/hosts/access/revoke') { requests.push(route.request().postDataJSON()); installed = false; return route.fulfill({ json: { ok: true, host } }); }
  if (url.pathname === '/api/threads') return route.fulfill({ json: { data: [], defaultCwd: '/workspace' } });
  return route.fulfill({ json: { data: [], models: [] } });
 });
 await page.goto('/');
 await page.getByRole('button', { name: 'New session' }).click();
 await page.getByRole('button', { name: 'Manage SSH access' }).click({ timeout: 5000 });
 const dialog = page.getByRole('dialog', { name: 'Remote SSH access' });
 await dialog.getByLabel('Host', { exact: true }).fill('server.example');
 await dialog.getByLabel('Username', { exact: true }).fill('user');
 await dialog.getByLabel('Password', { exact: true }).fill('example-password');
 await dialog.getByRole('button', { name: 'Create temporary access' }).click();
 await expect(dialog.getByText('SHA256:verified-host', { exact: true })).toBeVisible();
 await dialog.getByRole('button', { name: 'Trust host and continue' }).click();
 await expect(dialog.getByRole('status')).toContainText('Access created');
 expect(requests[1]).toMatchObject({ password: 'example-password', confirmedFingerprint: 'SHA256:verified-host', hours: 24 });
 await expect(dialog.getByLabel('Password', { exact: true })).toHaveValue('');
 expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('example-password');
 await expect(page.locator('#new-host')).toHaveValue(host);
 await dialog.getByRole('button', { name: 'Remove access', exact: true }).click();
 await expect(dialog.getByRole('status')).toHaveText('SSH key revoked and local copy removed.');
 await expect(page.locator('#new-host')).toHaveValue('local');
 await expect(dialog.getByRole('button', { name: 'Remove access', exact: true })).toHaveCount(0);
});

test('SSH credential endpoints reject foreign origins and validate through the helper', async ({ request, baseURL }) => {
 const foreign = await request.post('/api/hosts/access', { headers: { origin: 'https://foreign.example' }, data: { hostname: '-bad' } });
 expect(foreign.status()).toBe(403);
 const invalid = await request.post('/api/hosts/access', { headers: { origin: baseURL! }, data: { hostname: '-bad', username: 'user', password: 'do-not-echo-this' } });
 expect(invalid.status()).toBe(400);
 expect(await invalid.json()).toEqual({ error: 'Enter a valid hostname and username.' });
});
