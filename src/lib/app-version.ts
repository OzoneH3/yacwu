/**
 * Build versions look like "<commit>@<ISO build time>" (see svelte.config.js),
 * with a "+" after the commit when the build had uncommitted changes.
 */
export interface AppVersion {
	commit: string;
	builtAt: Date | null;
}

export function parseAppVersion(name: string): AppVersion {
	const at = name.lastIndexOf('@');
	if (at < 0) return { commit: name, builtAt: null };
	const builtAt = new Date(name.slice(at + 1));
	return { commit: name.slice(0, at), builtAt: Number.isNaN(builtAt.getTime()) ? null : builtAt };
}

export function appVersionTitle(name: string): string {
	const { commit, builtAt } = parseAppVersion(name);
	const source = commit.endsWith('+') ? `commit ${commit.slice(0, -1)} with uncommitted changes` : `commit ${commit}`;
	return builtAt ? `Yacwu build from ${source}, built ${builtAt.toLocaleString()}` : `Yacwu build from ${source}`;
}
