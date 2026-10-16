import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, test } from '@playwright/test';

// Exercise the real HTTP route and installed Codex protocol without a model turn.
test('ephemeral side-chat forks use the paginated protocol without returning parent turns', async ({ request }) => {
 const parentResponse = await request.post('/api/threads', { data: { cwd: process.cwd() } });
 expect(parentResponse.ok()).toBe(true);
 const parent = await parentResponse.json();
 const id = parent.thread.id;
 const path = parent.thread.path;
 // A new thread has no rollout until its first prompt. Seed only the test
 // server's isolated rollout, never an authenticated/live Codex home.
 expect(path, JSON.stringify(parent)).toContain(join(tmpdir(), 'yacwu-e2e-codex-'));
 const now = new Date().toISOString();
 mkdirSync(dirname(path), { recursive: true });
 const items = [
  { type: 'session_meta', payload: { id, session_id: id, timestamp: now, cwd: process.cwd(), originator: 'side-chat-test', cli_version: '0.154.0', source: 'cli', model_provider: 'openai', base_instructions: { text: 'Answer side questions.' }, history_mode: 'paginated' } },
  { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Parent conversation context.' }] } },
  { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Recorded response.' }] } }
 ];
 writeFileSync(path, items.map(item => JSON.stringify({ timestamp: now, ...item })).join('\n') + '\n');
 const response = await request.post(`/api/threads/${parent.thread.id}/fork`, {
  data: { ephemeral: true, developerInstructions: 'Treat inherited history as read-only context.' }
 });
 const result = await response.json();
 expect(response.status(), JSON.stringify(result)).toBe(200);
 expect(result.thread.ephemeral).toBe(true);
 expect(result.thread.id).not.toBe(parent.thread.id);
 expect(result.thread.turns ?? []).toEqual([]);
 const opened = await request.post(`/api/threads/${result.thread.id}/open`, { data: {} });
 expect(opened.status(), await opened.text()).toBe(200);
 await request.post(`/api/threads/${result.thread.id}/unsubscribe`, { data: {} });
 const regular = await request.post(`/api/threads/${parent.thread.id}/fork`, { data: {} });
 const regularResult = await regular.json();
 expect(regular.status(), JSON.stringify(regularResult)).toBe(200);
 expect(regularResult.thread.ephemeral).not.toBe(true);
});
