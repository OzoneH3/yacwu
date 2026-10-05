import { describe, expect, test } from 'bun:test';
import {
	parseTaskProgress,
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

	test('uses the latest estimate and clamps invalid bounds', () => {
		expect(parseTaskProgress('Start [[YACWU_PROGRESS percent=25 remaining_minutes=12]] then [[YACWU_PROGRESS percent=130 remaining_minutes=unknown]]'))
			.toEqual({ percent: 100, remainingMinutes: null });
		expect(parseTaskProgress('[[YACWU_PROGRESS percent=0 remaining_minutes=0]]'))
			.toEqual({ percent: 0, remainingMinutes: 0 });
	});

	test('removes protocol markers from displayed assistant text', () => {
		expect(stripTaskProgressMarkers('Working\n[[YACWU_PROGRESS percent=25 remaining_minutes=12]]\nstill working'))
			.toBe('Working\nstill working');
	});
});
