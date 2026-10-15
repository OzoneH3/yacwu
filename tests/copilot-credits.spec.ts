import { expect, test, type Page } from '@playwright/test';

async function mock(page: Page, running = false, recorded = true, model = 'copilot/gpt-6-luna', account: unknown = null) {
 const id = 'credit-task';
 const thread = { id, name: 'Credit task', cwd: '/project', host: 'copilot', status: { type: running ? 'active' : 'idle' }, turns: [{ id: 'turn1', status: running ? 'inProgress' : 'completed', items: [
  { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'Do the task' }] },
  { type: 'agentMessage', id: 'a1', phase: 'final', text: 'Task complete.' }
 ] }] };
 const base = { host: 'copilot', threadId: id, turnId: 'turn1' };
 const events = [
  { ...base, at: 1000, event: 'newThread' },
  { ...base, at: 1001, event: 'metadata', model, effort: 'medium' },
  { ...base, at: 1002, event: 'turn/started' },
  ...(recorded ? [{ ...base, at: 1003, event: 'tokens', total: { inputTokens: 100000, cachedInputTokens: 80000, outputTokens: 10000, reasoningOutputTokens: 5000, totalTokens: 110000 } }] : []),
  ...(!running ? [{ ...base, at: 1004, event: 'turn/completed', status: 'completed' }] : [])
 ];
 await page.route('**/api/**', async route => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/api/events') return route.fulfill({ contentType: 'text/event-stream', body: ': connected\n\n' });
  if (path === '/api/hosts') return route.fulfill({ json: { hosts: [{ name: 'local', kind: 'local', provider: 'codex', state: 'connected' }, { name: 'copilot', kind: 'backend', provider: 'copilot', state: 'connected' }] } });
  if (path === '/api/threads') return route.fulfill({ json: { data: [thread], defaultCwd: '/project' } });
  if (path === '/api/threads/loaded') return route.fulfill({ json: { data: [id] } });
  if (path === '/api/account') return route.fulfill({ json: { rateLimits: { copilotUsage: account } } });
  if (path === '/api/usage') return route.fulfill({ json: { events } });
  if (path.endsWith('/model')) return route.fulfill({ json: { model, effort: 'medium', models: [{ id: model, displayName: 'GPT-6 Luna', efforts: ['medium'], defaultEffort: 'medium' }] } });
  if (path === `/api/threads/${id}` || path.endsWith('/open')) return route.fulfill({ json: { thread } });
  return route.fulfill({ json: {} });
 });
 await page.goto(`/s/${id}`);
}

test('finished Copilot tasks and their history show estimated credits without dollar or learned allowance UI', async ({ page }) => {
 await mock(page);
 await expect(page.locator('.agent-usage')).toHaveText('Est. 0.78–0.83 credits used');
 await expect(page.getByText('Account allowance unavailable', { exact: true })).toBeVisible();
 await page.getByRole('button', { name: 'Task credits', exact: true }).click();
 const dialog = page.getByRole('dialog', { name: 'Copilot task credits' });
 await expect(dialog.getByRole('cell', { name: 'Est. 0.78–0.83 credits used', exact: true })).toBeVisible();
 await expect(dialog).not.toContainText('$');
 await expect(dialog).not.toContainText('Learning');
 await expect(dialog.getByRole('button', { name: /Benchmark/ })).toHaveCount(0);
 await page.getByRole('button', { name: 'Close credit history' }).click();
 await page.reload();
 await expect(page.locator('.agent-usage')).toHaveText('Est. 0.78–0.83 credits used');
});

test('running Copilot tasks show credits consumed so far instead of cost learning', async ({ page }) => {
 await mock(page, true);
 await expect(page.locator('.session-progress .task-cost')).toHaveText('Est. 0.78–0.83 credits used');
 await expect(page.locator('.session-progress')).not.toContainText('Cost learning');
});

test('missing tokens and unknown models show unavailable estimates rather than zero credits', async ({ page }) => {
 await mock(page, false, false);
 await page.getByRole('button', { name: 'Task credits', exact: true }).click();
 await expect(page.getByRole('dialog').getByRole('cell', { name: 'Credit estimate unavailable', exact: true })).toBeVisible();
});


test('gh account credits include the account identity and no invented finite allowance', async ({ page }) => {
 await mock(page, false, true, 'copilot/gpt-6-luna', { login: 'tester', used: 1913, max: null, unlimited: true, resetAt: '2026-11-01' });
 await expect(page.getByText('GitHub @tester · 1,913 credits used · no reported cap', { exact: true })).toBeVisible({ timeout: 5000 });
 await page.getByRole('button', { name: 'Task credits', exact: true }).click();
 await expect(page.getByRole('dialog')).toContainText('GitHub @tester · 1,913 credits used · no reported cap');
 await expect(page.getByRole('dialog')).not.toContainText('$');
});

test('live Copilot context stays separate from cumulative tokens and supports compaction and zero', async ({ page }) => {
 await page.addInitScript(() => {
  const w = window as any;
  class FakeEventSource {
   onopen: any = null; onmessage: any = null; onerror: any = null; readyState = 1;
   constructor(public url: string) { w.__sse = this; setTimeout(() => this.onopen?.({}), 0); }
   addEventListener() {} close() {}
  }
  w.EventSource = FakeEventSource;
  w.__emit = (msg: unknown) => w.__sse?.onmessage?.({ data: JSON.stringify(msg) });
 });
 await mock(page, true);
 const emit = (method: string, params: any) => page.evaluate(m => (window as any).__emit(m), { method, params: { threadId: 'credit-task', ...params } });
 await expect(page.locator('.composer')).toBeVisible();
 await emit('yacwu/contextUsage/updated', { used: 53000, size: 200000 });
 await expect(page.locator('.fact.tokens')).toHaveText('53k tok', { timeout: 5000 });
 await expect(page.locator('.fact.tokens')).toHaveAttribute('data-yacwu-tooltip', '53,000 / 200,000 tokens in context');
 await emit('thread/tokenUsage/updated', { tokenUsage: { total: { totalTokens: 500000, inputTokens: 400000, cachedInputTokens: 100000, outputTokens: 100000 }, last: { totalTokens: 110000 }, modelContextWindow: null } });
 await expect(page.locator('.fact.tokens')).toHaveText('53k tok');
 await emit('yacwu/contextUsage/updated', { used: 20000, size: 200000 });
 await expect(page.locator('.fact.tokens')).toHaveText('20k tok');
 await emit('yacwu/contextUsage/updated', { used: null, size: 200000 });
 await expect(page.locator('.fact.tokens')).toHaveText('20k tok');
 await emit('yacwu/contextUsage/updated', { used: 0, size: 200000 });
 await expect(page.locator('.fact.tokens')).toHaveText('0 tok');
});
