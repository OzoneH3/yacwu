import { expect, test } from 'bun:test';
import { archiveDeletionSupported, archiveProviderLabel, loadArchiveCatalog } from '../../src/lib/archive';
import type { HostInfo, ThreadSummary } from '../../src/lib/protocol';

const hosts: HostInfo[] = [{ name: 'local', kind: 'local', provider: 'codex', state: 'connected' },
	{ name: 'anthropic', kind: 'backend', provider: 'claude', state: 'disconnected' },
	{ name: 'remote', kind: 'remote', provider: 'codex', state: 'disconnected' }];
const thread = (id: string, host: string, updatedAt = 1): ThreadSummary => ({ id, host, name: id, preview: '', createdAt: 1, updatedAt });

test('archives include unopened Claude backends and preserve provider ownership without duplicates', async () => {
	const called: string[] = [];
	const result = await loadArchiveCatalog(hosts, async (host) => {
		called.push(host);
		return host ? [thread('claude-thread', 'wrong-provider', 3)] : [thread('codex-thread', 'local'), thread('claude-thread', 'anthropic', 3)];
	});
	expect(called).toEqual(['', 'anthropic']);
	expect(result.sessions.map((session) => [session.id, session.host])).toEqual([['claude-thread', 'anthropic'], ['codex-thread', 'local']]);
	expect(result.errors).toEqual([]);
});

test('a provider failure keeps the other archives visible and reports the failed source', async () => {
	const result = await loadArchiveCatalog(hosts, async (host) => {
		if (host) throw new Error('Unavailable');
		return [thread('codex', 'local')];
	});
	expect(result.sessions).toHaveLength(1);
	expect(result.errors[0]).toContain('anthropic: Unavailable');
});

test('archive provider labels and deletion availability match the backend capabilities', () => {
	expect(archiveProviderLabel(thread('a', 'anthropic'), hosts)).toBe('Claude');
	expect(archiveDeletionSupported(thread('a', 'anthropic'), hosts)).toBe(false);
	expect(archiveDeletionSupported(thread('a', 'local'), hosts)).toBe(true);
	expect(archiveProviderLabel(thread('a', 'remote'), hosts)).toBe('Codex · remote');
});
