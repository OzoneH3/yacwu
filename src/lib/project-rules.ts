/** A session's project rules, as GET /api/threads/:id/project-rules reports them. */
export interface ProjectRulesState {
	current: { project: string; name: string; identity: string; text: string; version: number; updatedAt: number | null };
	applied: { project: string; version: number; appliedAt: number } | null;
	/** current: loaded the latest version; outdated: an older one; otherProject: started elsewhere; unknown: started before tracking. */
	status: 'current' | 'outdated' | 'otherProject' | 'unknown';
}

/** What the session actually received, said plainly. */
export function projectRulesStatusText(state: ProjectRulesState): string {
	const latest = state.current.version;
	switch (state.status) {
		case 'current':
			return latest
				? `This session started with the current rules (version ${latest}).`
				: 'No project rules yet. Rules you save here apply to new sessions in this project.';
		case 'outdated':
			return state.applied?.version
				? `Rules outdated: this session started with version ${state.applied.version}; the project is now at version ${latest}. Start a new session (or use Clear first) to apply them.`
				: `Rules outdated: this session started before the project had rules; it is now at version ${latest}. Start a new session (or use Clear first) to apply them.`;
		case 'otherProject':
			return 'This session started in another project, so it has that project’s rules. Start a new session here to get these.';
		default:
			return latest
				? `This session started before Yacwu tracked project rules, so it may not have them (current version ${latest}). Start a new session to apply them.`
				: 'This session started before Yacwu tracked project rules. Rules you save here apply to new sessions in this project.';
	}
}
