import { describe, expect, test } from 'bun:test';
import { activityKind, liveActivityLabel, turnTokens } from '../../src/lib/live-activity';

const stats = (totalTokens: number) => ({ totalTokens, inputTokens: totalTokens, cachedInputTokens: 0, outputTokens: 0 });

describe('live activity', () => {
	test('names what a running turn is doing', () => {
		expect(activityKind('item/reasoning/textDelta')).toBe('thinking');
		expect(activityKind('item/agentMessage/delta')).toBe('writing');
		expect(activityKind('item/started')).toBe('step');
		expect(activityKind('yacwu/diagnostic/stalled')).toBeNull();
	});

	test('counts tokens since the turn started', () => {
		expect(turnTokens(stats(1000), stats(13_400))).toBe(12_400);
		expect(turnTokens(null, stats(500))).toBe(500);
		expect(turnTokens(stats(1000), undefined)).toBeNull();
	});

	test('says how recent the latest sign of progress is', () => {
		expect(liveActivityLabel('thinking', 10_000, 12_400, 13_000)).toBe('thinking 3s ago · 12k tokens this turn');
		expect(liveActivityLabel('step', 0, null, 600_000)).toBe('last update 10m ago');
		expect(liveActivityLabel(null, null, 2_500, 0)).toBe('2.5k tokens this turn');
	});
});
