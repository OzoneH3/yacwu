import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

test('diagnostics work without loading a Codex thread and allowlist browser observations', async ({ request }) => {
	const path = '/api/threads/thr-diagnostic-smoke/diagnostics';
	const response = await request.get(path);
	expect(response.ok()).toBe(true);
	const snapshot = await response.json();
	expect(snapshot.connection).toBe('disconnected');
	expect(snapshot.osPid).toBeNull();
	expect(snapshot.pending).toEqual([]);
	expect(snapshot.eventLog).toMatch(/codex-\d+\.jsonl$/);

	const rejected = await request.post(path, { data: { event: 'arbitrary-prompt-marker' } });
	expect(rejected.status()).toBe(400);
	const recorded = await request.post(path, {
		data: { event: 'stop_failed', connected: false, visible: true, text: 'private-prompt-marker' }
	});
	expect(recorded.ok()).toBe(true);
	const log = await readFile(snapshot.eventLog, 'utf8');
	expect(log).toContain('stop_failed');
	expect(log).toContain('thr-diagnostic-smoke');
	expect(log).not.toContain('private-prompt-marker');
	expect(log).not.toContain('arbitrary-prompt-marker');
});
