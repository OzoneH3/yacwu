import { expect, test } from 'bun:test';
import { projectRulesStatusText, type ProjectRulesState } from '../../src/lib/project-rules';

const state = (status: ProjectRulesState['status'], current: number, applied: number | null): ProjectRulesState => ({
	current: { project: 'local:/r/.git', name: 'r', identity: '/r/.git', text: 'Reuse first.', version: current, updatedAt: 1 },
	applied: applied === null ? null : { project: 'local:/r/.git', version: applied, appliedAt: 1 },
	status
});

test('the status says which rules the session actually started with', () => {
	expect(projectRulesStatusText(state('current', 3, 3))).toBe('This session started with the current rules (version 3).');
	expect(projectRulesStatusText(state('current', 0, 0))).toContain('No project rules yet');
	expect(projectRulesStatusText(state('outdated', 4, 3))).toBe('Rules outdated: this session started with version 3; the project is now at version 4. Start a new session (or use Clear first) to apply them.');
	expect(projectRulesStatusText(state('outdated', 1, 0))).toContain('started before the project had rules');
	expect(projectRulesStatusText(state('unknown', 2, null))).toContain('may not have them (current version 2)');
	expect(projectRulesStatusText(state('otherProject', 2, 1))).toContain('another project');
});
