import type { UsageTask } from './usage-analysis';
import { contributingTaskTurns } from './task-usage';

/** Credits per million tokens: ordinary input, cached input, cache write, output. */
type Rates = readonly [number, number, number | null, number];
interface RateCard { base: Rates; threshold?: number; long?: Rates }
export const COPILOT_RATE_CARD_DATE = '2026-10-15';
// Supplied credit table, checked against GitHub's Models and pricing reference.
// These fixed prices never feed Codex/Claude subscription allowance learning.
const rates: Record<string, RateCard> = {
 'gpt-5-mini': { base: [25, 2.5, null, 200] },
 'gpt-5.3-codex': { base: [175, 17.5, null, 1400] },
 'gpt-5.4': { base: [250, 25, null, 1500], threshold: 272000, long: [500, 50, null, 2250] },
 'gpt-5.4-mini': { base: [75, 7.5, null, 450] },
 'gpt-5.4-nano': { base: [20, 2, null, 125] },
 'gpt-5.5': { base: [500, 50, null, 3000], threshold: 272000, long: [1000, 100, null, 4500] },
 'gpt-5.6-luna': { base: [20, 2, 25, 120], threshold: 200000, long: [40, 4, 50, 180] },
 'gpt-5.6-sol': { base: [400, 40, 500, 2000], threshold: 272000, long: [800, 80, 1000, 3000] },
 'gpt-5.6-terra': { base: [200, 20, 250, 1200], threshold: 272000, long: [400, 40, 500, 1800] },
 'gpt-6-astra': { base: [1000, 100, 1250, 5000], threshold: 272000, long: [2000, 200, 2500, 7500] },
 'gpt-6-luna': { base: [10, 1, 12.5, 50], threshold: 272000, long: [20, 2, 25, 75] },
 'gpt-6-sol': { base: [200, 20, 250, 1000], threshold: 272000, long: [400, 40, 500, 1500] },
 'gpt-6.1-sol': { base: [200, 10, 250, 1000], threshold: 272000, long: [400, 20, 500, 1500] },
 'claude-haiku-4.5': { base: [100, 10, 125, 500] },
 'claude-haiku-5.5': { base: [10, 1, 12.5, 50], threshold: 100000, long: [50, 5, 62.5, 250] },
 'claude-sonnet-4': { base: [300, 30, 375, 1500] },
 'claude-sonnet-4.6': { base: [300, 30, 375, 1500] },
 'claude-opus-4.8': { base: [500, 50, 625, 2500] },
 'claude-opus-5': { base: [500, 50, 625, 2500] },
 'claude-opus-5.5': { base: [400, 20, 500, 2000] },
 'claude-sonnet-5': { base: [200, 20, 250, 1000] },
 'claude-sonnet-5.5': { base: [200, 10, 250, 1000] },
 'claude-opus-4.8-fast': { base: [1000, 100, 1250, 5000] },
 'claude-fable-5': { base: [1000, 100, 1250, 5000] },
 'claude-fable-5.1': { base: [1000, 25, 1250, 5000] },
 'gemini-3.7-flash': { base: [75, 7.5, null, 375] },
 'gemini-3.8-flash': { base: [75, 7.5, null, 375] },
 'gemini-4-argon': { base: [200, 10, null, 1000] },
 'mai-code-1.1-flash': { base: [20, 2, null, 120] },
 ...Object.fromEntries(['4.5', '4.6', '4.7'].map(version => [`grok-${version}`, { base: [200, 50, null, 600] as Rates, threshold: 200000, long: [400, 100, null, 1200] as Rates }])),
 'kimi-k3': { base: [300, 30, null, 1500] }
};

export interface CopilotCreditEstimate {
 low: number | null;
 high: number | null;
 incomplete: boolean;
 notes: string[];
}

function modelKey(model: string) {
 return model.replace(/^copilot(?:\s*[·:/|—–-]\s*|\s+)/i, '').split(' · ')[0].trim().toLowerCase()
  .replace(/\s*\(fast mode(?:, preview)?\)/, '-fast').replace(/[ _]+/g, '-')
  .replace(/^(claude-(?:haiku|sonnet|opus|fable)-\d+)-(\d+)(?=-|$)/, '$1.$2');
}

/** Ordinary input rate, for stable price ordering within a maker. */
export function copilotInputRate(model: string): number | null {
 return rates[modelKey(model)]?.base[0] ?? null;
}

/** Compare the full rate cards; missing cache-write rates cannot prove dominance. */
export function copilotRatesNoHigher(other: string, model: string): boolean {
 const a = rates[modelKey(other)], b = rates[modelKey(model)];
 if (!a || !b) return false;
 const contexts = [0, ...[a.threshold, b.threshold].filter((n): n is number => n !== undefined).map(n => n + 1)];
 return contexts.every(context => {
  const ar = context > (a.threshold ?? Infinity) ? a.long ?? a.base : a.base;
  const br = context > (b.threshold ?? Infinity) ? b.long ?? b.base : b.base;
  return ar.every((price, index) => price === null || br[index] === null
   ? price === br[index] : price <= br[index]!);
 });
}

/** A token-based estimate, not GitHub's account balance or an invoice. */
export function copilotTaskCredits(tasks: UsageTask[], task: UsageTask): CopilotCreditEstimate {
 let low = 0, high = 0, priced = 0, incomplete = false;
 const notes = new Set<string>();
 for (const turn of contributingTaskTurns(tasks, task)) {
  const card = rates[modelKey(turn.model)];
  const { inputTokens: input, cachedInputTokens: cached, outputTokens: output, totalTokens: total } = turn.tokens;
  if (!card || ![input, cached, output, total].every(n => Number.isFinite(n) && n >= 0) || cached > input || total === 0) {
   incomplete = true; notes.add(!card ? `Pricing unavailable for ${turn.model}.` : 'Token recording is missing or invalid.'); continue;
  }
  const ordinary = input - cached;
  const candidates = [card.base];
  if (card.long && (input > (card.threshold ?? Infinity) || turn.partialTokens)) {
   candidates.push(card.long); notes.add('Per-request context tiers are unavailable; standard and long-context rates form the estimate range.');
  }
  const bounds = candidates.map(rate => ({
   low: (ordinary * Math.min(rate[0], rate[2] ?? rate[0]) + cached * rate[1] + output * rate[3]) / 1_000_000,
   high: (ordinary * Math.max(rate[0], rate[2] ?? rate[0]) + cached * rate[1] + output * rate[3]) / 1_000_000
  }));
  low += Math.min(...bounds.map(b => b.low)); high += Math.max(...bounds.map(b => b.high)); priced++;
  if (ordinary > 0 && card.base[2] !== null) notes.add('Cache writes are merged into input in current recordings; their split is estimated.');
  if (turn.partialTokens) { incomplete = true; notes.add('Partial recording: this is a known subtotal, not the full task cost.'); }
 }
 if (incomplete) notes.add('Some task or agent usage is missing or unpriced.');
 return { low: priced ? low : null, high: priced ? high : null, incomplete, notes: [...notes] };
}

export function creditLabel(estimate: CopilotCreditEstimate | null | undefined): string {
 if (estimate?.low == null || estimate.high == null) return 'Credit estimate unavailable';
 const format = (n: number) => n > 0 && n < .01 ? '<0.01' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
 const low = format(estimate.low), high = format(estimate.high);
 return `Est. ${low === high ? low : `${low}–${high}`} credits used${estimate.incomplete ? ' · incomplete' : ''}`;
}

export function creditTitle(estimate: CopilotCreditEstimate | null | undefined): string {
 return `Token-based estimate using Copilot rates dated ${COPILOT_RATE_CARD_DATE}. Includes recorded descendant work. ${estimate?.notes.join(' ') ?? 'Waiting for recorded token usage.'}`;
}
