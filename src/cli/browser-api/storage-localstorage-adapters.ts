/**
 * storage-localstorage-adapters.ts
 *
 * Browser localStorage implementations of the board-live-cards storage primitives:
 *   BlobStorage      — localStorage keys prefixed with `${prefix}:blob:`
 *   KVStorage        — localStorage keys prefixed with `${prefix}:kv:`, values JSON-encoded
 *   JournalStorageAdapter — single localStorage key holding a JSON array of entries
 *   CardStorageAdapter — KV-backed, compatible with createCardStore()
 *
 * No Node imports. Requires globalThis.localStorage (browser / jsdom environment).
 */

import type { BlobStorage, KVStorage } from '../common/storage-interface.js';
import type { JournalStorageAdapter, CardStorageAdapter, JournalEntry, LiveCard, CardIndex } from '../common/board-live-cards-lib.js';

// ============================================================================
// Stable JSON + sync hash
// Used for card dedup and snapshot versioning. Not security-sensitive.
// ============================================================================

function stableJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${(value as unknown[]).map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

function fnv32a(str: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Synchronous stable content hash for browser environments.
 * Uses four FNV-1a 32-bit passes to produce 32 hex chars.
 * Deterministic and cross-session stable; NOT cryptographically secure.
 */
export function computeStableJsonHashBrowser(value: unknown): string {
  const str = stableJson(value);
  const a = fnv32a(str, 0x811c9dc5);
  const b = fnv32a(str, 0xdeadbeef);
  const c = fnv32a(str, 0x01234567);
  const d = fnv32a(str, 0xfeedface);
  return [a, b, c, d].map(n => n.toString(16).padStart(8, '0')).join('');
}

// ============================================================================
// createLocalStorageBlobStorage
// ============================================================================

export function createLocalStorageBlobStorage(prefix: string): BlobStorage {
  function key(k: string): string { return `${prefix}:blob:${k}`; }

  return {
    read(k: string): string | null {
      return globalThis.localStorage.getItem(key(k));
    },
    write(k: string, content: string): void {
      globalThis.localStorage.setItem(key(k), content);
    },
    exists(k: string): boolean {
      return globalThis.localStorage.getItem(key(k)) !== null;
    },
    remove(k: string): void {
      globalThis.localStorage.removeItem(key(k));
    },
  };
}

// ============================================================================
// createLocalStorageKvStorage
// ============================================================================

export function createLocalStorageKvStorage(prefix: string): KVStorage {
  function key(k: string): string { return `${prefix}:kv:${k}`; }

  return {
    read(k: string): unknown | null {
      const raw = globalThis.localStorage.getItem(key(k));
      if (raw === null) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    write(k: string, value: unknown): void {
      globalThis.localStorage.setItem(key(k), JSON.stringify(value));
    },
    delete(k: string): void {
      globalThis.localStorage.removeItem(key(k));
    },
    listKeys(prefix2?: string): string[] {
      const fullPrefix = key(prefix2 ?? '');
      const result: string[] = [];
      for (let i = 0; i < globalThis.localStorage.length; i++) {
        const lsKey = globalThis.localStorage.key(i);
        if (lsKey !== null && lsKey.startsWith(fullPrefix)) {
          // Strip the outer prefix + ':kv:' to return the logical key
          result.push(lsKey.slice(key('').length));
        }
      }
      return result;
    },
  };
}

// ============================================================================
// createLocalStorageJournalStorageAdapter
// All entries stored as a JSON array under a single localStorage key.
// ============================================================================

export function createLocalStorageJournalStorageAdapter(storageKey: string): JournalStorageAdapter {
  function load(): JournalEntry[] {
    const raw = globalThis.localStorage.getItem(storageKey);
    if (!raw) return [];
    try { return JSON.parse(raw) as JournalEntry[]; } catch { return []; }
  }

  function save(entries: JournalEntry[]): void {
    globalThis.localStorage.setItem(storageKey, JSON.stringify(entries));
  }

  return {
    readAllEntries(): JournalEntry[] {
      return load();
    },
    appendEntry(entry: JournalEntry): void {
      const entries = load();
      entries.push(entry);
      save(entries);
    },
    generateId(): string {
      return globalThis.crypto.randomUUID();
    },
  };
}

// ============================================================================
// createLocalStorageCardStorageAdapter
// Mirrors createFsCardStorageAdapter — KV-backed, cards keyed by cardId.
// ============================================================================

export function createLocalStorageCardStorageAdapter(prefix: string): CardStorageAdapter {
  const kv = createLocalStorageKvStorage(prefix);

  return {
    readIndex(): CardIndex | null {
      return kv.read('_index') as CardIndex | null;
    },
    writeIndex(index: CardIndex): void {
      kv.write('_index', index);
    },
    readCard(id: string): LiveCard | null {
      return kv.read(id) as LiveCard | null;
    },
    writeCard(id: string, card: LiveCard): string {
      kv.write(id, card);
      return computeStableJsonHashBrowser(card);
    },
    cardExists(id: string): boolean {
      return kv.read(id) !== null;
    },
    defaultCardKey(cardId: string): string {
      return cardId;
    },
  };
}
