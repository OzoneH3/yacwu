import { expect, test } from 'bun:test';
import { indexFileLineStats, lineStatsForPath, normalizeWorkspacePath } from '../../src/lib/file-change-stats';

test('normalizes relative, absolute, and Windows file-change paths', () => {
	expect(normalizeWorkspacePath('./src/app.ts')).toBe('src/app.ts');
	expect(normalizeWorkspacePath('/work/repo/src/app.ts', '/work/repo')).toBe('src/app.ts');
	expect(normalizeWorkspacePath('C:\\work\\repo\\src\\app.ts', 'C:\\work\\repo')).toBe('src/app.ts');
});

test('matches transcript paths to Git line counts and avoids ambiguous basename matches', () => {
	const stats = indexFileLineStats([
		{ path: 'src/app.ts', additions: 14, deletions: 3 },
		{ path: 'src/shared.ts', additions: 2, deletions: 1 },
		{ path: 'test/shared.ts', additions: 8, deletions: 0 }
	]);
	expect(lineStatsForPath(stats, '/work/repo/src/app.ts', '/work/repo')).toEqual({ additions: 14, deletions: 3 });
	expect(lineStatsForPath(stats, '/work/repo/src/app.ts')).toEqual({ additions: 14, deletions: 3 });
	expect(lineStatsForPath(stats, 'shared.ts')).toBeNull();
});
