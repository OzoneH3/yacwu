import type { UsageCache } from './usage-background';
import type { UsageEvent } from './usage-analysis';

// Metadata only, no prompts or tool output. Cursor and chunks commit atomically.
// The server rejects stale cursors after rotation, truncation or replacement.
function open(): Promise<IDBDatabase> {
 return new Promise((resolve, reject) => {
  const request = indexedDB.open('yacwu-usage-journal', 1);
  request.onupgradeneeded = () => {
   request.result.createObjectStore('meta');
   request.result.createObjectStore('chunks', { autoIncrement: true });
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
 });
}

export const journalCache: UsageCache = {
 async load() {
  const db = await open();
  try {
   return await new Promise<{ cursor: string; events: UsageEvent[] } | null>((resolve, reject) => {
    const tx = db.transaction(['meta', 'chunks'], 'readonly');
    const cursor = tx.objectStore('meta').get('cursor');
    const chunks = tx.objectStore('chunks').getAll();
    tx.oncomplete = () => resolve(typeof cursor.result === 'string' ? { cursor: cursor.result, events: chunks.result.flat() } : null);
    tx.onabort = () => reject(tx.error);
   });
  } finally { db.close(); }
 },
 async save(update) {
  const db = await open();
  try {
   await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['meta', 'chunks'], 'readwrite');
    const meta = tx.objectStore('meta'), chunks = tx.objectStore('chunks');
    const cursor = meta.get('cursor');
    cursor.onsuccess = () => {
     // Another tab may have advanced the shared cache. Never mix its base
     // with our delta; keeping its complete older/newer snapshot is safe.
     if (!update.reset && cursor.result !== update.previousCursor) return;
     if (update.reset) chunks.clear();
     // Keep individual IndexedDB values manageable on the initial snapshot.
     for (let i = 0; i < update.events.length; i += 2000) chunks.add(update.events.slice(i, i + 2000));
     meta.put(update.cursor, 'cursor');
    };
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
   });
  } finally { db.close(); }
 }
};
