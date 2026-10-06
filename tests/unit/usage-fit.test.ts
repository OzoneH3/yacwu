import { expect, test } from 'bun:test';
import { learnTokenCosts, type UsageObservation } from '../../src/lib/usage-fit';
import type { TokenTotals } from '../../src/lib/usage-analysis';

const totals = (uncached: number, cached: number, output: number): TokenTotals => ({ totalTokens: uncached + cached + output, inputTokens: uncached + cached, cachedInputTokens: cached, outputTokens: output, reasoningOutputTokens: output / 2 });
const sample = (uncached: number, cached: number, output: number): UsageObservation => ({ percent: (2 * uncached + .4 * cached + 5 * output) / 100_000, tokens: { model: totals(uncached, cached, output) } });

test('learns distinct cached, uncached and output weights without double-counting reasoning', () => {
	const learned = learnTokenCosts([sample(100_000, 0, 0), sample(0, 500_000, 0), sample(0, 0, 100_000), sample(100_000, 100_000, 100_000), sample(200_000, 100_000, 0), sample(0, 200_000, 100_000)]);
	expect(learned.weights('model').uncached).toBeCloseTo(2, 3);
	expect(learned.weights('model').cached).toBeCloseTo(.4, 3);
	expect(learned.weights('model').output).toBeCloseTo(5, 3);
	const estimate = learned.estimate('model', totals(100_000, 100_000, 100_000))!;
	expect(estimate.value).toBeCloseTo(7.4, 3);
	expect(estimate.low).toBeLessThan(estimate.value);
	expect(estimate.high).toBeGreaterThan(estimate.value);
	expect(estimate.samples).toBe(6);
	expect(estimate.weighted).toBe(true);
});

test('rounding uncertainty remains nonzero for a perfectly fitted model', () => {
	const learned = learnTokenCosts([sample(100_000, 0, 0), sample(200_000, 0, 0), sample(300_000, 0, 0)]);
	const estimate = learned.estimate('model', totals(100_000, 0, 0))!;
	expect(estimate.high - estimate.low).toBeGreaterThan(0);
});

test('collinear token mixes use an explicitly labeled total-token fallback', () => {
	const learned = learnTokenCosts([sample(100_000, 100_000, 100_000), sample(200_000, 200_000, 200_000), sample(300_000, 300_000, 300_000), sample(400_000, 400_000, 400_000)]);
	expect(learned.estimate('model', totals(100_000, 100_000, 100_000))!.weighted).toBe(false);
	expect(learned.weights('model').cached).toBeNull();
});

test('a new model with sparse evidence does not erase an existing calibrated model', () => {
	const known = [sample(100_000, 0, 0), sample(200_000, 0, 0), sample(300_000, 0, 0)];
	const learned = learnTokenCosts([...known, { percent: 2, tokens: { newModel: totals(100_000, 0, 0) } }]);
	expect(learned.estimate('model', totals(100_000, 0, 0))!.value).toBeCloseTo(2, 3);
	expect(learned.estimate('newModel', totals(100_000, 0, 0))).toBeNull();
});
