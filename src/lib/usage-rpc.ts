import type { UsageAnalyses } from './usage-background';

export interface UsageRequest { id: number; host: string; names: Record<string, string>; knownVersion?: number }
export type UsageReply = { id: number; version: number; result?: UsageAnalyses; unchanged?: true };

/** Object identity is the history cache's revision. Do not clone unchanged
 * task/pool graphs back to the main thread, even when callers switch hosts. */
export function createUsageResponder(refresh: (host: string, names: Record<string, string>) => Promise<UsageAnalyses>) {
 const versions = new WeakMap<UsageAnalyses, number>();
 let serial = 0;
 return async (request: UsageRequest): Promise<UsageReply> => {
  const result = await refresh(request.host, request.names);
  let version = versions.get(result);
  if (version === undefined) { version = ++serial; versions.set(result, version); }
  return request.knownVersion === version ? { id: request.id, version, unchanged: true } : { id: request.id, version, result };
 };
}
