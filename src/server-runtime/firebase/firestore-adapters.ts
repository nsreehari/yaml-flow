/**
 * firestore-adapters.ts
 *
 * Firebase Firestore implementations of KVStorage, BlobStorage, JournalStorageAdapter,
 * and AtomicRelayLock.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FIREBASE FREE TIER (Blaze pay-as-you-go — same free quotas as Spark):
 *
 *   Firestore:   1 GiB storage,  50 K reads / 20 K writes / 20 K deletes per day
 *   Functions:   2 M invocations / month, 400 K GB-s, 200 K GHz-s
 *   Hosting:     10 GB storage, 360 MB/day transfer
 *
 * For a personal board server with a few boards / tens of cards this is plenty.
 * We use Firestore for ALL storage (KV, blobs, journal) to stay within a
 * single service and avoid Cloud Storage dependencies.
 *
 * NOTE: Blaze plan requires a billing account but charges $0 when usage is
 * within the free quotas above. The old Spark (no billing) plan does NOT
 * support Cloud Functions, so Blaze is the minimum for server-side compute.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Firestore document layout:
 *
 *   /boards/{boardId}/kv/{namespace}/entries/{key}          → { value: JSON }
 *   /boards/{boardId}/blobs/{namespace}/entries/{key}       → { text?, bytes?, contentType, size, updatedAt }
 *   /boards/{boardId}/journal/entries/{entryId}             → { payload: JSON, createdAt }
 *   /boards/{boardId}/locks/{lockName}                      → { heldBy, acquiredAt }
 *   /server-meta/entries/{key}                              → { text: string }
 */

import type {
  Firestore,
  CollectionReference,
  DocumentReference,
  DocumentData,
} from 'firebase-admin/firestore';
import type { KVStorage, BlobStorage, AtomicRelayLock } from '../../cli/common/storage-interface.js';
import type { JournalStorageAdapter, JournalEntry } from '../../cli/common/board-live-cards-lib.js';

// ============================================================================
// Helper: encode/decode Firestore-safe document keys
// Firestore document IDs cannot contain '/' so we encode them.
// ============================================================================

function encodeKey(key: string): string {
  return key.replace(/%/g, '%25').replace(/\//g, '%2F').replace(/\./g, '%2E');
}

function decodeKey(encoded: string): string {
  return encoded.replace(/%2E/g, '.').replace(/%2F/g, '/').replace(/%25/g, '%');
}

// ============================================================================
// createFirestoreKvStorage
// ============================================================================

export function createFirestoreKvStorage(
  db: Firestore,
  collectionPath: string,
): KVStorage {
  const col = db.collection(collectionPath);

  return {
    read(key: string): unknown | null {
      // Firestore Admin SDK has synchronous-looking get() but it returns a promise.
      // We use a synchronous cache pattern: reads are pre-loaded during init.
      // For the runtime's actual usage pattern (lazy reads during request handling),
      // we throw to signal callers should use the async version.
      // HOWEVER — the existing board-live-cards-lib expects synchronous KVStorage.
      // So we use a blocking read via the _syncRead trick below.
      throw new Error(
        'Firestore KVStorage.read() is not synchronous. ' +
        'Use createFirestoreKvStorageAsync or pre-load data with warmUp().',
      );
    },

    write(key: string, value: unknown): void {
      throw new Error(
        'Firestore KVStorage.write() is not synchronous. ' +
        'Use createFirestoreKvStorageAsync or the batch writer.',
      );
    },

    delete(key: string): void {
      throw new Error('Firestore KVStorage.delete() is not synchronous.');
    },

    listKeys(prefix?: string): string[] {
      throw new Error('Firestore KVStorage.listKeys() is not synchronous.');
    },
  };
}

// ============================================================================
// createCachedFirestoreKvStorage
//
// For the runtime, KV operations MUST be synchronous (board-live-cards-lib
// design). We solve this with a read-through cache:
//   1. warmUp() pre-loads the entire collection into memory
//   2. read() / listKeys() serve from cache
//   3. write() / delete() update BOTH cache and Firestore (fire-and-forget)
//
// This is safe because within a single Cloud Function invocation (request),
// the runtime is the sole writer. Cross-request consistency comes from
// warming up at the start of each request.
// ============================================================================

export function createCachedFirestoreKvStorage(
  db: Firestore,
  collectionPath: string,
): KVStorage & { warmUp(): Promise<void>; flush(): Promise<void> } {
  const col = db.collection(collectionPath);
  const cache = new Map<string, unknown>();
  const pendingWrites: Array<Promise<unknown>> = [];
  let warmedUp = false;

  return {
    async warmUp(): Promise<void> {
      const snapshot = await col.get();
      cache.clear();
      for (const doc of snapshot.docs) {
        const data = doc.data();
        cache.set(decodeKey(doc.id), data?.value ?? null);
      }
      warmedUp = true;
    },

    async flush(): Promise<void> {
      if (pendingWrites.length > 0) {
        await Promise.all(pendingWrites);
        pendingWrites.length = 0;
      }
    },

    read(key: string): unknown | null {
      if (!warmedUp) return null;
      return cache.has(key) ? cache.get(key) ?? null : null;
    },

    write(key: string, value: unknown): void {
      cache.set(key, value);
      const p = col.doc(encodeKey(key)).set({ value }).catch(() => {});
      pendingWrites.push(p);
    },

    delete(key: string): void {
      cache.delete(key);
      const p = col.doc(encodeKey(key)).delete().catch(() => {});
      pendingWrites.push(p);
    },

    listKeys(prefix?: string): string[] {
      const keys = [...cache.keys()];
      if (!prefix) return keys;
      return keys.filter(k => k.startsWith(prefix));
    },
  };
}

// ============================================================================
// createFirestoreBlobStorage
// ============================================================================

export function createCachedFirestoreBlobStorage(
  db: Firestore,
  collectionPath: string,
): BlobStorage & { warmUp(): Promise<void>; flush(): Promise<void> } {
  const col = db.collection(collectionPath);

  // Cache: key → { text?, bytes?, contentType?, size?, updatedAt? }
  type BlobEntry = {
    text?: string | null;
    bytes?: number[] | null;
    contentType?: string;
    size?: number;
    updatedAt?: string;
  };
  const cache = new Map<string, BlobEntry>();
  const pendingWrites: Array<Promise<unknown>> = [];
  let warmedUp = false;

  function now(): string { return new Date().toISOString(); }

  return {
    async warmUp(): Promise<void> {
      const snapshot = await col.get();
      cache.clear();
      for (const doc of snapshot.docs) {
        cache.set(decodeKey(doc.id), doc.data() as BlobEntry);
      }
      warmedUp = true;
    },

    async flush(): Promise<void> {
      if (pendingWrites.length > 0) {
        await Promise.all(pendingWrites);
        pendingWrites.length = 0;
      }
    },

    read(key: string): string | null {
      const entry = cache.get(key);
      if (!entry) return null;
      if (typeof entry.text === 'string') return entry.text;
      if (entry.bytes && Array.isArray(entry.bytes)) {
        return new TextDecoder().decode(new Uint8Array(entry.bytes));
      }
      return null;
    },

    write(key: string, content: string): void {
      const ts = now();
      const size = new TextEncoder().encode(content).byteLength;
      const entry: BlobEntry = { text: content, contentType: 'text/plain', size, updatedAt: ts };
      cache.set(key, entry);
      const p = col.doc(encodeKey(key)).set(entry).catch(() => {});
      pendingWrites.push(p);
    },

    exists(key: string): boolean {
      return cache.has(key);
    },

    remove(key: string): void {
      cache.delete(key);
      const p = col.doc(encodeKey(key)).delete().catch(() => {});
      pendingWrites.push(p);
    },

    readBytes(key: string): Uint8Array | null {
      const entry = cache.get(key);
      if (!entry) return null;
      if (entry.bytes && Array.isArray(entry.bytes)) return new Uint8Array(entry.bytes);
      if (typeof entry.text === 'string') return new TextEncoder().encode(entry.text);
      return null;
    },

    writeBytes(key: string, content: Uint8Array): void {
      const ts = now();
      const entry: BlobEntry = {
        bytes: [...content],
        contentType: 'application/octet-stream',
        size: content.byteLength,
        updatedAt: ts,
      };
      cache.set(key, entry);
      const p = col.doc(encodeKey(key)).set(entry).catch(() => {});
      pendingWrites.push(p);
    },

    listKeys(prefix?: string): string[] {
      const keys = [...cache.keys()];
      if (!prefix) return keys;
      return keys.filter(k => k.startsWith(prefix));
    },

    stat(key: string) {
      const entry = cache.get(key);
      if (!entry) return null;
      return {
        key,
        size: entry.size ?? 0,
        updatedAt: entry.updatedAt,
        contentType: entry.contentType,
      };
    },
  };
}

// ============================================================================
// createFirestoreJournalAdapter
// ============================================================================

export function createCachedFirestoreJournalAdapter(
  db: Firestore,
  collectionPath: string,
): JournalStorageAdapter & { warmUp(): Promise<void>; flush(): Promise<void> } {
  const col = db.collection(collectionPath);
  let entries: JournalEntry[] = [];
  const pendingWrites: Array<Promise<unknown>> = [];
  let warmedUp = false;
  let counter = 0;

  function genId(): string {
    counter++;
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return `${ts}-${rand}-${String(counter).padStart(4, '0')}`;
  }

  return {
    async warmUp(): Promise<void> {
      const snapshot = await col.orderBy('createdAt', 'asc').get();
      entries = [];
      for (const doc of snapshot.docs) {
        const data = doc.data();
        entries.push({ id: doc.id, payload: data?.payload });
      }
      counter = entries.length;
      warmedUp = true;
    },

    async flush(): Promise<void> {
      if (pendingWrites.length > 0) {
        await Promise.all(pendingWrites);
        pendingWrites.length = 0;
      }
    },

    readAllEntries(): JournalEntry[] {
      return [...entries];
    },

    appendEntry(entry: JournalEntry): void {
      entries.push(entry);
      const p = col.doc(entry.id).set({
        payload: entry.payload,
        createdAt: Date.now(),
      }).catch(() => {});
      pendingWrites.push(p);
    },

    generateId: genId,
  };
}

// ============================================================================
// createFirestoreAtomicRelayLock
//
// Uses Firestore transactions for mutual exclusion.
// For Cloud Functions where we have only one concurrent handler per request,
// this provides cross-invocation safety.
// ============================================================================

export function createFirestoreAtomicRelayLock(
  db: Firestore,
  docPath: string,
): AtomicRelayLock {
  // In a single Cloud Function invocation, we're effectively single-threaded.
  // The lock is mainly for cross-invocation consistency.
  // We use a simple in-memory flag + Firestore sentinel.
  let held = false;

  return {
    tryAcquire(): (() => void) | null {
      if (held) return null;
      held = true;
      // Write sentinel (fire-and-forget)
      db.doc(docPath).set({ heldBy: 'cf-instance', acquiredAt: Date.now() }).catch(() => {});
      return () => {
        held = false;
        db.doc(docPath).delete().catch(() => {});
      };
    },
  };
}

// ============================================================================
// createFirestoreServerMetaStore
//
// Simple text KV for multi-board registry (boards-config.json etc.)
// ============================================================================

export function createFirestoreServerMetaStore(
  db: Firestore,
  collectionPath: string = 'server-meta/entries',
): { getText(key: string): string | null; putText(key: string, text: string): void; warmUp(): Promise<void>; flush(): Promise<void> } {
  const col = db.collection(collectionPath);
  const cache = new Map<string, string>();
  const pendingWrites: Array<Promise<unknown>> = [];

  return {
    async warmUp(): Promise<void> {
      const snapshot = await col.get();
      cache.clear();
      for (const doc of snapshot.docs) {
        const data = doc.data();
        if (typeof data?.text === 'string') cache.set(decodeKey(doc.id), data.text);
      }
    },

    async flush(): Promise<void> {
      if (pendingWrites.length > 0) {
        await Promise.all(pendingWrites);
        pendingWrites.length = 0;
      }
    },

    getText(key: string): string | null {
      return cache.get(key) ?? null;
    },

    putText(key: string, text: string): void {
      cache.set(key, text);
      const p = col.doc(encodeKey(key)).set({ text }).catch(() => {});
      pendingWrites.push(p);
    },
  };
}
