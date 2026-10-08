import { LOCAL_HOST, type HostInfo, type ThreadSummary } from './protocol';

export function archiveProviderLabel(session: ThreadSummary, hosts: HostInfo[]): string {
	const host = session.host || LOCAL_HOST;
	const target = hosts.find((entry) => entry.name === host);
	return target?.provider === 'claude' ? 'Claude' : host === LOCAL_HOST ? 'Codex' : `Codex · ${host}`;
}

export function archiveDeletionSupported(session: ThreadSummary, hosts: HostInfo[]): boolean {
	return !hosts.some((entry) => entry.name === session.host && entry.provider === 'claude');
}

/** Include unopened local providers without connecting disconnected SSH machines. */
export async function loadArchiveCatalog(hosts: HostInfo[], read: (host: string) => Promise<ThreadSummary[]>) {
	const targets = ['', ...hosts.filter((host) => host.kind === 'backend').map((host) => host.name)];
	const results = await Promise.allSettled(targets.map(read));
	const sessions = new Map<string, ThreadSummary>();
	const errors: string[] = [];
	results.forEach((result, index) => {
		const host = targets[index];
		if (result.status === 'rejected') {
			errors.push(`${host || 'Connected machines'}: ${result.reason instanceof Error ? result.reason.message : 'archive unavailable'}`);
			return;
		}
		for (const entry of result.value) {
			if (entry.ephemeral) continue;
			const session = { ...entry, host: host || entry.host || LOCAL_HOST };
			sessions.set(JSON.stringify([session.host, session.id]), session);
		}
	});
	return { sessions: [...sessions.values()].sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt)), errors };
}
