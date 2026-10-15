import { LOCAL_HOST, type HostInfo } from './protocol';

/** The configured local backend that runs `provider`, if any. */
export function providerHost(hosts: HostInfo[], provider: string): string | null {
	return hosts.find((host) => host.kind === 'backend' && host.provider === provider)?.name ?? null;
}

export function claudeBackendHost(hosts: HostInfo[]): string | null {
	return providerHost(hosts, 'claude');
}

/** Agents with a backend of their own; other backends count as Codex. */
export const BACKEND_AGENTS = ['claude', 'copilot'];

/** Providers offered besides Codex: the agents of the configured backends. */
export function backendProviders(hosts: HostInfo[]): string[] {
	return BACKEND_AGENTS.filter((provider) => providerHost(hosts, provider));
}

export function providerLabel(provider: string): string {
	return provider === 'claude' ? 'Claude' : provider === 'copilot' ? 'Copilot' : provider === 'codex' ? 'Codex' : provider;
}

/** Alternative providers currently run locally; SSH targets use Codex. */
export function sessionTarget(machine: string, provider: string, hosts: HostInfo[]): string {
	if (machine !== LOCAL_HOST || provider === 'codex') return machine;
	return providerHost(hosts, provider) ?? machine;
}
