import { expect, test } from 'bun:test';
import { createSharedRuntime } from '../../src/lib/shared-runtime';
function storage() {
 const map = new Map<string, string>();
 return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v); }, removeItem: (k: string) => { map.delete(k); }, get length() { return map.size; }, key: (i: number) => [...map.keys()][i] ?? null };
}
function locks() {
 let tail: Promise<unknown> = Promise.resolve();
 return { request<T>(_key: string, run: () => Promise<T>): Promise<T> { const result = tail.then(run); tail = result.catch(() => {}); return result; } };
}
test('tabs share runtime reads, expire them, and invalidate streamed transitions', async () => {
 let now = 0, calls = 0;
 const fetcher = (async () => { calls++; return Response.json({ thread: { id: 'one' } }); }) as unknown as typeof fetch;
 const store = storage(), lock = locks();
 const a = createSharedRuntime(fetcher, store, lock, () => now), b = createSharedRuntime(fetcher, store, lock, () => now);
 await Promise.all([a.load('/one'), b.load('/one')]); expect(calls).toBe(1);
 now = 15000; await b.load('/one'); expect(calls).toBe(2);
 a.invalidate('/one'); await b.load('/one'); expect(calls).toBe(3);
 await a.load('/two'); expect(calls).toBe(4);
});
test('an in-flight snapshot cannot overwrite a streamed invalidation', async () => {
 let release!: () => void, calls = 0;
 const fetcher = (async () => { calls++; if (calls === 1) await new Promise<void>(r => { release = r; }); return Response.json({ thread: { id: 'one' } }); }) as unknown as typeof fetch;
 const client = createSharedRuntime(fetcher, storage());
 const pending = client.load('/one'); client.invalidate('/one'); release(); await pending;
 await client.load('/one'); expect(calls).toBe(2);
});
test('failed requests are not cached and blocked storage falls back safely', async () => {
 let calls = 0;
 const fetcher = (async () => { calls++; return calls === 1 ? new Response('', { status: 503 }) : Response.json({ thread: { id: 'one' } }); }) as unknown as typeof fetch;
 const client = createSharedRuntime(fetcher, storage());
 await expect(client.load('/one')).rejects.toThrow('503'); await client.load('/one'); expect(calls).toBe(2);
 const blocked = { ...storage(), getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
 await createSharedRuntime(fetcher, blocked).load('/one'); expect(calls).toBe(3);
});
