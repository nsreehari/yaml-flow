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

import type { BlobStorage, KVStorage, JSONStorage } from '../common/storage-interface.js';
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
  const textEncoder = new TextEncoder();

  function encodeBytes(bytes: Uint8Array): string {
    if (typeof btoa === 'function') {
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    }
    return '';
  }

  function decodeBytes(encoded: string): Uint8Array {
    if (typeof atob === 'function') {
      const bin = atob(encoded);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new Uint8Array();
  }

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

    readBytes(k: string): Uint8Array | null {
      const raw = globalThis.localStorage.getItem(key(k));
      if (raw === null) return null;
      try {
        const parsed = JSON.parse(raw) as { __kind?: string; data?: string };
        if (parsed && parsed.__kind === 'bytes-b64' && typeof parsed.data === 'string') {
          return decodeBytes(parsed.data);
        }
      } catch {
        // fall through to plain text path
      }
      return textEncoder.encode(raw);
    },

    writeBytes(k: string, content: Uint8Array): void {
      // Store binary payloads as base64 envelope to avoid lossy UTF-8 coercion.
      const envelope = JSON.stringify({ __kind: 'bytes-b64', data: encodeBytes(content) });
      globalThis.localStorage.setItem(key(k), envelope);
    },

    listKeys(prefix2?: string): string[] {
      const marker = key(prefix2 ?? '');
      const out: string[] = [];
      for (let i = 0; i < globalThis.localStorage.length; i++) {
        const k = globalThis.localStorage.key(i);
        if (k && k.startsWith(marker)) out.push(k.slice(key('').length));
      }
      return out.sort();
    },

    stat(k: string) {
      const raw = globalThis.localStorage.getItem(key(k));
      if (raw === null) return null;
      let size = textEncoder.encode(raw).byteLength;
      try {
        const parsed = JSON.parse(raw) as { __kind?: string; data?: string };
        if (parsed && parsed.__kind === 'bytes-b64' && typeof parsed.data === 'string') {
          size = decodeBytes(parsed.data).byteLength;
        }
      } catch {
        // plain text path
      }
      return { key: k, size };
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

function deepMergeObjects(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v) &&
        result[k] !== null && typeof result[k] === 'object' && !Array.isArray(result[k])) {
      result[k] = deepMergeObjects(result[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      result[k] = v;
    }
  }
  return result;
}

function applyJsonPath(obj: Record<string, unknown>, segments: string[], value: unknown): Record<string, unknown> {
  if (segments.length === 0) return obj;
  const [head, ...tail] = segments;
  if (tail.length === 0) return { ...obj, [head]: value };
  const nested = (obj[head] !== null && typeof obj[head] === 'object' && !Array.isArray(obj[head]))
    ? (obj[head] as Record<string, unknown>)
    : {};
  return { ...obj, [head]: applyJsonPath(nested, tail, value) };
}

export function createLocalStorageJsonStorage(prefix: string): JSONStorage {
  const kv = createLocalStorageKvStorage(prefix);
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
    listKeys: (prefix2?) => kv.listKeys(prefix2),
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
  const json = createLocalStorageJsonStorage(prefix);

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
      return computeStableJsonHashBrowser(card);
    },
    cardExists(id: string): boolean {
      return json.read(id) !== null;
    },
    defaultCardKey(cardId: string): string {
      return cardId;
    },
  };
}
