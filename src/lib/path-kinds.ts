import { isRemoteHost } from './protocol';

export type PathKind = 'dir' | 'file' | 'missing';

interface Lookup { threadId: string; host: string; root: string | null; path: string }

export function pathKindKey(threadId: string, host: string, root: string | null, path: string): string {
	return JSON.stringify([threadId, host, root ?? '', path]);
}

/**
 * Collect path lookups made while a transcript renders and ask the server
 * once per session/root batch. Each path is requested at most once; a failed
 * request leaves its paths unknown (shown as file links).
 */
export function createPathKindQueue(
	fetcher: (url: string, init: RequestInit) => Promise<Response>,
	resolved: (key: string, kind: PathKind) => void,
	delayMs = 30
) {
	const requested = new Set<string>();
	let queued: Lookup[] = [];
	let timer: ReturnType<typeof setTimeout> | null = null;

	async function ask(group: Lookup[]) {
		const { threadId, host, root } = group[0];
		const query = new URLSearchParams();
		if (root) query.set('root', root);
		if (isRemoteHost(host)) query.set('host', host);
		try {
			const response = await fetcher(`/api/threads/${encodeURIComponent(threadId)}/path-kinds?${query}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ paths: group.map((lookup) => lookup.path) })
			});
			if (!response.ok) return;
			const kinds = (await response.json()).kinds ?? {};
			for (const lookup of group) {
				const kind = kinds[lookup.path];
				if (kind === 'dir' || kind === 'file' || kind === 'missing') resolved(pathKindKey(threadId, host, root, lookup.path), kind);
			}
		} catch {
			/* Unknown kinds keep their file links. */
		}
	}

	function flush() {
		timer = null;
		const groups = new Map<string, Lookup[]>();
		for (const lookup of queued) {
			const group = JSON.stringify([lookup.threadId, lookup.host, lookup.root ?? '']);
			groups.set(group, [...(groups.get(group) ?? []), lookup]);
		}
		queued = [];
		for (const group of groups.values()) void ask(group);
	}

	return {
		/** Queue a lookup; safe to call while rendering (no reactive writes). */
		request(threadId: string, host: string, root: string | null, path: string) {
			const key = pathKindKey(threadId, host, root, path);
			if (requested.has(key)) return;
			requested.add(key);
			queued.push({ threadId, host, root, path });
			timer ??= setTimeout(flush, delayMs);
		}
	};
}
