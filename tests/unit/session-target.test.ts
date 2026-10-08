import { expect, test } from 'bun:test';
import { claudeBackendHost, sessionTarget } from '../../src/lib/session-target';
import type { HostInfo } from '../../src/lib/protocol';

test('Provider appears only for a configured Claude backend, including custom backend names', () => {
	const machines: HostInfo[] = [
		{ name: 'local', kind: 'local', state: 'connected', provider: 'codex' },
		{ name: 'claude', kind: 'remote', state: 'disconnected', provider: 'codex' }
	];
	expect(claudeBackendHost(machines)).toBeNull();
	expect(claudeBackendHost([...machines, { name: 'anthropic', kind: 'backend', provider: 'claude', state: 'connected' }])).toBe('anthropic');
});

test('machine and provider map to the existing session routing without selecting a model', () => {
	expect(sessionTarget('local', 'codex', 'anthropic')).toBe('local');
	expect(sessionTarget('local', 'claude', 'anthropic')).toBe('anthropic');
	expect(sessionTarget('workstation', 'claude', 'anthropic')).toBe('workstation');
	expect(sessionTarget('local', 'claude', null)).toBe('local');
});
