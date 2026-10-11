import { expect, test } from 'bun:test';
import { coordinatorHandoff, HANDOFF_FILE_BUDGET, promptExcerpt } from '../../src/lib/coordinator-handoff';

test('a handoff carries context, request, result, changed and linked files', () => {
	const text = coordinatorHandoff({
		session: 'RESEARCH', folder: '/home/u/growpilot', agent: 'Claude · opus, high', branch: 'feature/zoom', durationMs: 754_000,
		request: 'Add zoom to History', result: 'Done. See `web/history.js`.',
		changedFiles: ['web/history.js'], files: [{ name: 'web/history.js', content: 'const a = "```";\n' }], skipped: ['big.bin (binary or too large)']
	});
	expect(text).toBe(`# Session result: RESEARCH

- Project folder: /home/u/growpilot
- Agent: Claude · opus, high
- Git branch: feature/zoom
- Took: 12m 34s

## Request

Add zoom to History

## Result

Done. See \`web/history.js\`.

## Files changed in this task

- web/history.js

## Linked files

### web/history.js

\`\`\`\`js
const a = "\`\`\`";
\`\`\`\`

## Not included

- big.bin (binary or too large)
`);
});

test('files beyond the size budget are listed instead of pasted', () => {
	const text = coordinatorHandoff({ session: 's', folder: '/f', agent: 'Codex', result: 'ok',
		files: [{ name: 'a.txt', content: 'a' }, { name: 'huge.txt', content: 'x'.repeat(HANDOFF_FILE_BUDGET) }] });
	expect(text).toContain('### a.txt');
	expect(text).not.toContain('### huge.txt');
	expect(text).toContain('- huge.txt (left out: the handoff would get too long)');
	expect(text).not.toContain('## Request');
	expect(text).not.toContain('Git branch');
});

test('a request excerpt keeps the first lines and says what was left out', () => {
	const long = Array.from({ length: 9 }, (_, index) => `line ${index + 1}`).join('\n');
	expect(promptExcerpt(long)).toBe('line 1\nline 2\nline 3\nline 4\nline 5\n\n[… prompt shortened: 4 more lines]');
	expect(promptExcerpt('short prompt')).toBe('short prompt');
	expect(promptExcerpt('x'.repeat(600))).toBe(`${'x'.repeat(500)}…\n\n[… prompt shortened]`);
	const text = coordinatorHandoff({ session: 's', folder: '/f', agent: 'Codex', result: 'ok', request: long, requestExcerpt: true });
	expect(text).toContain('## Request\n\nline 1\nline 2\nline 3\nline 4\nline 5\n\n[… prompt shortened: 4 more lines]\n\n## Result');
});
