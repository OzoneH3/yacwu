import { expect, test } from 'bun:test';
import { analyzeUsage, type UsageEvent } from '../../src/lib/usage-analysis';

const event = (at: number, event: string, fields: Partial<UsageEvent> = {}): UsageEvent => ({ at, event, host: 'local', ...fields });
const quota = (at: number, usedPercent: number, resetsAt = 1_000) => event(at, 'quota', { usedPercent, resetsAt, limitId: 'codex' });
const setup = (id: string, model: string): UsageEvent[] => [event(0, 'newThread', { threadId: id }), event(0, 'metadata', { threadId: id, model, effort: 'medium' }), event(1, 'turn/started', { threadId: id, turnId: id })];
const tokens = (at: number, id: string, total: number) => event(at, 'tokens', { threadId: id, turnId: id, total: { totalTokens: total, inputTokens: total } });

test('learns separate model costs from independent overlapping usage mixtures', () => {
	const result = analyzeUsage([
		...setup('a', 'model-a'), ...setup('b', 'model-b'), quota(2, 0),
		tokens(3, 'a', 100_000), tokens(3, 'b', 100_000), quota(4, 4),
		tokens(5, 'a', 300_000), tokens(5, 'b', 200_000), quota(6, 9),
		tokens(7, 'a', 400_000), tokens(7, 'b', 400_000), quota(8, 16),
		event(9, 'turn/completed', { threadId: 'a', turnId: 'a', status: 'completed' }), quota(10, 16)
	]);
	expect(result.rates.find((rate) => rate.model === 'model-a')!.percentPer100kTokens).toBeCloseTo(1, 4);
	expect(result.rates.find((rate) => rate.model === 'model-b')!.percentPer100kTokens).toBeCloseTo(3, 4);
	expect(result.tasks.find((task) => task.threadId === 'a')!.estimatedWeeklyPercent).toBeCloseTo(4, 4);
	expect(result.tasks.every((task) => task.overlapping)).toBe(true);
});

test('unchanged and one-percent readings accumulate rather than implying free tasks', () => {
	const result = analyzeUsage([...setup('a', 'model-a'), quota(2, 20), tokens(3, 'a', 100), quota(4, 20), tokens(5, 'a', 200), quota(6, 21), tokens(7, 'a', 300), quota(8, 22)]);
	expect(result.observations).toBe(1);
	expect(result.rates[0].tokens).toBe(300);
	expect(result.tasks[0].estimatedWeeklyPercent).toBeNull();
});

test('a missing cumulative baseline never charges historic session tokens to a new task', () => {
	const result = analyzeUsage([event(0, 'metadata', { threadId: 'a', model: 'model-a', effort: 'high' }), quota(1, 0), event(2, 'turn/started', { threadId: 'a', turnId: 'a' }), tokens(3, 'a', 5_000_000), tokens(4, 'a', 5_000_100), quota(5, 2)]);
	expect(result.tasks[0].tokens.totalTokens).toBe(100);
	expect(result.tasks[0].partialTokens).toBe(true);
	expect(result.observations).toBe(0);
});

test('quota resets and quota changes without tracked tokens do not train costs', () => {
	const result = analyzeUsage([...setup('a', 'model-a'), quota(2, 80), tokens(3, 'a', 100), quota(4, 0, 2_000), quota(5, 3, 2_000)]);
	expect(result.observations).toBe(0);
	expect(result.excludedIntervals).toBe(1);
});

test('identical mixtures cannot identify individual model costs', () => {
	const result = analyzeUsage([...setup('a', 'model-a'), ...setup('b', 'model-b'), quota(2, 0), tokens(3, 'a', 100), tokens(3, 'b', 100), quota(4, 2), tokens(5, 'a', 200), tokens(5, 'b', 200), quota(6, 4), tokens(7, 'a', 300), tokens(7, 'b', 300), quota(8, 6)]);
	expect(result.observations).toBe(3);
	expect(result.rates.every((rate) => rate.percentPer100kTokens === null)).toBe(true);
});

test('model and effort are frozen per turn even when selection changes during work', () => {
	const result = analyzeUsage([...setup('a', 'old-model'), event(2, 'settings', { threadId: 'a', model: 'new-model', effort: 'high' }), tokens(3, 'a', 100), event(4, 'turn/completed', { threadId: 'a', turnId: 'a' }), event(5, 'turn/started', { threadId: 'a', turnId: 'next' })]);
	expect(result.tasks[1].model).toBe('old-model');
	expect(result.tasks[1].effort).toBe('medium');
	expect(result.tasks[0].model).toBe('new-model');
	expect(result.tasks[0].effort).toBe('high');
});
