import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_ESTIMATE_BIAS,
	estimateBias,
	estimateRemainingMinutes,
	latestTaskProgress,
	turnEstimateBias,
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

	test('stated time left is shown as given unless calibrated', () => {
		const min = 60_000;
		// Codex sessions: the model's figure, verbatim.
		expect(estimateRemainingMinutes(70, 80, 10 * min)).toBe(80);
		// Claude: 70% done after 10 minutes cannot have 80 minutes left.
		expect(estimateRemainingMinutes(70, 80, 10 * min, true)).toBe(5);
		// Understatement is corrected too.
		expect(estimateRemainingMinutes(20, 2, 10 * min, true)).toBe(40);
		// A plausible figure is kept, including one the pace cannot foresee.
		expect(estimateRemainingMinutes(70, 8, 10 * min, true)).toBe(8);
		expect(estimateRemainingMinutes(50, 15, 10 * min, true)).toBe(15);
		// Too early to judge the pace: keep the stated figure.
		expect(estimateRemainingMinutes(5, 90, 10 * min, true)).toBe(90);
		expect(estimateRemainingMinutes(40, 90, 50_000, true)).toBe(90);
		// No stated figure: the pace, as before; finished is zero.
		expect(estimateRemainingMinutes(70, null, 10 * min, true)).toBe(5);
		expect(estimateRemainingMinutes(100, null, 10 * min, true)).toBe(0);
		expect(estimateRemainingMinutes(100, 0, 10 * min, true)).toBe(0);
	});

	test('the reminder preference rides in the private progress block', () => {
		expect(withTaskProgressInstructions('Do it', 2)).toContain('<!-- YACWU_PROGRESS_REMINDERS minutes=2 -->');
		expect(withTaskProgressInstructions('Do it', null)).toContain('<!-- YACWU_PROGRESS_REMINDERS off -->');
		expect(withTaskProgressInstructions('Do it')).not.toContain('YACWU_PROGRESS_REMINDERS');
		// Re-applying replaces the block rather than stacking preferences.
		const twice = withTaskProgressInstructions(withTaskProgressInstructions('Do it', 2), null);
		expect(twice.match(/YACWU_PROGRESS_REMINDERS/g)).toHaveLength(1);
		expect(twice).toContain('off');
	});
});

test('a learned bias scales stated minutes before the pace check', () => {
	const min = 60_000;
	// Early on, with no pace yet, the corrected figure is shown.
	expect(estimateRemainingMinutes(2, 240, 5_000, true, 8)).toBe(30);
	expect(estimateRemainingMinutes(2, 240, 5_000, false, 8)).toBe(240);
	expect(estimateRemainingMinutes(5, 1, 5_000, true, 8)).toBe(1);
	expect(estimateRemainingMinutes(100, 0, 5_000, true, 8)).toBe(0);
	// Later, the corrected figure still yields to an inconsistent pace.
	expect(estimateRemainingMinutes(50, 80, 10 * min, true, 4)).toBe(20);
	expect(estimateRemainingMinutes(50, 120, 10 * min, true, 4)).toBe(10);
});

test('turn bias compares each stated estimate with the time that was actually left', () => {
	const min = 60_000;
	const estimates = [
		{ at: 0, percent: 2, remainingMinutes: 240 },
		{ at: 10 * min, percent: 40, remainingMinutes: 60 },
		{ at: 19.5 * min, percent: 95, remainingMinutes: 5 },
		{ at: 20 * min, percent: 100, remainingMinutes: 0 }
	];
	expect(turnEstimateBias(estimates, 0, 20 * min)).toBe(12);
	expect(turnEstimateBias(estimates, 0, 90_000)).toBeNull();
	expect(estimateBias([])).toBe(DEFAULT_ESTIMATE_BIAS);
	expect(estimateBias([6, 8, 30])).toBe(8);
	expect(estimateBias([50, 60, 70])).toBe(20);
});

test('a follow-up sent into a running task keeps its reported progress', () => {
	const progress = (id: string, turn: string, percent: number) => ({ type: 'agentMessage', id, _turnId: turn, text: `[[YACWU_PROGRESS percent=${percent} remaining_minutes=5]]` });
	const user = (id: string, turn: string | null) => ({ type: 'userMessage', id, _turnId: turn });
	const items = [user('u0', 't0'), progress('p0', 't0', 100), user('u1', 't1'), progress('p1', 't1', 20), progress('p2', 't1', 45), user('steer', 't1')];
	expect(latestTaskProgress(items, 't1')?.percent).toBe(45);
	// The previous task's progress never leaks into a new turn.
	expect(latestTaskProgress([...items.slice(0, 2), user('u1', 't1')], 't1')).toBeNull();
	// Idle: a new message starts over.
	expect(latestTaskProgress(items, null)).toBeNull();
	expect(latestTaskProgress(items.slice(0, 5), null)?.percent).toBe(45);
});
