/// <reference types="bun" />
import { describe, expect, test } from 'bun:test';
import { markdownFileReferences, parseCodexMarkdown, isGitRefCode } from '../../src/lib/markdown';

test('collects explicit local Markdown links while excluding plain code paths, web and image references', () => {
	const text = '> **[Review](/tmp/review.md:12)**\n\n- [Results][results]\n\n| File |\n| --- |\n| `docs/notes.md` |\n\n[results]: /tmp/counts.json\n\n[Website](https://example.com/file.md) ![Image](/tmp/photo.png)\n\n```md\n[Example](/tmp/not-a-link.md)\n```';
	expect(markdownFileReferences(text)).toEqual([
		{ text: '/tmp/review.md:12', requireSeparator: false },
		{ text: '/tmp/counts.json', requireSeparator: false }
	]);
});

test('preserves heading depth and inline emphasis without generating HTML', () => {
	const blocks = parseCodexMarkdown('# Result\n\nUse **bold** and `code`.');
	expect(blocks).toEqual([
		{ type: 'heading', depth: 1, children: [{ type: 'text', text: 'Result' }] },
		{
			type: 'paragraph',
			children: [
				{ type: 'text', text: 'Use ' },
				{ type: 'strong', children: [{ type: 'text', text: 'bold' }] },
				{ type: 'text', text: ' and ' },
				{ type: 'code', text: 'code' },
				{ type: 'text', text: '.' }
			]
		}
	]);
});

test('keeps raw HTML inert and rejects executable URLs', () => {
	const blocks = parseCodexMarkdown('<script>alert(1)</script>\n\n[unsafe](javascript:alert(1))');
	expect(blocks[0]).toEqual({
		type: 'paragraph',
		children: [{ type: 'text', text: '<script>alert(1)</script>' }]
	});
	expect(blocks[1]).toMatchObject({
		type: 'paragraph',
		children: [{ type: 'link', href: null, external: false }]
	});
});

test('parses lists, fenced code, and GitHub-flavored tables', () => {
	const blocks = parseCodexMarkdown('- one\n- two\n\n```ts\nconst ok = true;\n```\n\n| File | State |\n| --- | --- |\n| app.ts | changed |');
	expect(blocks.map((block) => block.type)).toEqual(['list', 'code', 'table']);
	expect(blocks[1]).toMatchObject({ type: 'code', language: 'ts', text: 'const ok = true;' });
});

describe('Git refs in code spans are not file links', () => {
	const code = (markdown: string) => {
		const [paragraph] = parseCodexMarkdown(markdown);
		if (paragraph.type !== 'paragraph') throw new Error('expected a paragraph');
		return paragraph.children.filter((token) => token.type === 'code');
	};

	test('a branch named by the surrounding words or a branch prefix', () => {
		expect(code("I'm on branch `ux/page-audit-072`. I'll continue")[0]).toMatchObject({ gitRef: true });
		expect(code('Pushed `topic/login-flow` branch upstream')[0]).toMatchObject({ gitRef: true });
		expect(code('Merged `topic/cleanup` into main')[0]).toMatchObject({ gitRef: true });
		for (const name of ['ux/page-audit-072', 'feature/login', 'fix/null-check', 'release/v1.2.3', 'refs/heads/main', 'codex/relay-mvp']) {
			expect(isGitRefCode(name)).toBe(true);
		}
	});

	test('paths stay paths', () => {
		for (const name of ['src/lib', 'server/test', 'src/lib/markdown.ts', 'docs/relay.md:12', './ux/page', '/home/x/fix/a', 'topic/foo']) {
			expect(isGitRefCode(name)).toBe(false);
		}
		// A file extension wins over branch-like context or prefixes.
		expect(isGitRefCode('docs/relay.md', 'see branch ')).toBe(false);
		expect(isGitRefCode('fix/notes.md')).toBe(false);
		expect(code('Edit `src/lib/markdown.ts` next')[0]).not.toHaveProperty('gitRef');
	});
});
