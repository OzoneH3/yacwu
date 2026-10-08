import { expect, test } from 'bun:test';
import { adapterModels } from '../../scripts/claude-backend.mjs';
import { reportedTokenStatistics } from '../../src/lib/protocol';

test('Claude catalog labels resolve versions without treating a date as a minor version', () => {
	const choices = adapterModels([
		{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus' },
		{ value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
		{ value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku' },
		{ value: 'custom', displayName: 'Custom model' }
	]);
	expect(choices.map((choice: { displayName: string }) => choice.displayName)).toEqual(['Claude Opus 5.5', 'Claude Sonnet 5', 'Claude Haiku 4.5', 'Custom model']);
	expect(choices[0].id).toBe('opus');
	expect(choices[0].sdkModel).toBe('opus');
});

test('usage statistics preserve reported cumulative counters and reject invalid snapshots', () => {
	const total = { totalTokens: 1200, inputTokens: 700, cachedInputTokens: 300, outputTokens: 200 };
	expect(reportedTokenStatistics({ total, last: { totalTokens: 100 } })).toEqual(total);
	expect(reportedTokenStatistics({ total: { ...total, outputTokens: -1 } })).toBeNull();
	expect(reportedTokenStatistics({ last: total })).toBeNull();
});
