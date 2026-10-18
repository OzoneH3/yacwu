/// <reference lib="webworker" />
import { createUsageHistory } from './usage-background';
const history = createUsageHistory();
// One cursor and journal across hosts; serialize reads to avoid overlapping deltas.
let queue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<{ id: number; host: string; names: Record<string, string> }>) => {
 queue = queue.then(async () => {
  try { self.postMessage({ id: data.id, result: await history.refresh(data.host, data.names) }); }
  catch (error) { self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) }); }
 });
};
