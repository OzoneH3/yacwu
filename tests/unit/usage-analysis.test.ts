import { expect, test } from 'bun:test';
import { analyzeUsage as analyzeObservedUsage, type UsageEvent } from '../../src/lib/usage-analysis';
const analyzeUsage = (events: UsageEvent[]) => analyzeObservedUsage(events, { settleMs: 0 });

const event = (at: number, event: string, fields: Partial<UsageEvent> = {}): UsageEvent => ({ at, event, host: 'local', ...fields });
const quota = (at: number, usedPercent: number, resetsAt = 1_000) => event(at, 'quota', { usedPercent, resetsAt, limitId: 'codex' });
const setup = (id: string, model: string): UsageEvent[] => [event(0, 'newThread', { threadId: id }), event(0, 'metadata', { threadId: id, model, effort: 'medium' }), event(1, 'turn/started', { threadId: id, turnId: id })];
const tokens = (at: number, id: string, total: number) => event(at, 'tokens', { threadId: id, turnId: id, total: { totalTokens: total, inputTokens: total } });

test('settled benchmark boundaries keep one-percent stages separate without double counting', () => {
	const history: UsageEvent[] = [quota(0, 20)];
	let used = 20;
	for (const [index, amount] of [2, 1, 1].entries()) {
		const id = `stage-${index}`, at = index * 100 + 1;
		history.push(event(at, 'newThread', { threadId: id }), event(at, 'metadata', { threadId: id, model: id, effort: 'low' }),
			event(at + 1, 'benchmarkBoundary', { threadId: id, usedPercent: used, resetsAt: 1000 }),
			event(at + 2, 'turn/started', { threadId: id, turnId: id }), tokens(at + 3, id, 1000 * (index + 1)),
			event(at + 4, 'turn/completed', { threadId: id, turnId: id }), quota(at + 5, used + amount),
			event(at + 6, 'benchmarkBoundaryEnd', { threadId: id, usedPercent: used + amount, resetsAt: 1000 }));
		used += amount;
	}
	const result = analyzeUsage(history);
	expect(result.observations).toBe(3);
	expect(result.rates.map((rate) => rate.tokens).sort((a, b) => a - b)).toEqual([1000, 2000, 3000]);
	expect(result.excludedIntervals).toBe(0);
});

test('competing tokens contaminate a benchmark stage and cancellation discards an open interval', () => {
	const history = [quota(0, 20), event(1, 'newThread', { threadId: 'a' }),
		event(1, 'metadata', { threadId: 'a', model: 'a', effort: 'low' }),
		event(2, 'benchmarkBoundary', { threadId: 'a', usedPercent: 20, resetsAt: 1000 }),
		event(3, 'turn/started', { threadId: 'a', turnId: 'a' }), tokens(4, 'a', 100),
		...setup('b', 'b').map((e) => ({ ...e, at: e.at + 5 })), tokens(7, 'b', 100)];
	expect(analyzeUsage([...history, event(8, 'benchmarkBoundaryEnd', { threadId: 'a', usedPercent: 21, resetsAt: 1000 })]).observations).toBe(0);
	expect(analyzeUsage([...history, event(8, 'benchmarkFinished'), quota(9, 22)]).observations).toBe(0);
});

test('learns separate model costs from independent overlapping usage mixtures', () => {
	const result = analyzeUsage([
		...setup('a', 'model-a'), ...setup('b', 'model-b'), quota(2, 0),
		tokens(3, 'a', 100_000), tokens(3, 'b', 100_000), quota(4, 4),
		tokens(5, 'a', 300_000), tokens(5, 'b', 200_000), quota(6, 9),
		tokens(7, 'a', 400_000), tokens(7, 'b', 400_000), quota(8, 16),
		tokens(8.1, 'a', 500_000), tokens(8.1, 'b', 500_000), quota(8.2, 20),
		event(9, 'turn/completed', { threadId: 'a', turnId: 'a', status: 'completed' }), quota(10, 16)
	]);
	expect(result.rates.find((rate) => rate.model === 'model-a')!.percentPer100kTokens).toBeCloseTo(1, 4);
	expect(result.rates.find((rate) => rate.model === 'model-b')!.percentPer100kTokens).toBeCloseTo(3, 4);
	expect(result.tasks.find((task) => task.threadId === 'a')!.estimatedWeeklyPercent).toBeCloseTo(5, 3);
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

test('late quota updates settle after completion before calibration closes', () => {
	const result = analyzeObservedUsage([
		event(0, 'newThread', { threadId: 'a' }), event(0, 'metadata', { threadId: 'a', model: 'a', effort: 'high' }), quota(0, 10),
		event(1, 'turn/started', { threadId: 'a', turnId: 'a' }), tokens(10_000, 'a', 100_000),
		event(20_000, 'turn/completed', { threadId: 'a', turnId: 'a' }), quota(21_000, 10), quota(40_000, 12), quota(100_000, 12)
	]);
	expect(result.observations).toBe(1);
	expect(result.tasks[0].sharedAllowanceDelta).toBe(2);
	expect(result.tasks[0].settling).toBe(false);
	const pending = analyzeObservedUsage([ ...setup('a', 'a'), quota(2, 0), tokens(3, 'a', 10), event(4, 'turn/completed', { threadId: 'a', turnId: 'a' }), quota(5, 2) ]);
	expect(pending.observations).toBe(0);
	expect(pending.tasks[0].settling).toBe(true);
});

test('matching account hosts share token evidence but use one quota source', () => {
	const onRemote = (events: UsageEvent[]) => events.map((e) => ({ ...e, host: 'remote' }));
	const result = analyzeObservedUsage([
		event(-1, 'account', { fingerprint: 'same' }), ...setup('local-task', 'model'), quota(2, 0),
		...onRemote([event(-1, 'account', { fingerprint: 'same' }), ...setup('remote-task', 'model')]),
		tokens(3, 'local-task', 100), ...onRemote([tokens(3, 'remote-task', 200), quota(4, 99)]), quota(4, 2)
	], { settleMs: 0 });
	expect(result.observations).toBe(1);
	expect(result.rates[0].tokens).toBe(300);
	expect(result.hosts.sort()).toEqual(['local', 'remote']);
	expect(result.tasks).toHaveLength(2);
});

test('a transient quota increase does not train costs before repeated readings stabilize', () => {
	const history = [...setup('a', 'model-a'), quota(2, 10), tokens(3, 'a', 100),
		event(4, 'turn/completed', { threadId: 'a', turnId: 'a' }),
		quota(70_000, 12), quota(80_000, 11), quota(150_000, 11)];
	expect(analyzeObservedUsage(history).observations).toBe(0);
	expect(analyzeObservedUsage([...history, quota(160_000, 12), quota(219_000, 12)]).observations).toBe(0);
	const settled = analyzeObservedUsage([...history, quota(160_000, 12), quota(220_000, 12)]);
	expect(settled.observations).toBe(1);
	expect(settled.rates[0].tokens).toBe(100);
});

test('other account hosts are excluded and a host restart does not stop another host task', () => {
	const result = analyzeObservedUsage([
		event(-1, 'account', { fingerprint: 'same' }), ...setup('local-task', 'model'), quota(2, 0),
		{ ...event(-1, 'account', { fingerprint: 'different' }), host: 'remote' },
		...setup('remote-task', 'model').map((e) => ({ ...e, host: 'remote' })),
		{ ...tokens(3, 'remote-task', 99999), host: 'remote' }, tokens(3, 'local-task', 100), quota(4, 2)
	], { settleMs: 0 });
	expect(result.rates[0].tokens).toBe(100);
	expect(result.tasks).toHaveLength(1);
	const shared = analyzeObservedUsage([
		event(-1, 'account', { fingerprint: 'same' }), ...setup('local-task', 'model'),
		{ ...event(-1, 'account', { fingerprint: 'same' }), host: 'remote' },
		{ ...event(3, 'collectorStarted'), host: 'remote' }
	]);
	expect(shared.tasks[0].status).toBe('running');
});
