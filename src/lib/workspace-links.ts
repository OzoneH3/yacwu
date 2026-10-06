import { isRemoteHost } from './protocol';

export function workspacePathUrl(threadId: string, endpoint: 'file' | 'files', path: string, host?: string, root?: string): string {
	const query = new URLSearchParams({ path });
	if (isRemoteHost(host)) query.set('host', host!);
	if (root) query.set('root', root);
	return `/api/threads/${encodeURIComponent(threadId)}/${endpoint}?${query}`;
}

/** Directory links have a listing, not file contents. Keep the original file error for missing targets. */
export async function readWorkspaceLink(threadId: string, path: string, host?: string, fetcher: (url: string) => Promise<Response> = fetch, root?: string): Promise<{ content: string; copyable: boolean; directory: boolean }> {
	let fileError = 'Could not load workspace path';
	if (path) {
		const response = await fetcher(workspacePathUrl(threadId, 'file', path, host, root));
		const data = await response.json();
		if (response.ok) {
			return { content: data.binary ? '[Binary file]' : data.tooLarge ? '[File is too large to preview]' : String(data.content ?? ''), copyable: !data.binary && !data.tooLarge, directory: false };
		}
		fileError = data.error ?? fileError;
	}
	const response = await fetcher(workspacePathUrl(threadId, 'files', path, host, root));
	const data = await response.json();
	if (!response.ok) throw new Error(fileError);
	const entries = Array.isArray(data.entries) ? data.entries : [];
	const listing = entries.map((entry: { name: string; kind: string }) => `${entry.name}${entry.kind === 'dir' ? '/' : ''}`).join('\n');
	return { content: `[Directory]\n${listing || '(empty)'}`, copyable: true, directory: true };
}
