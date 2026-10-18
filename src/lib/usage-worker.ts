/// <reference lib="webworker" />
import { createUsageHistory } from './usage-background';
import { createUsageResponder, type UsageRequest } from './usage-rpc';
import { journalCache } from './usage-cache';
const history = createUsageHistory(fetch, journalCache);
const respond = createUsageResponder(history.refresh);
// One cursor and journal across hosts; serialize reads to avoid overlapping deltas.
let queue = Promise.resolve();
self.onmessage = ({ data }: MessageEvent<UsageRequest>) => {
 queue = queue.then(async () => {
  try { self.postMessage(await respond(data)); }
  catch (error) { self.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) }); }
 });
};
