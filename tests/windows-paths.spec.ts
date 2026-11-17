import { test, expect } from '@playwright/test';

test('Windows transcript paths with spaces and Unicode open the workspace file', async ({ page }) => {
  const id = 'windows-paths';
  const cwd = 'C:\\Users\\Ada\\My project';
  const thread = { id, name: 'Windows', cwd, host: 'local', status: { type: 'idle' }, turns: [{ id: 't', status: 'completed', items: [
    { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Show files' }] },
    { id: 'a', type: 'agentMessage', text: '[Windows file](<C:/Users/Ada/My project/日本.txt:2>)' }
  ] }] };
  let opened = '';
  await page.route('**/api/**', route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
    if (path === '/api/hosts') return route.fulfill({ json: { hosts: [{ name: 'local', kind: 'local', provider: 'codex', state: 'connected' }], remoteSupported: false } });
    if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: cwd } });
    if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [id] } });
    if (path.endsWith('/model')) return route.fulfill({ json: { model: 'test', effort: 'medium', models: [] } });
    if (path.endsWith('/path-kinds')) return route.fulfill({ json: { kinds: { '日本.txt': 'file' } } });
    if (path.endsWith('/files')) return route.fulfill({ json: { root: cwd, path: '', entries: [{ name: '日本.txt', kind: 'file', size: 6 }] } });
    if (path.endsWith('/file')) { opened = url.searchParams.get('path') ?? ''; return route.fulfill({ json: { content: 'hello\n', size: 6 } }); }
    if (path.startsWith('/api/threads/')) return route.fulfill({ json: { thread } });
    return route.fulfill({ json: {} });
  });
  await page.goto(`/s/${id}`);
  await page.getByRole('button', { name: 'Windows file', exact: true }).click();
  await expect.poll(() => opened).toBe('日本.txt');
});
