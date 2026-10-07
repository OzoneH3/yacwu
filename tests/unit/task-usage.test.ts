import { expect, test } from 'bun:test';
import { formatAllowancePercent, projectTaskUsage, summarizeTaskUsage } from '../../src/lib/task-usage';
import type { UsageTask } from '../../src/lib/usage-analysis';

function task(fields: Partial<UsageTask> = {}): UsageTask {
	return { host: 'local', threadId: 'root', turnId: 'turn', model: 'model', effort: 'medium', parentThreadId: null,
		startedAt: 1000, endedAt: 100_000, status: 'completed',
		tokens: { totalTokens: 1000, inputTokens: 900, cachedInputTokens: 800, outputTokens: 100, reasoningOutputTokens: 50 },
		partialTokens: false, overlapping: true, weeklyLeftBefore: null, weeklyLeftAfter: null, sharedAllowanceDelta: null,
		estimatedWeeklyPercent: 0.1, quotaScope: 'scope', accountKey: 'account',
		estimate: { value: 0.1, low: 0.05, high: 0.15, samples: 4, weighted: true }, settling: false, benchmark: false, ...fields };
}

test('prompt totals include nested agent turns but exclude other sessions, hosts and work orders', () => {
	const root = task(), child = task({ threadId: 'child', parentThreadId: 'root', startedAt: 2000 }),
		nested = task({ threadId: 'nested', parentThreadId: 'child', startedAt: 3000 });
	const summary = summarizeTaskUsage([root, child, nested, task({ threadId: 'other' }),
		task({ threadId: 'foreign', parentThreadId: 'root', host: 'remote' }),
		task({ threadId: 'old', parentThreadId: 'root', startedAt: 0 }),
		task({ threadId: 'later', parentThreadId: 'root', startedAt: 100_000 })], root);
	expect(summary.tokens).toBe(3000);
	expect(summary.percent).toBeCloseTo(0.3);
	expect(summary.agentTurns).toBe(2);
});

test('a partial or uncalibrated contributing agent prevents invented allowance totals', () => {
	const root = task();
	const incomplete = summarizeTaskUsage([root, task({ threadId: 'child', parentThreadId: 'root', partialTokens: true })], root);
	expect(incomplete.partial).toBe(true);
	expect(incomplete.percent).toBeNull();
	expect(incomplete.tokens).toBe(2000);
	expect(incomplete.knownPercent).toBeCloseTo(.1);
	expect(incomplete.unestimatedTurns).toBe(1);
	const unknown = summarizeTaskUsage([root, task({ threadId: 'child', parentThreadId: 'root', estimate: null })], root);
	expect(unknown.percent).toBeNull();
	expect(unknown.knownPercent).toBeCloseTo(.1);
	expect(unknown.unestimatedTurns).toBe(1);
	expect(projectTaskUsage(unknown, { percent: 50, remainingMinutes: 2 }, 61_000)).toBeNull();
	const uncalibrated = task({ estimate: null });
	expect(summarizeTaskUsage([uncalibrated], uncalibrated).knownPercent).toBeNull();
});

test('usage projections use progress or sufficient elapsed time, and require calibration', () => {
	const root = task(), summary = summarizeTaskUsage([root], root);
	expect(projectTaskUsage(summary, { percent: 50, remainingMinutes: 2 }, 61_000)).toEqual({ total: 0.2, remaining: 0.1, basis: 'progress' });
	expect(projectTaskUsage(summary, { percent: 0, remainingMinutes: 1 }, 61_000)).toEqual({ total: 0.2, remaining: 0.1, basis: 'time' });
	expect(projectTaskUsage(summary, { percent: 0, remainingMinutes: 1 }, 10_000)).toBeNull();
	expect(projectTaskUsage(summary, { percent: 0, remainingMinutes: null }, 61_000)).toBeNull();
	expect(projectTaskUsage({ ...summary, percent: null }, { percent: 50, remainingMinutes: 2 }, 61_000)).toBeNull();
	expect(formatAllowancePercent(null)).toBe('Learning…');
	expect(formatAllowancePercent(0.003)).toBe('~0.003%');
});

test('early agent estimates remain labelled provisional in combined task totals', () => {
	const root = task(), agent = task({ threadId: 'child', parentThreadId: 'root', estimate: { value: .1, low: .05, high: .15, samples: 1, weighted: false, provisional: true } });
	const summary = summarizeTaskUsage([root, agent], root);
	expect(summary.percent).toBeCloseTo(.2);
	expect(summary.provisional).toBe(true);
});
