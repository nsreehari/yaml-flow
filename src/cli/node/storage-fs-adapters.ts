/**
 * storage-fs-adapters.ts
 *
 * Node fs implementations of the three StorageProvider primitives:
 *   FsBlobStorage   — files under a root directory, key segments → subdirectories
 *   FsKvStorage     — each key stored as a JSON file under a kv directory
 *   FsJournalStorage — append-only JSONL file
 *
 * All three are pure Node — no board-specific logic. They can be composed into
 * a StorageProvider and passed to any adapter factory.
 *
 * blobRef keys and KV keys must be logical (e.g. "cards/abc123.json"),
 * not physical fs paths. The adapters resolve them to fs paths internally.
 */

import * as fs from 'fs';
import * as path from 'path';
import { randomUUID, createHash } from 'crypto';
import { lockSync } from 'proper-lockfile';

/**
 * On Windows, renameSync can fail with EPERM/EBUSY when the destination file
 * is held open by another process. Retry with exponential back-off (~280ms max).
 */
function renameSync(src: string, dest: string): void {
  if (process.platform !== 'win32') { fs.renameSync(src, dest); return; }
  const delays = [10, 20, 40, 80, 160];
  for (let i = 0; i <= delays.length; i++) {
    try { fs.renameSync(src, dest); return; } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EBUSY') && i < delays.length) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delays[i]);
        continue;
      }
      throw err;
    }
  }
}

import type { GraphEvent } from '../../event-graph/types.js';
import type {
  AtomicRelayLock,
  BlobStorage,
  JournalEntry,
  JournalReadResult,
  JournalStorage,
  JSONStorage,
  KVStorage,
  ScratchStorage,
  StorageProvider,
} from '../common/storage-interface.js';
import type {
  CardIndex,
  LiveCard,
  StateSnapshotStorageAdapter,
  StateSnapshotReadView,
} from '../common/board-live-cards-lib.js';

// ============================================================================
// FsBlobStorage
//
// key "cards/abc123.json" → <rootDir>/cards/abc123.json
// write is atomic: write to tmp file then rename.
// ============================================================================

export function createFsBlobStorage(rootDir: string): BlobStorage {
  function resolve(key: string): string {
    return path.join(rootDir, ...key.split('/'));
  }

  function toKey(fullPath: string): string {
    const rel = path.relative(rootDir, fullPath).replace(/\\/g, '/');
    return rel;
  }

  function walk(dir: string, out: string[]): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p, out);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push(toKey(p));
    }
  }

  return {
    read(key: string): string | null {
      const p = resolve(key);
      if (!fs.existsSync(p)) return null;
      try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
    },

    write(key: string, content: string): void {
      const p = resolve(key);
      const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(tmp, content, 'utf-8');
      renameSync(tmp, p);
    },

    exists(key: string): boolean {
      return fs.existsSync(resolve(key));
    },

    remove(key: string): void {
      const p = resolve(key);
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* best-effort */ }
    },

    readBytes(key: string): Uint8Array | null {
      const p = resolve(key);
      if (!fs.existsSync(p)) return null;
      try { return new Uint8Array(fs.readFileSync(p)); } catch { return null; }
    },

    writeBytes(key: string, content: Uint8Array): void {
      const p = resolve(key);
      const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(tmp, Buffer.from(content));
      renameSync(tmp, p);
    },

    listKeys(prefix?: string): string[] {
      const all: string[] = [];
      walk(rootDir, all);
      const sorted = all.sort();
      if (!prefix) return sorted;
      return sorted.filter((k) => k.startsWith(prefix));
    },

    stat(key: string) {
      const p = resolve(key);
      if (!fs.existsSync(p)) return null;
      try {
        const st = fs.statSync(p);
        return {
          key,
          size: Number(st.size || 0),
          updatedAt: new Date(st.mtimeMs).toISOString(),
        };
      } catch {
        return null;
      }
    },
  };
}

/**
 * Create a BlobStorage where the key IS the absolute file path.
 * Implements the full BlobStorage interface (read, write, exists, remove).
 * Use this for operations on known absolute paths (e.g., temp file cleanup).
 */
export function createFsAbsolutePathBlobStorage(): BlobStorage {
  return {
    read(key: string): string | null {
      if (!fs.existsSync(key)) return null;
      try { return fs.readFileSync(key, 'utf-8'); } catch { return null; }
    },
    write(key: string, content: string): void {
      const tmp = `${key}.${process.pid}.${randomUUID()}.tmp`;
      fs.mkdirSync(path.dirname(key), { recursive: true });
      fs.writeFileSync(tmp, content, 'utf-8');
      renameSync(tmp, key);
    },
    exists(key: string): boolean {
      return fs.existsSync(key);
    },
    remove(key: string): void {
      try { if (fs.existsSync(key)) fs.unlinkSync(key); } catch { /* best-effort */ }
    },

    readBytes(key: string): Uint8Array | null {
      if (!fs.existsSync(key)) return null;
      try { return new Uint8Array(fs.readFileSync(key)); } catch { return null; }
    },

    writeBytes(key: string, content: Uint8Array): void {
      const tmp = `${key}.${process.pid}.${randomUUID()}.tmp`;
      fs.mkdirSync(path.dirname(key), { recursive: true });
      fs.writeFileSync(tmp, Buffer.from(content));
      renameSync(tmp, key);
    },

    stat(key: string) {
      if (!fs.existsSync(key)) return null;
      try {
        const st = fs.statSync(key);
        return {
          key,
          size: Number(st.size || 0),
          updatedAt: new Date(st.mtimeMs).toISOString(),
        };
      } catch {
        return null;
      }
    },

    // Keys are absolute paths — prefix-based listing is not meaningful for this adapter.
    listKeys(_prefix?: string): string[] { return []; },
  };
}

// ============================================================================
// FsScratchStorage
//
// Ephemeral blob store rooted at <scratchDir>. Keys are ABSOLUTE file paths
// under scratchDir, so child processes can be handed a raw fs path directly
// via { kind: 'fs-path', value: key }.
//
// Self-managed retention: every write/create checks whether sweepIntervalMs
// has elapsed since the last sweep and, if so, deletes entries older than
// maxAgeMs (best-effort, bounded). A marker file gates the sweep so that a
// misconfigured scratch dir pointing at someone's home directory cannot
// destroy unrelated files.
// ============================================================================

const SCRATCH_MARKER_FILE = '__scratch-marker';
const SCRATCH_CONFIG_FILE = '__scratch-config.json';
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;       // 24h
const DEFAULT_SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12h
const SWEEP_WALL_TIME_BUDGET_MS = 500;

function sanitizeScratchSegment(s: string | undefined, fallback: string): string {
  if (!s) return fallback;
  // Allow letters, digits, dot, dash, underscore; replace anything else.
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.length > 0 ? cleaned : fallback;
}

export function createFsScratchStorage(scratchDir: string): ScratchStorage {
  fs.mkdirSync(scratchDir, { recursive: true });
  const markerPath = path.join(scratchDir, SCRATCH_MARKER_FILE);
  const configPath = path.join(scratchDir, SCRATCH_CONFIG_FILE);
  const wasNewlyMarked = !fs.existsSync(markerPath);
  if (wasNewlyMarked) {
    try { fs.writeFileSync(markerPath, `scratch-store\n${new Date().toISOString()}\n`, 'utf-8'); } catch { /* best-effort */ }
  }

  function readConfigBag(): Record<string, unknown> {
    if (!fs.existsSync(configPath)) return {};
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch { return {}; }
  }

  function writeConfigBag(bag: Record<string, unknown>): void {
    const tmp = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(bag, null, 2), 'utf-8');
      renameSync(tmp, configPath);
    } catch { /* best-effort */ }
  }

  // Seed sentinel on first construction so a freshly created store doesn't
  // immediately sweep (gives in-flight callers a grace window).
  if (wasNewlyMarked) {
    const bag = readConfigBag();
    if (typeof bag['retention.lastSweepAt'] !== 'number') {
      bag['retention.lastSweepAt'] = Date.now();
      writeConfigBag(bag);
    }
  }

  function maybeSweep(): void {
    if (!fs.existsSync(markerPath)) return; // safety: never sweep an unmarked dir
    const bag = readConfigBag();
    const maxAgeMs = typeof bag['retention.maxAgeMs'] === 'number'
      ? (bag['retention.maxAgeMs'] as number)
      : DEFAULT_MAX_AGE_MS;
    const sweepIntervalMs = typeof bag['retention.sweepIntervalMs'] === 'number'
      ? (bag['retention.sweepIntervalMs'] as number)
      : DEFAULT_SWEEP_INTERVAL_MS;
    if (maxAgeMs <= 0 || sweepIntervalMs <= 0) return; // disabled
    const lastSweepAt = typeof bag['retention.lastSweepAt'] === 'number'
      ? (bag['retention.lastSweepAt'] as number)
      : 0;
    const now = Date.now();
    if (now - lastSweepAt < sweepIntervalMs) return;

    // CAS-style: claim the sweep slot before doing work so concurrent writers
    // don't all sweep at once.
    bag['retention.lastSweepAt'] = now;
    writeConfigBag(bag);

    const sweepStart = now;
    try {
      const entries = fs.readdirSync(scratchDir, { withFileTypes: true });
      for (const entry of entries) {
        if (Date.now() - sweepStart > SWEEP_WALL_TIME_BUDGET_MS) break;
        if (!entry.isFile()) continue;
        if (entry.name === SCRATCH_MARKER_FILE) continue;
        if (entry.name === SCRATCH_CONFIG_FILE) continue;
        const full = path.join(scratchDir, entry.name);
        try {
          const st = fs.statSync(full);
          if (now - st.mtimeMs > maxAgeMs) {
            try { fs.unlinkSync(full); } catch { /* best-effort */ }
          }
        } catch { /* best-effort */ }
      }
    } catch { /* best-effort */ }
  }

  function genKey(prefix?: string, suffix?: string): string {
    const safePrefix = sanitizeScratchSegment(prefix, 'scratch');
    const safeSuffix = sanitizeScratchSegment(suffix, '.json');
    // Suffix always begins with '.' for fs-path readability.
    const dotted = safeSuffix.startsWith('.') ? safeSuffix : `.${safeSuffix}`;
    const name = `${safePrefix}-${Date.now()}-${randomUUID().slice(0, 8)}${dotted}`;
    return path.join(scratchDir, name);
  }

  function writeAbsolute(key: string, content: string): void {
    const tmp = `${key}.${process.pid}.${randomUUID()}.tmp`;
    fs.mkdirSync(path.dirname(key), { recursive: true });
    fs.writeFileSync(tmp, content, 'utf-8');
    renameSync(tmp, key);
  }

  return {
    read(key: string): string | null {
      if (!fs.existsSync(key)) return null;
      try { return fs.readFileSync(key, 'utf-8'); } catch { return null; }
    },

    write(key: string, content: string): void {
      writeAbsolute(key, content);
      try { maybeSweep(); } catch { /* best-effort */ }
    },

    exists(key: string): boolean { return fs.existsSync(key); },

    remove(key: string): void {
      try { if (fs.existsSync(key)) fs.unlinkSync(key); } catch { /* best-effort */ }
    },

    readBytes(key: string): Uint8Array | null {
      if (!fs.existsSync(key)) return null;
      try { return new Uint8Array(fs.readFileSync(key)); } catch { return null; }
    },

    writeBytes(key: string, content: Uint8Array): void {
      const tmp = `${key}.${process.pid}.${randomUUID()}.tmp`;
      fs.mkdirSync(path.dirname(key), { recursive: true });
      fs.writeFileSync(tmp, Buffer.from(content));
      renameSync(tmp, key);
      try { maybeSweep(); } catch { /* best-effort */ }
    },

    stat(key: string) {
      if (!fs.existsSync(key)) return null;
      try {
        const st = fs.statSync(key);
        return { key, size: Number(st.size || 0), updatedAt: new Date(st.mtimeMs).toISOString() };
      } catch { return null; }
    },

    listKeys(prefix?: string): string[] {
      try {
        const entries = fs.readdirSync(scratchDir, { withFileTypes: true });
        const out: string[] = [];
        for (const e of entries) {
          if (!e.isFile()) continue;
          if (e.name === SCRATCH_MARKER_FILE || e.name === SCRATCH_CONFIG_FILE) continue;
          const full = path.join(scratchDir, e.name);
          if (!prefix || full.startsWith(prefix)) out.push(full);
        }
        return out.sort();
      } catch { return []; }
    },

    getUniqueKey(prefix?: string, suffix?: string): string {
      return genKey(prefix, suffix);
    },

    create(data: string, prefix?: string, suffix?: string): string {
      const key = genKey(prefix, suffix);
      writeAbsolute(key, data);
      try { maybeSweep(); } catch { /* best-effort */ }
      return key;
    },

    keyRef(key: string) {
      return { kind: 'fs-path', value: key };
    },

    config: {
      get(k: string): unknown {
        return readConfigBag()[k] ?? null;
      },
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
// FsKvStorage
//
// key "cards/abc123/runtime" → <kvDir>/cards/abc123/runtime.json
// Values are JSON-serialised on write and parsed on read.
// listKeys(prefix) does a recursive walk and filters by prefix.
// ============================================================================

export function createFsKvStorage(kvDir: string): KVStorage {
  function keyToPath(key: string): string {
    return path.join(kvDir, ...key.split('/')) + '.json';
  }

  function walkKeys(dir: string, relPrefix: string, prefix: string | undefined, results: string[]): void {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walkKeys(path.join(dir, entry.name), rel, prefix, results);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const key = rel.replace(/\.json$/, '');
      if (!prefix || key.startsWith(prefix)) results.push(key);
    }
  }

  return {
    read(key: string): unknown | null {
      const p = keyToPath(key);
      if (!fs.existsSync(p)) return null;
      try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
    },

    write(key: string, value: unknown): void {
      const p = keyToPath(key);
      const tmp = `${p}.${process.pid}.${randomUUID()}.tmp`;
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
      renameSync(tmp, p);
    },

    delete(key: string): void {
      const p = keyToPath(key);
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* best-effort */ }
    },

    listKeys(prefix?: string): string[] {
      const results: string[] = [];
      walkKeys(kvDir, '', prefix, results);
      return results.sort();
    },
  };
}

// ============================================================================
// FsJournalStorage
//
// Each entry is a JSON line: { "id": "<uuid>", "payload": <any> }
// readAfter(cursor) returns all entries after the entry with id === cursor.
// A null/empty cursor returns all entries from the beginning.
// ============================================================================

export function createFsJournalStorage(journalPath: string): JournalStorage {
  function readLines(): JournalEntry[] {
    if (!fs.existsSync(journalPath)) return [];
    const content = fs.readFileSync(journalPath, 'utf-8').trim();
    if (!content) return [];
    return content.split('\n').filter(Boolean).map(l => JSON.parse(l) as JournalEntry);
  }

  return {
    append(payload: unknown): JournalEntry {
      const entry: JournalEntry = { id: randomUUID(), payload };
      fs.mkdirSync(path.dirname(journalPath), { recursive: true });
      fs.appendFileSync(journalPath, JSON.stringify(entry) + '\n', 'utf-8');
      return entry;
    },

    readAll(): JournalEntry[] {
      return readLines();
    },

    readAfter(cursor: string | null): JournalReadResult {
      const all = readLines();
      if (!cursor) {
        return { entries: all, newCursor: all.length > 0 ? all[all.length - 1].id : null };
      }
      const idx = all.findIndex(e => e.id === cursor);
      const entries = idx === -1 ? all : all.slice(idx + 1);
      return {
        entries,
        newCursor: entries.length > 0 ? entries[entries.length - 1].id : cursor,
      };
    },

    clear(): void {
      if (fs.existsSync(journalPath)) fs.truncateSync(journalPath, 0);
    },
  };
}

// ============================================================================
// createFsStorageProvider
//
// Convenience factory that wires up all three fs adapters under a board directory:
//   blob    → boardDir (card/source blobs resolved relative to boardDir)
//   kv      → boardDir/.kv/
//   journal → boardDir/<journalFile>
// ============================================================================

// ============================================================================
// computeStableJsonHash — canonical content hash for any value
//
// Used by card-commands to dedup upserts without needing node:crypto at the
// pure-logic layer.
// ============================================================================

function stableJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${(value as unknown[]).map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

export function computeStableJsonHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

// ============================================================================
// createFsJsonStorage — KVStorage with JSON-aware merge and patch operations
// ============================================================================

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

export function createFsJsonStorage(kvDir: string): JSONStorage {
  const kv = createFsKvStorage(kvDir);
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
// createFsJournalStorageAdapter — JournalStorageAdapter backed by a JSONL file
// ============================================================================

export function createFsJournalStorageAdapter(boardDir: string): {
  readAllEntries(): { id: string; event: GraphEvent }[];
  appendEntry(entry: { id: string; event: GraphEvent }): void;
  generateId(): string;
} {
  const journalPath = path.join(boardDir, 'board-journal.jsonl');
  return {
    readAllEntries() {
      if (!fs.existsSync(journalPath)) return [];
      const content = fs.readFileSync(journalPath, 'utf-8').trim();
      if (!content) return [];
      return content.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: string; event: GraphEvent });
    },
    appendEntry(entry) {
      fs.appendFileSync(journalPath, JSON.stringify(entry) + '\n', 'utf-8');
    },
    generateId() { return randomUUID(); },
  };
}

export function createFsStorageProvider(boardDir: string, journalFile: string): StorageProvider {
  return {
    blob:    createFsBlobStorage(boardDir),
    kv:      createFsKvStorage(path.join(boardDir, '.kv')),
    journal: createFsJournalStorage(path.join(boardDir, journalFile)),
  };
}

/**
 * FS implementation of AtomicRelayLock.
 * Uses proper-lockfile on the given file path as the lock target.
 * tryAcquire() is non-blocking (retries: 0) — returns null immediately if busy.
 */
export function createFsAtomicRelayLock(lockTargetPath: string): AtomicRelayLock {
  return {
    tryAcquire() {
      try {
        // proper-lockfile requires the target file to exist before locking.
        if (!fs.existsSync(lockTargetPath)) {
          fs.mkdirSync(path.dirname(lockTargetPath), { recursive: true });
          try { fs.writeFileSync(lockTargetPath, '{}', { flag: 'wx' }); } catch { /* race: another init won */ }
        }
        return lockSync(lockTargetPath, { retries: 0 });
      } catch {
        return null;
      }
    },
  };
}

// ============================================================================
// createFsCardStorageAdapter — KV-backed card storage
// kvDir is the KV storage directory (used directly, no hidden subdirectory added).
// ============================================================================

export function createFsCardStorageAdapter(kvDir: string): {
  readIndex(): CardIndex | null;
  writeIndex(index: CardIndex): void;
  readCard(key: string): LiveCard | null;
  writeCard(key: string, card: LiveCard): string;
  cardExists(key: string): boolean;
  defaultCardKey(cardId: string): string;
} {
  const json = createFsJsonStorage(kvDir);
  return {
    readIndex() {
      return json.read('_index') as CardIndex | null;
    },
    writeIndex(index) {
      json.write('_index', index);
    },
    readCard(id) {
      return json.read(id) as LiveCard | null;
    },
    writeCard(id, card) {
      json.write(id, card);
      return computeStableJsonHash(card);
    },
    cardExists(id) {
      return json.read(id) !== null;
    },
    defaultCardKey(cardId) {
      return cardId;
    },
  };
}

// ============================================================================
// createFsStateSnapshotStorageAdapter — KV-backed state snapshot storage
// Each key stored under <scopeDir>/.state-snapshot/
// ============================================================================

export function createFsStateSnapshotStorageAdapter(): StateSnapshotStorageAdapter {
  return {
    readValues(scopeDir: string): StateSnapshotReadView {
      const kv = createFsKvStorage(path.join(scopeDir, '.state-snapshot'));
      const keys = kv.listKeys().sort();
      if (keys.length === 0) return { version: null, values: {} };
      const values: Record<string, unknown> = {};
      for (const key of keys) values[key] = kv.read(key);
      return { version: computeStableJsonHash(values), values };
    },
    writeValues(scopeDir: string, nextValues: Record<string, unknown>, deletedKeys: string[]): string {
      const kv = createFsKvStorage(path.join(scopeDir, '.state-snapshot'));
      for (const key of deletedKeys) kv.delete(key);
      for (const [key, value] of Object.entries(nextValues)) kv.write(key, value);
      return computeStableJsonHash(nextValues);
    },
  };
}
