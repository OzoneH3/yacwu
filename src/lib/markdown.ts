import { marked, type Token, type Tokens } from 'marked';

export type MarkdownInline =
	| { type: 'text'; text: string }
	| { type: 'strong' | 'em' | 'del'; children: MarkdownInline[] }
	/** `gitRef`: names a Git branch, tag or ref, so it is not offered as a file link. */
	| { type: 'code'; text: string; gitRef?: boolean }
	| { type: 'break' }
	| { type: 'link'; href: string | null; title: string | null; external: boolean; children: MarkdownInline[] }
	| { type: 'image'; src: string | null; alt: string; title: string | null };

export interface MarkdownListItem {
	checked: boolean | null;
	children: MarkdownBlock[];
}

export interface MarkdownTableCell {
	align: 'center' | 'left' | 'right' | null;
	children: MarkdownInline[];
}

export type MarkdownBlock =
	| { type: 'paragraph'; children: MarkdownInline[] }
	| { type: 'heading'; depth: number; children: MarkdownInline[] }
	| { type: 'code'; text: string; language: string | null }
	| { type: 'blockquote'; children: MarkdownBlock[] }
	| { type: 'list'; ordered: boolean; start: number | null; items: MarkdownListItem[] }
	| { type: 'table'; header: MarkdownTableCell[]; rows: MarkdownTableCell[][] }
	| { type: 'rule' };

function safeResource(value: string): { value: string | null; external: boolean } {
	const href = value.trim();
	if (!href) return { value: null, external: false };
	if (/^(?:https?):\/\//i.test(href)) return { value: href, external: true };
	if (/^\/\//.test(href)) return { value: href, external: true };
	if (/^mailto:/i.test(href)) return { value: href, external: true };
	if (/^(?:\/|\.\/|\.\.\/|#|\?)/.test(href)) return { value: href, external: false };
	if (/^[a-z][a-z\d+.-]*:/i.test(href)) return { value: null, external: false };
	return { value: href, external: false };
}

const REF_WORD_BEFORE = /\b(?:branch(?:es)?|refs?|tags?|checkout|check out|checked out|switch(?:ed)? to|merged?|merging|rebased? (?:on|onto)|push(?:ed)? to|pull request from|PR from)\s*$/i;
const REF_WORD_AFTER = /^\s*(?:branch(?:es)?|ref|tag)\b/i;
const BRANCH_PREFIX = /^(?:refs\/(?:heads|tags|remotes)\/|(?:feature|features|feat|fix|fixes|bugfix|hotfix|release|releases|chore|ux|ui|refactor|perf|ci|style|wip|spike|exp|experiment|codex|claude|dependabot|renovate|backport)\/)/i;

/**
 * Whether a code span names a Git branch, tag or ref rather than a file:
 * the surrounding words say so ("branch `ux/page-audit-072`", "`x` branch"),
 * or it is an extension-less name with a conventional branch prefix
 * (`feature/…`, `fix/…`, `refs/heads/…`). Explicit `./` or absolute paths and
 * names ending in a file extension are always files.
 */
export function isGitRefCode(text: string, before = '', after = ''): boolean {
	const name = text.trim();
	if (!name.includes('/') || /^(?:\.{1,2}\/|~\/|\/)/.test(name) || /\s/.test(name)) return false;
	const last = name.split('/').pop() ?? '';
	const hasExtension = /\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+(?::\d+)?)?$/.test(last);
	if (REF_WORD_BEFORE.test(before) || REF_WORD_AFTER.test(after)) return !hasExtension || /^refs\//.test(name);
	return !hasExtension && BRANCH_PREFIX.test(name);
}

/** Mark code spans that the neighbouring words identify as Git refs. */
function markGitRefs(inlines: MarkdownInline[]): MarkdownInline[] {
	return inlines.map((token, index) => {
		if (token.type !== 'code') return token;
		const previous = inlines[index - 1];
		const next = inlines[index + 1];
		const before = previous?.type === 'text' ? previous.text : '';
		const after = next?.type === 'text' ? next.text : '';
		return isGitRefCode(token.text, before, after) ? { ...token, gitRef: true } : token;
	});
}

function inlineTokens(tokens: Token[]): MarkdownInline[] {
	return markGitRefs(collectInlines(tokens));
}

function collectInlines(tokens: Token[]): MarkdownInline[] {
	const result: MarkdownInline[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case 'text': {
				const text = token as Tokens.Text;
				// Flatten in place so neighbouring words stay adjacent to code spans.
				if (text.tokens?.length) result.push(...collectInlines(text.tokens));
				else if (text.text) result.push({ type: 'text', text: text.text });
				break;
			}
			case 'escape':
				result.push({ type: 'text', text: (token as Tokens.Escape).text });
				break;
			case 'html':
				// Raw HTML is deliberately rendered as text; Svelte never receives an HTML string.
				result.push({ type: 'text', text: (token as Tokens.HTML).text });
				break;
			case 'strong':
			case 'em':
			case 'del':
				result.push({ type: token.type, children: inlineTokens((token as Tokens.Strong | Tokens.Em | Tokens.Del).tokens) });
				break;
			case 'codespan':
				result.push({ type: 'code', text: (token as Tokens.Codespan).text });
				break;
			case 'br':
				result.push({ type: 'break' });
				break;
			case 'link': {
				const link = token as Tokens.Link;
				const safe = safeResource(link.href);
				result.push({
					type: 'link',
					href: safe.value,
					title: link.title ?? null,
					external: safe.external,
					children: inlineTokens(link.tokens)
				});
				break;
			}
			case 'image': {
				const image = token as Tokens.Image;
				result.push({
					type: 'image',
					src: safeResource(image.href).value,
					alt: image.text,
					title: image.title
				});
				break;
			}
		}
	}
	return result;
}

function tableCell(cell: Tokens.TableCell): MarkdownTableCell {
	return { align: cell.align, children: inlineTokens(cell.tokens) };
}

function blockTokens(tokens: Token[]): MarkdownBlock[] {
	const result: MarkdownBlock[] = [];
	for (const token of tokens) {
		switch (token.type) {
			case 'space':
			case 'def':
				break;
			case 'paragraph':
				result.push({ type: 'paragraph', children: inlineTokens((token as Tokens.Paragraph).tokens) });
				break;
			case 'text': {
				const text = token as Tokens.Text;
				result.push({ type: 'paragraph', children: text.tokens?.length ? inlineTokens(text.tokens) : [{ type: 'text', text: text.text }] });
				break;
			}
			case 'html':
				result.push({ type: 'paragraph', children: [{ type: 'text', text: (token as Tokens.HTML).text }] });
				break;
			case 'heading': {
				const heading = token as Tokens.Heading;
				result.push({ type: 'heading', depth: heading.depth, children: inlineTokens(heading.tokens) });
				break;
			}
			case 'code': {
				const code = token as Tokens.Code;
				result.push({ type: 'code', text: code.text, language: code.lang?.trim() || null });
				break;
			}
			case 'blockquote':
				result.push({ type: 'blockquote', children: blockTokens((token as Tokens.Blockquote).tokens) });
				break;
			case 'list': {
				const list = token as Tokens.List;
				result.push({
					type: 'list',
					ordered: list.ordered,
					start: typeof list.start === 'number' ? list.start : null,
					items: list.items.map((item) => ({
						checked: item.task ? Boolean(item.checked) : null,
						children: blockTokens(item.tokens)
					}))
				});
				break;
			}
			case 'table': {
				const table = token as Tokens.Table;
				result.push({
					type: 'table',
					header: table.header.map(tableCell),
					rows: table.rows.map((row) => row.map(tableCell))
				});
				break;
			}
			case 'hr':
				result.push({ type: 'rule' });
				break;
		}
	}
	return result;
}

export function parseCodexMarkdown(markdown: string): MarkdownBlock[] {
	return blockTokens(marked.lexer(markdown.replace(/^[\u200B-\u200F\uFEFF]/, ''), { gfm: true }));
}

/** Explicit local Markdown links in display order; ignore images and code paths. */
export function markdownFileReferences(markdown: string, includeCode = false): Array<{ text: string; requireSeparator: boolean; code?: boolean }> {
	const references: Array<{ text: string; requireSeparator: boolean; code?: boolean }> = [];
	function inlines(tokens: MarkdownInline[]) {
		for (const token of tokens) {
			if (token.type === 'link' && !token.external && token.href) references.push({ text: token.href, requireSeparator: false });
			// Paths in code spans render as file links too (Git refs excepted).
			if (includeCode && token.type === 'code' && !token.gitRef) references.push({ text: token.text, requireSeparator: true, code: true });
			if ('children' in token && token.type !== 'link') inlines(token.children);
		}
	}
	function blocks(tokens: MarkdownBlock[]) {
		for (const token of tokens) {
			if (token.type === 'paragraph' || token.type === 'heading') inlines(token.children);
			else if (token.type === 'blockquote') blocks(token.children);
			else if (token.type === 'list') for (const item of token.items) blocks(item.children);
			else if (token.type === 'table') for (const cell of [...token.header, ...token.rows.flat()]) inlines(cell.children);
		}
	}
	blocks(parseCodexMarkdown(markdown));
	return references;
}
