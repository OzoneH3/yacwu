import { expect, test } from 'bun:test';
import { backendProviders, claudeBackendHost, providerLabel, sessionTarget } from '../../src/lib/session-target';
import type { HostInfo } from '../../src/lib/protocol';

const machines: HostInfo[] = [
	{ name: 'local', kind: 'local', state: 'connected', provider: 'codex' },
	{ name: 'claude', kind: 'remote', state: 'disconnected', provider: 'codex' }
];
const anthropic: HostInfo = { name: 'anthropic', kind: 'backend', provider: 'claude', state: 'connected' };
const gh: HostInfo = { name: 'gh', kind: 'backend', provider: 'copilot', state: 'disconnected' };

test('Provider appears only for a configured Claude backend, including custom backend names', () => {
	expect(claudeBackendHost(machines)).toBeNull();
	expect(claudeBackendHost([...machines, anthropic])).toBe('anthropic');
});

test('every configured backend agent is offered as a provider', () => {
	expect(backendProviders(machines)).toEqual([]);
	expect(backendProviders([...machines, anthropic, gh])).toEqual(['claude', 'copilot']);
	expect(backendProviders([...machines, anthropic, gh]).map(providerLabel)).toEqual(['Claude', 'Copilot']);
});

test('machine and provider map to the existing session routing without selecting a model', () => {
	const hosts = [...machines, anthropic, gh];
	expect(sessionTarget('local', 'codex', hosts)).toBe('local');
	expect(sessionTarget('local', 'claude', hosts)).toBe('anthropic');
	expect(sessionTarget('local', 'copilot', hosts)).toBe('gh');
	expect(sessionTarget('workstation', 'claude', hosts)).toBe('workstation');
	expect(sessionTarget('local', 'claude', machines)).toBe('local');
});
