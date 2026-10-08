import { describe, expect, test } from 'bun:test';
import {
	parseTaskProgress,
	separateTaskProgressEntries,
	stripTaskProgressMarkers,
	withTaskProgressInstructions
} from '../../src/lib/task-progress';

describe('task progress reporting', () => {
	test('adds one set of private reporting instructions', () => {
		const first = withTaskProgressInstructions('Do the task');
		const retried = withTaskProgressInstructions(first);
		expect(first).toContain('<!-- YACWU_TASK_PROGRESS -->');
		expect(first).toContain('[[YACWU_PROGRESS percent=35 remaining_minutes=6]]');
		expect(retried.match(/<!-- YACWU_TASK_PROGRESS -->/g)).toHaveLength(1);
	});

	test('states reporting as a requirement with cadence, numeric estimates and a final 100', () => {
		const text = withTaskProgressInstructions('Do the task');
		expect(text).toContain('Progress reporting is required');
		expect(text).toContain('before your first tool call');
		expect(text).toContain('Never let a long run of tool calls pass without one');
		expect(text).toContain('use “unknown” only when you truly cannot');
		expect(text).toContain('percent=100 remaining_minutes=0');
		expect(text).toContain('Never put the marker in the final answer');
		// Only the bracketed example counts as a marker; the prose about the
		// final 100% must not read as a reported completion.
		expect(parseTaskProgress(text)?.percent).toBe(35);
	});

	test('uses the latest estimate and clamps invalid bounds', () => {
		expect(parseTaskProgress('Start [[YACWU_PROGRESS percent=25 remaining_minutes=12]] then [[YACWU_PROGRESS percent=130 remaining_minutes=unknown]]'))
			.toEqual({ percent: 100, remainingMinutes: null });
		expect(parseTaskProgress('[[YACWU_PROGRESS percent=0 remaining_minutes=0]]'))
			.toEqual({ percent: 0, remainingMinutes: 0 });
	});

	test('removes protocol markers from displayed assistant text', () => {
		expect(stripTaskProgressMarkers('Working\n[[YACWU_PROGRESS percent=25 remaining_minutes=12]]\nstill working'))
			.toBe('Working\nstill working');
		expect(stripTaskProgressMarkers('Working [[YACWU_PROGRESS percent=100 remaining_minutes=0]] complete'))
			.toBe('Working complete');
	});

	test('moves an assistant progress estimate into its own transcript entry', () => {
		const entries = separateTaskProgressEntries([
			{ type: 'agentMessage', id: 'reply-1', text: 'Working on it. [[YACWU_PROGRESS percent=55 remaining_minutes=4]]' }
		]);
		expect(entries).toEqual([
			{ type: 'agentMessage', id: 'reply-1', text: 'Working on it.' },
			{ type: 'taskProgress', id: 'progress-reply-1', percent: 55, remainingMinutes: 4 }
		]);
	});
});
