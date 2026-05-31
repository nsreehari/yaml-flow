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
  StateSnapshotStorageAdapter,
} from './board-live-cards-lib.js';
import { createJsonStorageFromKV } from './board-live-cards-shared-json.js';
import { createStateSnapshotAdapterFromKV } from './board-live-cards-shared-snapshot-journal.js';

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
  return createJsonStorageFromKV(kv) as JSONStorage;
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
  return createStateSnapshotAdapterFromKV(kvFactory, computeHash) as StateSnapshotStorageAdapter;
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
