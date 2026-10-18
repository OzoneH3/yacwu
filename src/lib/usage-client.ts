import type { UsageAnalyses } from './usage-background';

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, { resolve: (result: UsageAnalyses) => void; reject: (error: Error) => void }>();

/** Lazy singleton shared by the task indicators and the usage dialog. */
export function loadUsageAnalysis(host: string, names: Record<string, string>): Promise<UsageAnalyses> {
 if (!worker) {
  worker = new Worker(new URL('./usage-worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
   const request = pending.get(data.id);
   pending.delete(data.id);
   if (data.error) request?.reject(new Error(data.error));
   else request?.resolve(data.result);
  };
  worker.onerror = (event) => {
   for (const request of pending.values()) request.reject(new Error(event.message || 'Usage worker failed'));
   pending.clear(); worker?.terminate(); worker = null;
  };
 }
 const id = ++nextId;
 return new Promise((resolve, reject) => {
  pending.set(id, { resolve, reject });
  // Svelte model catalogs may be proxies, which structured clone cannot transfer.
  worker!.postMessage({ id, host, names: { ...names } });
 });
}
