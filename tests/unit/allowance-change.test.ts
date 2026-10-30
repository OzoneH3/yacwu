import { expect, test } from 'bun:test';
import { analyzeUsage, createIncrementalUsageAnalyzer, type UsageEvent } from '../../src/lib/usage-analysis';
const cutoff = Date.parse('2026-10-29T17:56:00+01:00');
function sample(start: number, end: number, percent: number, planType = 'prolite', limitId = 'codex'): UsageEvent[] {
 const threadId = String(start);
 return [
  { at: start - 2, host: 'local', event: 'newThread', threadId },
  { at: start - 1, host: 'local', event: 'metadata', threadId, model: 'gpt-6-luna', effort: 'high' },
  { at: start, host: 'local', event: 'quota', usedPercent: 10, resetsAt: start, planType, limitId },
  { at: start + 1, host: 'local', event: 'turn/started', threadId, turnId: threadId },
  { at: start + 2, host: 'local', event: 'tokens', threadId, turnId: threadId, total: { totalTokens: 1000, inputTokens: 1000 }, last: { totalTokens: 1000, inputTokens: 1000 } },
  { at: start + 3, host: 'local', event: 'turn/completed', threadId, turnId: threadId },
  { at: end, host: 'local', event: 'quota', usedPercent: 10 + percent, resetsAt: start, planType, limitId }
 ];
}
test('older eligible Codex costs and uncertainty halve; raw readings and tokens stay intact', () => {
 const events = sample(cutoff - 100, cutoff - 10, 4);
 const result = analyzeUsage(events, { settleMs: 0 });
 expect(result.tasks[0].estimate).toMatchObject({ value: 2, low: 1.5, high: 2.5 });
 expect(result.tasks[0].sharedAllowanceDelta).toBe(4);
 expect(result.tasks[0].tokens.totalTokens).toBe(1000);
 expect(result.pools[0]).toMatchObject({ weeklyLeftBefore: 90, weeklyLeftAfter: 86 });
 expect(result.rates[0].tokens).toBe(1000);
 expect(events.at(-1)?.usedPercent).toBe(14);
});
test('new samples are not halved, and mixed eras learn the same current rate', () => {
 const old = sample(cutoff - 100, cutoff - 10, 4), recent = sample(cutoff, cutoff + 10, 2);
 expect(analyzeUsage(recent, { settleMs: 0 }).tasks[0].estimate?.value).toBe(2);
 const reducer = createIncrementalUsageAnalyzer({ settleMs: 0 });
 reducer.analyze(old);
 const events = [...old, ...recent];
 const result = reducer.analyze(events);
 expect(result).toEqual(analyzeUsage(events, { settleMs: 0 }));
 expect(result.tasks[0].estimate?.value).toBe(2);
 expect(result.rates[0].tokens).toBe(2000);
});
test('straddling intervals cannot calibrate either capacity', () => {
 const result = analyzeUsage(sample(cutoff - 5, cutoff + 5, 4), { settleMs: 0 });
 expect(result.observations).toBe(0);
 expect(result.pools[0].status).toBe('excluded');
 expect(result.tasks[0].estimate).toBeNull();
});
test('other plans and provider allowance pools remain unchanged', () => {
 for (const [plan, limit] of [['plus','codex'], ['max','claude-code'], ['prolite','copilot'], ['prolite','codex-dot'], ['business','codex'], ['', 'codex']]) {
  expect(analyzeUsage(sample(cutoff-100, cutoff-10, 4, plan, limit), { settleMs: 0 }).tasks[0].estimate?.value).toBe(4);
 }
});
test('both allowance windows apply the historical conversion independently', () => {
 const events = sample(cutoff - 100, cutoff - 10, 4).map(e => ({ ...e, windowDurationMins: 300 }));
 expect(analyzeUsage(events, { settleMs: 0, windowDurationMins: 300 }).tasks[0].estimate?.value).toBe(2);
});
