/**
 * board-live-cards-storage.ts
 *
 * Platform-neutral derived storage factories.
 *
 * Each factory takes one or more storage primitives (KVStorage, BlobStorage,
 * JournalStorage) and contains zero backend-specific code. They work
 * identically on Node fs, browser localStorage, Cosmos, or any other backend.
 *
 * Backend implementation files (storage-fs-adapters.ts, storage-localstorage-adapters.ts,
 * future storage-cosmos-adapters.ts, etc.) should call these instead of
 * duplicating the logic. The only thing each backend needs to implement is
 * the five primitives: KVStorage, BlobStorage, JournalStorage, QueueStorage,
 * and AtomicRelayLock.
 */

import type {
  BlobStorage,
  JSONStorage,
  JournalStorage,
  KVStorage,
  StorageProvider,
} from './storage-interface.js';
import type {
  CardIndex,
  CardStorageAdapter,
  LiveCard,
  StateSnapshotReadView,
  StateSnapshotStorageAdapter,
} from './board-live-cards-lib.js';

// ============================================================================
// Private helpers (used by createJsonStorage and createStateSnapshotAdapter)
// ============================================================================

function deepMergeObjects(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (
      v !== null && typeof v === 'object' && !Array.isArray(v) &&
      result[k] !== null && typeof result[k] === 'object' && !Array.isArray(result[k])
    ) {
      result[k] = deepMergeObjects(result[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

function applyJsonPath(
  obj: Record<string, unknown>,
  segments: string[],
  value: unknown,
): Record<string, unknown> {
  if (segments.length === 0) return obj;
  const [head, ...tail] = segments;
  if (tail.length === 0) return { ...obj, [head]: value };
  const nested =
    obj[head] !== null && typeof obj[head] === 'object' && !Array.isArray(obj[head])
      ? (obj[head] as Record<string, unknown>)
      : {};
  return { ...obj, [head]: applyJsonPath(nested, tail, value) };
}

// ============================================================================
// createJsonStorage — JSONStorage backed by any KVStorage
//
// Adds deepMerge, shallowMerge, and dot-path get/patch on top of raw KV.
//
// Replaces the duplicate implementations:
//   createFsJsonStorage(kvDir)              (storage-fs-adapters.ts)
//   createLocalStorageJsonStorage(prefix)   (storage-localstorage-adapters.ts)
// ============================================================================

export function createJsonStorage(kv: KVStorage): JSONStorage {
  return {
    read: (key) => kv.read(key),
    get(key, jsonPath) {
      const obj = kv.read(key);
      if (obj === null) return null;
      let current: unknown = obj;
      for (const segment of jsonPath.split('.').filter(Boolean)) {
        if (current === null || typeof current !== 'object' || Array.isArray(current)) return null;
        current = (current as Record<string, unknown>)[segment] ?? null;
      }
      return current ?? null;
    },
    write: (key, value) => kv.write(key, value),
    delete: (key) => kv.delete(key),
    listKeys: (prefix?) => kv.listKeys(prefix),
    shallowMerge(key, patch) {
      const existing = (kv.read(key) as Record<string, unknown> | null) ?? {};
      kv.write(key, { ...existing, ...patch });
    },
    deepMerge(key, patch) {
      const existing = (kv.read(key) as Record<string, unknown> | null) ?? {};
      kv.write(key, deepMergeObjects(existing, patch));
    },
    patch(key, jsonPath, value) {
      const existing = (kv.read(key) as Record<string, unknown> | null) ?? {};
      const segments = jsonPath.split('.').filter(Boolean);
      kv.write(key, applyJsonPath(existing, segments, value));
    },
  };
}

// ============================================================================
// createCardStorageAdapter — CardStorageAdapter backed by any JSONStorage
//
// Cards and the index are stored as JSON values in the KV layer.
// computeHash is injected so each backend can use its own hash implementation
// (e.g. SHA-256 on Node, FNV-1a in the browser, or a test stub).
//
// Replaces the duplicate implementations:
//   createFsCardStorageAdapter(kvDir)              (storage-fs-adapters.ts)
//   createLocalStorageCardStorageAdapter(prefix)   (storage-localstorage-adapters.ts)
// ============================================================================

export function createCardStorageAdapter(
  json: JSONStorage,
  computeHash: (v: unknown) => string,
): CardStorageAdapter {
  return {
    readIndex(): CardIndex | null {
      return json.read('_index') as CardIndex | null;
    },
    writeIndex(index: CardIndex): void {
      json.write('_index', index);
    },
    readCard(id: string): LiveCard | null {
      return json.read(id) as LiveCard | null;
    },
    writeCard(id: string, card: LiveCard): string {
      json.write(id, card);
      return computeHash(card);
    },
    removeCard(id: string): void {
      json.delete(id);
    },
    cardExists(id: string): boolean {
      return json.read(id) !== null;
    },
    defaultCardKey(cardId: string): string {
      return cardId;
    },
  };
}

// ============================================================================
// createStateSnapshotAdapter — StateSnapshotStorageAdapter backed by KVStorage
//
// kvFactory(scopeId) is called per read/write to obtain the KV store for that
// scope. This keeps the scopeId → KV mapping in the backend:
//   FS:    scopeId is a directory path, kvFactory joins it with '.state-snapshot'
//   Cloud: scopeId is an opaque ID, kvFactory looks up the right container/collection
//
// computeHash is injected for the same reasons as createCardStorageAdapter.
//
// Replaces createFsStateSnapshotStorageAdapter() (storage-fs-adapters.ts).
// ============================================================================

export function createStateSnapshotAdapter(
  kvFactory: (scopeId: string) => KVStorage,
  computeHash: (v: unknown) => string,
): StateSnapshotStorageAdapter {
  return {
    readValues(scopeId: string): StateSnapshotReadView {
      const kv = kvFactory(scopeId);
      const keys = kv.listKeys().sort();
      if (keys.length === 0) return { version: null, values: {} };
      const values: Record<string, unknown> = {};
      for (const key of keys) values[key] = kv.read(key);
      return { version: computeHash(values), values };
    },
    writeValues(scopeId: string, nextValues: Record<string, unknown>, deletedKeys: string[]): string {
      const kv = kvFactory(scopeId);
      for (const key of deletedKeys) kv.delete(key);
      for (const [key, value] of Object.entries(nextValues)) kv.write(key, value);
      return computeHash(nextValues);
    },
  };
}

// ============================================================================
// createStorageProvider — assemble three primitives into a StorageProvider bag
//
// Replaces createFsStorageProvider (storage-fs-adapters.ts) and any future
// per-backend equivalents. Backends just call this with their three primitives.
// ============================================================================

export function createStorageProvider(
  blob: BlobStorage,
  kv: KVStorage,
  journal: JournalStorage,
): StorageProvider {
  return { blob, kv, journal };
}
