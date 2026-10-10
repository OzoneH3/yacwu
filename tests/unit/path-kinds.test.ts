import { expect, test } from 'bun:test';
import { createPathKindQueue, pathKindKey, type PathKind } from '../../src/lib/path-kinds';

test('lookups are batched per session and root, deduplicated, and resolved', async () => {
	const requests: Array<{ url: string; paths: string[] }> = [];
	const fetcher = async (url: string, init: RequestInit) => {
		const paths = JSON.parse(String(init.body)).paths as string[];
		requests.push({ url, paths });
		return new Response(JSON.stringify({ kinds: Object.fromEntries(paths.map((path) => [path, path.endsWith('.ts') ? 'file' : 'dir'])) }));
	};
	const resolved: Record<string, PathKind> = {};
	const queue = createPathKindQueue(fetcher, (key, kind) => { resolved[key] = kind; }, 0);
	queue.request('s1', 'local', null, 'src/lib');
	queue.request('s1', 'local', null, 'src/app.ts');
	queue.request('s1', 'local', null, 'src/lib');
	queue.request('s1', 'local', '/etc', 'nginx');
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(requests).toEqual([
		{ url: '/api/threads/s1/path-kinds?', paths: ['src/lib', 'src/app.ts'] },
		{ url: '/api/threads/s1/path-kinds?root=%2Fetc', paths: ['nginx'] }
	]);
	expect(resolved[pathKindKey('s1', 'local', null, 'src/lib')]).toBe('dir');
	expect(resolved[pathKindKey('s1', 'local', null, 'src/app.ts')]).toBe('file');
	// Already requested paths are not asked again.
	queue.request('s1', 'local', null, 'src/lib');
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(requests).toHaveLength(2);
});
