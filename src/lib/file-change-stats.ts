export interface FileLineStats {
	additions: number | null;
	deletions: number | null;
}

export function normalizeWorkspacePath(path: string, cwd = ''): string {
	let normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
	const root = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
	if (root && normalized.startsWith(`${root}/`)) normalized = normalized.slice(root.length + 1);
	return normalized;
}

export function indexFileLineStats(
	files: Array<{ path: unknown; additions: unknown; deletions: unknown }>,
	cwd = ''
): Record<string, FileLineStats> {
	const indexed: Record<string, FileLineStats> = {};
	for (const file of files) {
		if (typeof file.path !== 'string') continue;
		const path = normalizeWorkspacePath(file.path, cwd);
		if (!path) continue;
		indexed[path] = {
			additions: typeof file.additions === 'number' ? file.additions : null,
			deletions: typeof file.deletions === 'number' ? file.deletions : null
		};
	}
	return indexed;
}

export function lineStatsForPath(
	stats: Record<string, FileLineStats>,
	path: string,
	cwd = ''
): FileLineStats | null {
	const normalized = normalizeWorkspacePath(path, cwd);
	if (stats[normalized]) return stats[normalized];
	const isAbsolute = normalized.startsWith('/') || /^[a-z]:\//i.test(normalized);
	if (!isAbsolute) return null;
	const matches = Object.entries(stats).filter(([candidate]) => normalized.endsWith(`/${candidate}`));
	return matches.length === 1 ? matches[0][1] : null;
}
