import { analyzeUsage, createIncrementalUsageAnalyzer, type UsageEvent } from './usage-analysis';
import { usageModelName } from './model-display';
import { hostQuery } from './protocol';

export type UsageAnalysis = ReturnType<typeof analyzeUsage>;
export interface UsageAnalyses { weekly: UsageAnalysis; fiveHour: UsageAnalysis }

export interface UsageCache {
 load(): Promise<{ cursor: string; events: UsageEvent[] } | null>;
 save(update: { previousCursor: string; cursor: string; reset: boolean; events: UsageEvent[] }): Promise<void>;
}

export const USAGE_CACHE_LIMIT = 4;
export const usageAnalysisKey = (host: string, names: Record<string, string>) =>
 JSON.stringify([host, Object.entries(names).sort(([a], [b]) => a.localeCompare(b))]);

/** Lives in the worker: raw journals and JSON parsing never enter UI state. */
export function createUsageHistory(fetcher: (input: string, init?: RequestInit) => Promise<Response> = fetch, cache?: UsageCache) {
 let events: UsageEvent[] = [];
 let cursor = '';
 let loaded = false;
 const entries = new Map<string, { revision: number; result: UsageAnalyses | null; weekly: ReturnType<typeof createIncrementalUsageAnalyzer>; fiveHour: ReturnType<typeof createIncrementalUsageAnalyzer> }>();
 let revision = 0;

 return {
  async refresh(host: string, names: Record<string, string>): Promise<UsageAnalyses> {
   if (!loaded) {
    loaded = true;
    try { const saved = await cache?.load(); if (saved) { events = saved.events; cursor = saved.cursor; } } catch { /* Cache is optional (private browsing, quota, eviction). */ }
   }
   const previousCursor = cursor;
   const query = new URLSearchParams(hostQuery(host).slice(1));
   query.set('incremental', '1');
   if (cursor) query.set('cursor', cursor);
   const response = await fetcher(`/api/usage?${query}`, { signal: AbortSignal.timeout(15_000) });
   if (!response.ok) throw new Error(`Could not load usage history (${response.status})`);
   const data = await response.json();
   const incoming: UsageEvent[] = data.events ?? [];
   // Legacy responses are complete snapshots; this also keeps older servers usable.
   const reset = data.reset !== false;
   if (reset) entries.clear();
   if (reset || incoming.length) {
    events = reset ? incoming : events.concat(incoming);
    revision++;
   }
   cursor = data.cursor ?? '';
   if (cursor && (reset || incoming.length || cursor !== previousCursor)) {
    try { await cache?.save({ previousCursor, cursor, reset, events: incoming }); } catch { /* A failed cache transaction never loses in-memory history. */ }
   }
   const key = usageAnalysisKey(host, names);
   let entry = entries.get(key);
   if (entry) entries.delete(key); // Touch LRU, including unchanged reads.
   else {
    const modelName = (model: string) => usageModelName(names, model);
    entry = { revision: -1, result: null, weekly: createIncrementalUsageAnalyzer({ host, modelName }), fiveHour: createIncrementalUsageAnalyzer({ host, modelName, windowDurationMins: 300 }) };
   }
   entries.set(key, entry);
   while (entries.size > USAGE_CACHE_LIMIT) entries.delete(entries.keys().next().value!);
   if (entry.revision === revision && entry.result) return entry.result;
   const result = { weekly: entry.weekly.analyze(events), fiveHour: entry.fiveHour.analyze(events) };
   entry.revision = revision; entry.result = result;
   return result;
  }
 };
}
