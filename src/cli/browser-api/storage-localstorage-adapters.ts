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

import type { BlobStorage, KVStorage, JSONStorage, ScratchStorage } from '../common/storage-interface.js';
import type { JournalStorageAdapter, CardStorageAdapter, JournalEntry } from '../common/board-live-cards-lib.js';
import { createJsonStorage, createCardStorageAdapter } from '../common/board-live-cards-storage.js';

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

    renameKey(from: string, to: string): boolean {
      const raw = globalThis.localStorage.getItem(key(from));
      if (raw === null) return false;
      globalThis.localStorage.setItem(key(to), raw);
      globalThis.localStorage.removeItem(key(from));
      return true;
    },
  };
}

// ============================================================================
// createLocalStorageScratchStorage
// ============================================================================

const LS_SCRATCH_MARKER_SUFFIX = ':scratch-marker';
const LS_SCRATCH_CONFIG_SUFFIX = ':scratch-config';
const LS_SCRATCH_ENTRY_INFIX = ':scratch:';
const LS_DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const LS_DEFAULT_SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000;
const LS_SWEEP_WALL_TIME_BUDGET_MS = 200;

function sanitizeLsScratchSegment(s: string | undefined, fallback: string): string {
  if (!s) return fallback;
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : fallback;
}

export function createLocalStorageScratchStorage(prefix: string): ScratchStorage {
  const markerKey = `${prefix}${LS_SCRATCH_MARKER_SUFFIX}`;
  const configKey = `${prefix}${LS_SCRATCH_CONFIG_SUFFIX}`;
  const entryKey = (id: string) => `${prefix}${LS_SCRATCH_ENTRY_INFIX}${id}`;
  const timestampKey = (id: string) => `${prefix}${LS_SCRATCH_ENTRY_INFIX}${id}:__ts`;

  const wasNewlyMarked = globalThis.localStorage.getItem(markerKey) === null;
  if (wasNewlyMarked) {
    try { globalThis.localStorage.setItem(markerKey, `scratch-store\n${new Date().toISOString()}`); } catch { /* best-effort */ }
  }

  function readConfigBag(): Record<string, unknown> {
    const raw = globalThis.localStorage.getItem(configKey);
    if (raw === null) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch { return {}; }
  }

  function writeConfigBag(bag: Record<string, unknown>): void {
    try { globalThis.localStorage.setItem(configKey, JSON.stringify(bag)); } catch { /* best-effort */ }
  }

  if (wasNewlyMarked) {
    const bag = readConfigBag();
    if (typeof bag['retention.lastSweepAt'] !== 'number') {
      bag['retention.lastSweepAt'] = Date.now();
      writeConfigBag(bag);
    }
  }

  function maybeSweep(): void {
    if (globalThis.localStorage.getItem(markerKey) === null) return;
    const bag = readConfigBag();
    const maxAgeMs = typeof bag['retention.maxAgeMs'] === 'number'
      ? (bag['retention.maxAgeMs'] as number)
      : LS_DEFAULT_MAX_AGE_MS;
    const sweepIntervalMs = typeof bag['retention.sweepIntervalMs'] === 'number'
      ? (bag['retention.sweepIntervalMs'] as number)
      : LS_DEFAULT_SWEEP_INTERVAL_MS;
    if (maxAgeMs <= 0 || sweepIntervalMs <= 0) return;
    const lastSweepAt = typeof bag['retention.lastSweepAt'] === 'number'
      ? (bag['retention.lastSweepAt'] as number)
      : 0;
    const now = Date.now();
    if (now - lastSweepAt < sweepIntervalMs) return;

    bag['retention.lastSweepAt'] = now;
    writeConfigBag(bag);

    const sweepStart = now;
    const entryPrefix = `${prefix}${LS_SCRATCH_ENTRY_INFIX}`;
    const candidates: string[] = [];
    for (let i = 0; i < globalThis.localStorage.length; i++) {
      const k = globalThis.localStorage.key(i);
      if (k && k.startsWith(entryPrefix) && !k.endsWith(':__ts')) candidates.push(k);
    }
    for (const k of candidates) {
      if (Date.now() - sweepStart > LS_SWEEP_WALL_TIME_BUDGET_MS) break;
      const tsRaw = globalThis.localStorage.getItem(`${k}:__ts`);
      const ts = tsRaw === null ? 0 : Number(tsRaw);
      if (Number.isFinite(ts) && ts > 0 && now - ts > maxAgeMs) {
        try { globalThis.localStorage.removeItem(k); } catch { /* best-effort */ }
        try { globalThis.localStorage.removeItem(`${k}:__ts`); } catch { /* best-effort */ }
      }
    }
  }

  function genKey(p?: string, s?: string): string {
    const safePrefix = sanitizeLsScratchSegment(p, 'scratch');
    const safeSuffix = sanitizeLsScratchSegment(s, '.json');
    const dotted = safeSuffix.startsWith('.') ? safeSuffix : `.${safeSuffix}`;
    const rand = Math.random().toString(36).slice(2, 10);
    return `${safePrefix}-${Date.now()}-${rand}${dotted}`;
  }

  function writeEntry(id: string, content: string): void {
    globalThis.localStorage.setItem(entryKey(id), content);
    globalThis.localStorage.setItem(timestampKey(id), String(Date.now()));
  }

  return {
    read(id: string): string | null {
      return globalThis.localStorage.getItem(entryKey(id));
    },
    write(id: string, content: string): void {
      writeEntry(id, content);
      try { maybeSweep(); } catch { /* best-effort */ }
    },
    exists(id: string): boolean {
      return globalThis.localStorage.getItem(entryKey(id)) !== null;
    },
    remove(id: string): void {
      try { globalThis.localStorage.removeItem(entryKey(id)); } catch { /* best-effort */ }
      try { globalThis.localStorage.removeItem(timestampKey(id)); } catch { /* best-effort */ }
    },
    readBytes(id: string): Uint8Array | null {
      const raw = globalThis.localStorage.getItem(entryKey(id));
      if (raw === null) return null;
      return new TextEncoder().encode(raw);
    },
    writeBytes(id: string, content: Uint8Array): void {
      let bin = '';
      for (let i = 0; i < content.length; i++) bin += String.fromCharCode(content[i]);
      writeEntry(id, bin);
      try { maybeSweep(); } catch { /* best-effort */ }
    },
    stat(id: string) {
      const raw = globalThis.localStorage.getItem(entryKey(id));
      if (raw === null) return null;
      const tsRaw = globalThis.localStorage.getItem(timestampKey(id));
      const ts = tsRaw === null ? null : Number(tsRaw);
      return {
        key: id,
        size: new TextEncoder().encode(raw).byteLength,
        updatedAt: ts !== null && Number.isFinite(ts) ? new Date(ts).toISOString() : undefined,
      };
    },
    listKeys(filterPrefix?: string): string[] {
      const entryPrefix = `${prefix}${LS_SCRATCH_ENTRY_INFIX}`;
      const out: string[] = [];
      for (let i = 0; i < globalThis.localStorage.length; i++) {
        const k = globalThis.localStorage.key(i);
        if (k && k.startsWith(entryPrefix) && !k.endsWith(':__ts')) {
          const id = k.slice(entryPrefix.length);
          if (!filterPrefix || id.startsWith(filterPrefix)) out.push(id);
        }
      }
      return out.sort();
    },
    getUniqueKey(p?: string, s?: string): string { return genKey(p, s); },
    create(data: string, p?: string, s?: string): string {
      const id = genKey(p, s);
      writeEntry(id, data);
      try { maybeSweep(); } catch { /* best-effort */ }
      return id;
    },
    keyRef(id: string) {
      return { kind: 'local-storage-scratch', value: id, extra: { prefix } };
    },

    renameKey(from: string, to: string): boolean {
      const raw = globalThis.localStorage.getItem(entryKey(from));
      if (raw === null) return false;
      writeEntry(to, raw);
      try { globalThis.localStorage.removeItem(entryKey(from)); } catch { /* best-effort */ }
      try { globalThis.localStorage.removeItem(timestampKey(from)); } catch { /* best-effort */ }
      return true;
    },
    config: {
      get(k: string): unknown { return readConfigBag()[k] ?? null; },
      set(k: string, v: unknown): void {
        const bag = readConfigBag();
        if (v === undefined || v === null) delete bag[k];
        else bag[k] = v;
        writeConfigBag(bag);
      },
    },
  };
}

// ============================================================================
// createLocalStorageArchiveFactory
//
// localStorage layout under <prefix>:
//   <prefix>:archive-marker                 (safety guard)
//   <prefix>:archive-config                 (retention bag)
//   <prefix>:archive:stream:<name>          (JSON array of JournalEntry)
//   <prefix>:archive:blob:<name>:<key>      (blob namespace entries)
//
// Retention is disabled by default; embedders set 'retention.maxAgeMs' +
// 'retention.sweepIntervalMs' to enable. Each stream entry includes a `__ts`
// field used by the sweep.
// ============================================================================

const LS_ARCHIVE_MARKER_SUFFIX = ':archive-marker';
const LS_ARCHIVE_CONFIG_SUFFIX = ':archive-config';
const LS_ARCHIVE_STREAM_INFIX = ':archive:stream:';
const LS_ARCHIVE_BLOB_INFIX = ':archive:blob:';

function sanitizeLsArchiveSegment(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!cleaned) throw new Error('Archive segment name cannot be empty after sanitization');
  return cleaned;
}

export function createLocalStorageArchiveFactory(prefix: string): import('../common/storage-interface.js').ArchiveFactory {
  const markerKey = `${prefix}${LS_ARCHIVE_MARKER_SUFFIX}`;
  const configKey = `${prefix}${LS_ARCHIVE_CONFIG_SUFFIX}`;
  const streamKey = (name: string) => `${prefix}${LS_ARCHIVE_STREAM_INFIX}${name}`;

  if (globalThis.localStorage.getItem(markerKey) === null) {
    try { globalThis.localStorage.setItem(markerKey, `archive-store\n${new Date().toISOString()}`); } catch { /* best-effort */ }
  }

  function readConfigBag(): Record<string, unknown> {
    const raw = globalThis.localStorage.getItem(configKey);
    if (raw === null) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch { return {}; }
  }

  function writeConfigBag(bag: Record<string, unknown>): void {
    try { globalThis.localStorage.setItem(configKey, JSON.stringify(bag)); } catch { /* best-effort */ }
  }

  function maybeSweep(): void {
    if (globalThis.localStorage.getItem(markerKey) === null) return;
    const bag = readConfigBag();
    const maxAgeMs = typeof bag['retention.maxAgeMs'] === 'number' ? (bag['retention.maxAgeMs'] as number) : 0;
    const sweepIntervalMs = typeof bag['retention.sweepIntervalMs'] === 'number' ? (bag['retention.sweepIntervalMs'] as number) : 0;
    if (maxAgeMs <= 0 || sweepIntervalMs <= 0) return;
    const lastSweepAt = typeof bag['retention.lastSweepAt'] === 'number' ? (bag['retention.lastSweepAt'] as number) : 0;
    const now = Date.now();
    if (now - lastSweepAt < sweepIntervalMs) return;
    bag['retention.lastSweepAt'] = now;
    writeConfigBag(bag);

    const streamMarker = `${prefix}${LS_ARCHIVE_STREAM_INFIX}`;
    for (let i = 0; i < globalThis.localStorage.length; i++) {
      const k = globalThis.localStorage.key(i);
      if (!k || !k.startsWith(streamMarker)) continue;
      const raw = globalThis.localStorage.getItem(k);
      if (!raw) continue;
      try {
        const arr = JSON.parse(raw) as Array<{ id: string; payload: unknown; __ts?: number }>;
        const kept = arr.filter(e => typeof e.__ts !== 'number' || now - e.__ts <= maxAgeMs);
        if (kept.length !== arr.length) globalThis.localStorage.setItem(k, JSON.stringify(kept));
      } catch { /* best-effort */ }
    }
  }

  return {
    stream(name: string) {
      const safe = sanitizeLsArchiveSegment(name);
      const k = streamKey(safe);

      function load(): Array<{ id: string; payload: unknown; __ts?: number }> {
        const raw = globalThis.localStorage.getItem(k);
        if (!raw) return [];
        try { return JSON.parse(raw) as Array<{ id: string; payload: unknown; __ts?: number }>; } catch { return []; }
      }
      function save(arr: Array<{ id: string; payload: unknown; __ts?: number }>): void {
        try { globalThis.localStorage.setItem(k, JSON.stringify(arr)); } catch { /* best-effort */ }
      }

      return {
        append(payload: unknown) {
          const entry = { id: globalThis.crypto.randomUUID(), payload, __ts: Date.now() };
          const arr = load();
          arr.push(entry);
          save(arr);
          try { maybeSweep(); } catch { /* best-effort */ }
          return { id: entry.id, payload: entry.payload };
        },
        readAll() {
          return load().map(e => ({ id: e.id, payload: e.payload }));
        },
        readAfter(cursor: string | null) {
          const all = load();
          if (!cursor) {
            const entries = all.map(e => ({ id: e.id, payload: e.payload }));
            return { entries, newCursor: entries.length > 0 ? entries[entries.length - 1].id : null };
          }
          const idx = all.findIndex(e => e.id === cursor);
          const tail = idx === -1 ? all : all.slice(idx + 1);
          const entries = tail.map(e => ({ id: e.id, payload: e.payload }));
          return { entries, newCursor: entries.length > 0 ? entries[entries.length - 1].id : cursor };
        },
        clear() { try { globalThis.localStorage.removeItem(k); } catch { /* best-effort */ } },
      };
    },

    blob(name: string) {
      const safe = sanitizeLsArchiveSegment(name);
      const inner = createLocalStorageBlobStorage(`${prefix}${LS_ARCHIVE_BLOB_INFIX}${safe}`);
      return {
        read: (key: string) => inner.read(key),
        write: (key: string, content: string) => {
          inner.write(key, content);
          try { maybeSweep(); } catch { /* best-effort */ }
        },
        exists: (key: string) => inner.exists(key),
        remove: (key: string) => inner.remove(key),
        readBytes: inner.readBytes ? (key: string) => inner.readBytes!(key) : undefined,
        writeBytes: inner.writeBytes ? (key: string, content: Uint8Array) => {
          inner.writeBytes!(key, content);
          try { maybeSweep(); } catch { /* best-effort */ }
        } : undefined,
        listKeys: (pfx?: string) => inner.listKeys(pfx),
        stat: inner.stat ? (key: string) => inner.stat!(key) : undefined,
        renameKey: (from: string, to: string) => inner.renameKey(from, to),
      };
    },

    listStreams(pfx?: string): string[] {
      const marker = `${prefix}${LS_ARCHIVE_STREAM_INFIX}`;
      const out: string[] = [];
      for (let i = 0; i < globalThis.localStorage.length; i++) {
        const k = globalThis.localStorage.key(i);
        if (!k || !k.startsWith(marker)) continue;
        const name = k.slice(marker.length);
        if (!pfx || name.startsWith(pfx)) out.push(name);
      }
      return out.sort();
    },

    listBlobs(pfx?: string): string[] {
      const marker = `${prefix}${LS_ARCHIVE_BLOB_INFIX}`;
      const seen = new Set<string>();
      for (let i = 0; i < globalThis.localStorage.length; i++) {
        const k = globalThis.localStorage.key(i);
        if (!k || !k.startsWith(marker)) continue;
        const tail = k.slice(marker.length);
        const colonIdx = tail.indexOf(':');
        const name = colonIdx === -1 ? tail : tail.slice(0, colonIdx);
        if (!pfx || name.startsWith(pfx)) seen.add(name);
      }
      return Array.from(seen).sort();
    },

    config: {
      get(k: string): unknown { return readConfigBag()[k] ?? null; },
      set(k: string, v: unknown): void {
        const bag = readConfigBag();
        if (v === undefined || v === null) delete bag[k];
        else bag[k] = v;
        writeConfigBag(bag);
      },
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

// createLocalStorageJsonStorage — delegates to platform-neutral createJsonStorage
export function createLocalStorageJsonStorage(prefix: string): JSONStorage {
  return createJsonStorage(createLocalStorageKvStorage(prefix));
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
// createLocalStorageCardStorageAdapter — delegates to platform-neutral createCardStorageAdapter
// ============================================================================

export function createLocalStorageCardStorageAdapter(prefix: string): CardStorageAdapter {
  return createCardStorageAdapter(createLocalStorageJsonStorage(prefix), computeStableJsonHashBrowser);
}
