import { LOCAL_HOST, type HostInfo } from './protocol';

export function claudeBackendHost(hosts: HostInfo[]): string | null {
	return hosts.find((host) => host.kind === 'backend' && host.provider === 'claude')?.name ?? null;
}

/** Alternative providers currently run locally; SSH targets use Codex. */
export function sessionTarget(machine: string, provider: 'codex' | 'claude', claudeHost: string | null): string {
	return machine === LOCAL_HOST && provider === 'claude' && claudeHost ? claudeHost : machine;
}
