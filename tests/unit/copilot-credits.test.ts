import { expect, test } from 'bun:test';
import { copilotTaskCredits } from '../../src/lib/copilot-credits';
import type { UsageTask } from '../../src/lib/usage-analysis';

const task = (fields: Partial<UsageTask> = {}): UsageTask => ({ host: 'gh', threadId: 'root', turnId: 't', model: 'copilot/gpt-6-luna', effort: 'medium', parentThreadId: null, startedAt: 1000, endedAt: 5000, status: 'completed', tokens: { inputTokens: 100_000, cachedInputTokens: 80_000, outputTokens: 10_000, reasoningOutputTokens: 5000, totalTokens: 110_000 }, partialTokens: false, overlapping: false, weeklyLeftBefore: null, weeklyLeftAfter: null, sharedAllowanceDelta: null, estimatedWeeklyPercent: null, quotaScope: null, accountKey: 'a', estimate: null, settling: false, benchmark: false, ...fields });

test('credits use disjoint input/cache/output counts, not dollars or reasoning twice', () => {
 const t = task(); const result = copilotTaskCredits([t], t);
 expect(result.low).toBeCloseTo(.78);
 expect(result.high).toBeCloseTo(.83);
 expect(result.incomplete).toBe(false);
});

test('aggregated input above the context threshold produces a range rather than assuming every call is long', () => {
 const t = task({ tokens: { inputTokens: 300_000, cachedInputTokens: 0, outputTokens: 10_000, totalTokens: 310_000, reasoningOutputTokens: 0 } });
 const result = copilotTaskCredits([t], t);
 expect(result.low).toBeCloseTo(3.5);
 expect(result.high).toBeCloseTo(8.25);
});

test('includes descendant work only within the task, and marks unknown or partial contributors', () => {
 const root = task(); const child = task({ threadId: 'child', parentThreadId: 'root', startedAt: 2000 });
 const other = task({ threadId: 'other' });
 const old = task({ threadId: 'old', parentThreadId: 'root', startedAt: 0 });
 expect(copilotTaskCredits([root, child, other, old], root).low).toBeCloseTo(1.56);
 expect(copilotTaskCredits([root, task({ ...child, partialTokens: true })], root).incomplete).toBe(true);
 expect(copilotTaskCredits([root, task({ ...child, model: 'unknown' })], root).incomplete).toBe(true);
});

test('historical display names and dotted/dashed Claude versions resolve without adding cost learning', () => {
 for (const model of ['Claude Haiku 5.5', 'copilot/claude-haiku-5-5', 'Copilot · Claude Haiku 5.5']) {
  const t = task({ model }); expect(copilotTaskCredits([t], t).low).toBeCloseTo(.78);
 }
 const sonnet = task({ model: 'Claude Sonnet 5.5' }); expect(copilotTaskCredits([sonnet], sonnet).low).toBeCloseTo(14.8);
});

test('unknown models, invalid counts, and missing recording never appear free', () => {
 const unknown = task({ model: 'new-model' }); expect(copilotTaskCredits([unknown], unknown).low).toBeNull();
 const bad = task({ tokens: { ...task().tokens, inputTokens: NaN } }); expect(copilotTaskCredits([bad], bad).low).toBeNull();
 const empty = task({ tokens: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 } }); expect(copilotTaskCredits([empty], empty).low).toBeNull();
});
