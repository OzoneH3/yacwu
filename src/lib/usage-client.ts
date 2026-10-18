import { USAGE_CACHE_LIMIT, usageAnalysisKey, type UsageAnalyses } from './usage-background';
import type { UsageReply } from './usage-rpc';

type Cached = { version: number; result: UsageAnalyses };

export function createUsageClient(makeWorker: () => Worker) {
 let worker: Worker | null = null;
 let nextId = 0;
 const cache = new Map<string, Cached>();
 const loading = new Map<string, Promise<UsageAnalyses>>();
 const pending = new Map<number, { key: string; cached?: Cached; resolve: (result: UsageAnalyses) => void; reject: (error: Error) => void }>();
 return (host: string, names: Record<string, string>): Promise<UsageAnalyses> => {
  // Svelte catalogs may be proxies: flatten before structured cloning.
  names = { ...names };
  const key = usageAnalysisKey(host, names);
  const existing = loading.get(key);
  if (existing) return existing;
  if (!worker) {
   try { worker = makeWorker(); } catch (error) { return Promise.reject(error); }
   const current = worker;
   worker.onmessage = ({ data }: MessageEvent<UsageReply & { error?: string }>) => {
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) { request.reject(new Error(data.error)); return; }
    const result = data.unchanged && request.cached?.version === data.version ? request.cached.result : data.result;
    if (!result) { request.reject(new Error('Usage worker returned an unknown revision')); return; }
    cache.delete(request.key); cache.set(request.key, { version: data.version, result });
    while (cache.size > USAGE_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
    request.resolve(result);
   };
   const failed = (message: string) => {
    if (worker !== current) return;
    for (const request of pending.values()) request.reject(new Error(message));
    pending.clear(); cache.clear(); current.terminate(); worker = null;
   };
   worker.onerror = event => failed(event.message || 'Usage worker failed');
   worker.onmessageerror = () => failed('Usage worker reply could not be decoded');
  }
  const current = worker;
  const id = ++nextId;
  const cached = cache.get(key);
  const promise = new Promise<UsageAnalyses>((resolve, reject) => {
   pending.set(id, { key, cached, resolve, reject });
   try { current.postMessage({ id, host, names, knownVersion: cached?.version }); }
   catch (error) { pending.delete(id); reject(error); }
  }).finally(() => { loading.delete(key); });
  loading.set(key, promise);
  return promise;
 };
}

/** Lazy singleton shared by task indicators and the usage dialog. */
export const loadUsageAnalysis = createUsageClient(() => new Worker(new URL('./usage-worker.ts', import.meta.url), { type: 'module' }));
