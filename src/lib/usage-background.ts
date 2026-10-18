import { analyzeUsage, type UsageEvent } from './usage-analysis';
import { usageModelName } from './model-display';
import { hostQuery } from './protocol';

export type UsageAnalysis = ReturnType<typeof analyzeUsage>;
export interface UsageAnalyses { weekly: UsageAnalysis; fiveHour: UsageAnalysis }

/** Lives in the worker: raw journals and JSON parsing never enter UI state. */
export function createUsageHistory(fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch) {
 let events: UsageEvent[] = [];
 let cursor = '';
 let revision = 0;
 let previous: { key: string; revision: number; result: UsageAnalyses } | null = null;
 return {
  async refresh(host: string, names: Record<string, string>): Promise<UsageAnalyses> {
   const query = new URLSearchParams(hostQuery(host).slice(1));
   query.set('incremental', '1');
   if (cursor) query.set('cursor', cursor);
   const response = await fetcher(`/api/usage?${query}`, { signal: AbortSignal.timeout(15_000) });
   if (!response.ok) throw new Error(`Could not load usage history (${response.status})`);
   const data = await response.json();
   const incoming: UsageEvent[] = data.events ?? [];
   // Legacy responses are complete snapshots; this also keeps older servers usable.
   const reset = data.reset !== false;
   if (reset || incoming.length) {
    events = reset ? incoming : events.concat(incoming);
    revision++;
   }
   cursor = data.cursor ?? '';
   const key = JSON.stringify([host, Object.entries(names).sort(([a], [b]) => a.localeCompare(b))]);
   if (previous?.key === key && previous.revision === revision) return previous.result;
   const modelName = (model: string) => usageModelName(names, model);
   const result = { weekly: analyzeUsage(events, { host, modelName }), fiveHour: analyzeUsage(events, { host, modelName, windowDurationMins: 300 }) };
   previous = { key, revision, result };
   return result;
  }
 };
}
