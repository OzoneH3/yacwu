import { expect, test } from 'bun:test';
import { buildUsagePool, type UsageTask, type TokenTotals } from '../../src/lib/usage-analysis';

const tokens = (n: number): TokenTotals => ({ totalTokens: n, inputTokens: n, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 });
const task = (model: string, startedAt: number, endedAt: number | null) => ({ model, effort: 'high', startedAt, endedAt }) as UsageTask;

test('all pool states share grouping, clipped worker time, and copied token totals', () => {
 const counts = tokens(30);
 const interval = {
  baseline: { at: 10, host: 'local', event: 'quota', usedPercent: 20 },
  intervalTokens: { '["a","high"]': counts, '["b","high"]': tokens(5) },
  intervalTasks: new Map([
   ['one', { task: task('a', 0, 20), tokens: tokens(10) }],
   ['two', { task: task('a', 15, null), tokens: tokens(20) }],
   ['three', { task: task('b', 22, 25), tokens: tokens(5) }]
  ]),
  benchmarkInterval: 'benchmark'
 };
 for (const status of ['settled', 'excluded', 'accumulating'] as const) {
  const pool = buildUsagePool(interval, { at: 30, host: 'local', event: 'quota', usedPercent: 23 }, status)!;
  expect(pool).toMatchObject({ startedAt: 10, endedAt: 30, weeklyLeftBefore: 80, weeklyLeftAfter: 77, status, benchmark: true });
  expect(pool.groups.map(g => [g.model, g.contributors.length, g.peakWorkers, g.workerMs])).toEqual([['a', 2, 2, 25], ['b', 1, 1, 3]]);
  expect(pool.groups[0].tokens).toEqual(counts);
  expect(pool.groups[0].tokens).not.toBe(counts);
 }
 expect(buildUsagePool({ ...interval, baseline: null }, { at: 30, host: 'local', event: 'quota', usedPercent: 23 }, 'settled')).toBeNull();
 expect(buildUsagePool({ ...interval, intervalTasks: new Map() }, { at: 30, host: 'local', event: 'quota', usedPercent: 23 }, 'settled')).toBeNull();
 expect(buildUsagePool(interval, { at: 30, host: 'local', event: 'quota', usedPercent: NaN }, 'settled')).toBeNull();
});
