import { expect, test } from 'bun:test';
import { readWorkspaceLink, workspacePathUrl } from '../../src/lib/workspace-links';

test('directory links show a listing when the file endpoint rejects the existing folder', async () => {
	const urls: string[] = [];
	const fetcher = (async (url: string) => {
		urls.push(url);
		return url.includes('/files?') ? Response.json({ entries: [{ name: 'right.stl', kind: 'file' }, { name: 'nested', kind: 'dir' }] }) : Response.json({ error: 'file not found' }, { status: 404 });
	});
	const result = await readWorkspaceLink('thread', 'CellarExhaust/ShortHousingVariant/exports', 'remote', fetcher);
	expect(result.directory).toBe(true);
	expect(result.copyable).toBe(true);
	expect(result.content).toBe('[Directory]\nright.stl\nnested/');
	expect(urls).toHaveLength(2);
	for (const url of urls) {
		const query = new URL(url, 'http://localhost').searchParams;
		expect(query.get('path')).toBe('CellarExhaust/ShortHousingVariant/exports');
		expect(query.get('host')).toBe('remote');
	}
});

test('missing targets retain the original file error instead of pretending to be directories', async () => {
	const fetcher = async () => Response.json({ error: 'file not found' }, { status: 404 });
	await expect(readWorkspaceLink('thread', 'missing.txt', undefined, fetcher)).rejects.toThrow('file not found');
});

test('root folder links go directly to a listing; file contents and binary copy restrictions remain intact', async () => {
	const urls: string[] = [];
	const root = await readWorkspaceLink('thread', '', undefined, async (url: string) => { urls.push(url); return Response.json({ entries: [] }); });
	expect(root.content).toBe('[Directory]\n(empty)');
	expect(urls).toEqual([workspacePathUrl('thread', 'files', '')]);
	const binary = await readWorkspaceLink('thread', 'part.stl', undefined, async () => Response.json({ binary: true }));
	expect(binary.copyable).toBe(false);
	const text = await readWorkspaceLink('thread', 'notes.txt', undefined, async () => Response.json({ content: 'hello' }));
	expect(text.content).toBe('hello');
	expect(text.directory).toBe(false);
});
