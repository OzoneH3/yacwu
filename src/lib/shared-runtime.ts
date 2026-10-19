const PREFIX = 'yacwu-runtime-v1:';
const MAX_AGE = 14_000;
interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void; readonly length: number; key(index: number): string | null }
interface Locks { request<T>(name: string, callback: () => Promise<T>): Promise<T> }
/** Locks serialize concurrent tabs; only small runtime metadata enters storage. */
export function createSharedRuntime(fetcher: typeof fetch, storage: StorageLike | null, locks?: Locks, now = Date.now) {
 let cleanedAt = -Infinity;
 const keyFor = (url: string) => PREFIX + url;
 const read = (key: string) => { try { return storage?.getItem(key) ?? null; } catch { return null; } };
 const write = (key: string, value: string) => { try { storage?.setItem(key, value); } catch { /* private mode/quota: ordinary reads still work */ } };
 return {
  invalidate(url: string) { write(keyFor(url), JSON.stringify({ at: now(), invalid: true, nonce: Math.random() })); },
  async load(url: string): Promise<any> {
   const run = async () => {
    const key = keyFor(url), previous = read(key);
    try {
     const saved = previous && JSON.parse(previous);
     if (saved && !saved.invalid && saved.data?.thread && now() >= saved.at && now() - saved.at < MAX_AGE) return saved.data;
    } catch { /* malformed cache is ignored */ }
    const response = await fetcher(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error(`Runtime check failed (${response.status})`);
    const data = await response.json();
    // A streamed turn transition while fetching invalidates this snapshot.
    if (data?.thread && read(key) === previous) write(key, JSON.stringify({ at: now(), data }));
    if (storage && now() - cleanedAt > 60_000) {
     cleanedAt = now();
     try {
      const entries: { key: string; at: number }[] = [];
      for (let i = 0; i < storage.length; i++) {
       const name = storage.key(i);
       if (name?.startsWith(PREFIX)) {
        try { entries.push({ key: name, at: JSON.parse(read(name) ?? '{}').at ?? 0 }); }
        catch { entries.push({ key: name, at: 0 }); }
       }
      }
      entries.sort((a, b) => b.at - a.at).forEach((entry, index) => {
       if (index >= 256 || now() - entry.at > 60_000) storage.removeItem(entry.key);
      });
     } catch { /* cache maintenance is optional */ }
    }
    return data;
   };
   return locks ? locks.request(keyFor(url), run) : run();
  }
 };
}
