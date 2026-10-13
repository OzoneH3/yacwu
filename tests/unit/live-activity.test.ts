import { describe, expect, test } from 'bun:test';
import { activityKind, liveActivityLabel, streamedChars, turnTokenLabel, turnTokens } from '../../src/lib/live-activity';

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

	test('prefers reported tokens and otherwise estimates from streamed text', () => {
		expect(streamedChars('item/reasoning/textDelta', { delta: 'abcd' })).toBe(4);
		expect(streamedChars('item/started', { delta: 'abcd' })).toBe(0);
		expect(turnTokenLabel(12_400, 99_999)).toBe('12k tokens');
		expect(turnTokenLabel(null, 12_800)).toBe('~3.2k tokens');
		expect(turnTokenLabel(null, 0)).toBe('');
	});

	test('says how recent the latest sign of progress is', () => {
		expect(liveActivityLabel('thinking', 10_000, 13_000)).toBe('thinking 3s ago');
		expect(liveActivityLabel('step', 0, 600_000)).toBe('last update 10m ago');
		expect(liveActivityLabel(null, null, 0)).toBe('');
	});
});
