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
  QueueDeadLetterMessage,
  QueueLeasedMessage,
  QueueMessage,
  QueueStorage,
  KindValueRef,
  ScratchStorage,
  StorageProvider,
} from '../common/storage-interface.js';
import type {
  CardStorageAdapter,
  StateSnapshotStorageAdapter,
} from '../common/board-live-cards-lib.js';
import {
  createJsonStorage,
  createCardStorageAdapter,
  createStateSnapshotAdapter,
  createStorageProvider,
} from '../common/board-live-cards-storage.js';

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

    keyRef(key: string): KindValueRef {
      return { kind: 'fs-path', value: resolve(key) };
    },

    renameKey(from: string, to: string): boolean {
      const src = resolve(from);
      if (!fs.existsSync(src)) return false;
      const dst = resolve(to);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      renameSync(src, dst);
      return true;
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

    renameKey(from: string, to: string): boolean {
      if (!fs.existsSync(from)) return false;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      renameSync(from, to);
      return true;
    },
  };
}

// ============================================================================
// FsQueueStorage
// ============================================================================

type FsQueueRecord<T = unknown> = {
  id: string;
  body: T;
  enqueuedAt: string;
  attempt: number;
  leaseToken?: string;
  leaseExpiresAt?: string;
  reason?: string;
  dedupKey?: string;
};

function writeJsonAtomic(filePath: string, value: unknown): void {
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf-8');
  renameSync(tmp, filePath);
}

function readJsonFile<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T; } catch { return null; }
}

function listJsonFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => path.join(dir, name));
}

function queueRecordToMessage<T>(record: FsQueueRecord<T>): QueueMessage<T> {
  return {
    id: record.id,
    body: record.body,
    enqueuedAt: record.enqueuedAt,
    attempt: record.attempt,
  };
}

function queueRecordToLeased<T>(record: FsQueueRecord<T>): QueueLeasedMessage<T> {
  return {
    ...queueRecordToMessage(record),
    leaseToken: String(record.leaseToken || ''),
    leaseExpiresAt: String(record.leaseExpiresAt || ''),
  };
}

function queueRecordToDead<T>(record: FsQueueRecord<T>): QueueDeadLetterMessage<T> {
  return {
    ...queueRecordToMessage(record),
    reason: record.reason,
  };
}

export function createFsQueueStorage(rootDir: string): QueueStorage {
  const activeDir = path.join(rootDir, 'active');
  const leasedDir = path.join(rootDir, 'leased');
  const doneDir = path.join(rootDir, 'done');
  const deadDir = path.join(rootDir, 'dead');
  const stagedDir = path.join(rootDir, 'staged');
  for (const dir of [activeDir, leasedDir, doneDir, deadDir, stagedDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  function activePath(record: Pick<FsQueueRecord, 'id' | 'enqueuedAt'>): string {
    const stamp = String(record.enqueuedAt || new Date().toISOString()).replace(/[:.]/g, '-');
    return path.join(activeDir, `${stamp}-${record.id}.json`);
  }

  function leasedPath(messageId: string): string {
    return path.join(leasedDir, `${messageId}.json`);
  }

  function donePath(messageId: string): string {
    return path.join(doneDir, `${messageId}.json`);
  }

  function deadPath(messageId: string): string {
    return path.join(deadDir, `${messageId}.json`);
  }

  function stagedPath(messageId: string): string {
    return path.join(stagedDir, `${messageId}.json`);
  }

  function reviveExpiredLeases(): void {
    const now = Date.now();
    for (const filePath of listJsonFiles(leasedDir)) {
      const record = readJsonFile<FsQueueRecord>(filePath);
      if (!record?.leaseExpiresAt) continue;
      const expiresAt = Date.parse(record.leaseExpiresAt);
      if (Number.isNaN(expiresAt) || expiresAt > now) continue;
      const revived: FsQueueRecord = {
        id: record.id,
        body: record.body,
        enqueuedAt: record.enqueuedAt,
        attempt: record.attempt,
      };
      writeJsonAtomic(activePath(revived), revived);
      try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
    }
  }

  return {
    enqueue<T>(body: T): QueueMessage<T> {
      const record: FsQueueRecord<T> = {
        id: randomUUID(),
        body,
        enqueuedAt: new Date().toISOString(),
        attempt: 0,
      };
      writeJsonAtomic(activePath(record), record);
      return queueRecordToMessage(record);
    },

    enqueueMany<T>(bodies: T[]): QueueMessage<T>[] {
      return bodies.map((body) => this.enqueue(body));
    },

    enqueueIfAbsent<T>(body: T, dedupKey: string): QueueMessage<T> | null {
      reviveExpiredLeases();
      for (const dir of [activeDir, leasedDir, stagedDir]) {
        for (const filePath of listJsonFiles(dir)) {
          const existing = readJsonFile<FsQueueRecord>(filePath);
          if (existing?.dedupKey === dedupKey) return null;
        }
      }
      const record: FsQueueRecord<T> = {
        id: randomUUID(),
        body,
        enqueuedAt: new Date().toISOString(),
        attempt: 0,
        dedupKey,
      };
      writeJsonAtomic(activePath(record), record);
      return queueRecordToMessage(record);
    },

    lease<T>(opts?: { max?: number; visibilityMs?: number }): QueueLeasedMessage<T>[] {
      reviveExpiredLeases();
      const max = Math.max(1, Math.floor(opts?.max ?? 1));
      const visibilityMs = Math.max(1, Math.floor(opts?.visibilityMs ?? 60_000));
      const leased: QueueLeasedMessage<T>[] = [];
      for (const filePath of listJsonFiles(activeDir)) {
        if (leased.length >= max) break;
        const record = readJsonFile<FsQueueRecord<T>>(filePath);
        if (!record) continue;
        const claimedPath = leasedPath(record.id);
        try {
          renameSync(filePath, claimedPath);
        } catch {
          continue;
        }
        const claimed: FsQueueRecord<T> = {
          ...record,
          attempt: (Number(record.attempt) || 0) + 1,
          leaseToken: randomUUID(),
          leaseExpiresAt: new Date(Date.now() + visibilityMs).toISOString(),
        };
        writeJsonAtomic(claimedPath, claimed);
        leased.push(queueRecordToLeased(claimed));
      }
      return leased;
    },

    ack(messageId: string, leaseToken: string): boolean {
      const filePath = leasedPath(messageId);
      const record = readJsonFile<FsQueueRecord>(filePath);
      if (!record || record.leaseToken !== leaseToken) return false;
      try {
        renameSync(filePath, donePath(messageId));
      } catch {
        return false;
      }
      return true;
    },

    nack(messageId: string, leaseToken: string, opts?: { dead?: boolean; reason?: string }): boolean {
      const filePath = leasedPath(messageId);
      const record = readJsonFile<FsQueueRecord>(filePath);
      if (!record || record.leaseToken !== leaseToken) return false;
      const nextRecord: FsQueueRecord = {
        id: record.id,
        body: record.body,
        enqueuedAt: record.enqueuedAt,
        attempt: record.attempt,
      };
      if (opts?.dead) {
        nextRecord.reason = opts.reason;
        writeJsonAtomic(deadPath(messageId), nextRecord);
      } else {
        writeJsonAtomic(activePath(nextRecord), nextRecord);
      }
      try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
      return true;
    },

    peekActive<T>(_prefix?: string): QueueMessage<T>[] {
      reviveExpiredLeases();
      return listJsonFiles(activeDir)
        .map((filePath) => readJsonFile<FsQueueRecord<T>>(filePath))
        .filter((record): record is FsQueueRecord<T> => Boolean(record))
        .map(queueRecordToMessage);
    },

    peekDeadLetter<T>(_prefix?: string): QueueDeadLetterMessage<T>[] {
      return listJsonFiles(deadDir)
        .map((filePath) => readJsonFile<FsQueueRecord<T>>(filePath))
        .filter((record): record is FsQueueRecord<T> => Boolean(record))
        .map(queueRecordToDead);
    },

    stage<T>(body: T, opts?: { dedupKey?: string }): QueueMessage<T> | null {
      const dedupKey = opts?.dedupKey;
      if (dedupKey) {
        reviveExpiredLeases();
        for (const dir of [activeDir, leasedDir, stagedDir]) {
          for (const filePath of listJsonFiles(dir)) {
            const existing = readJsonFile<FsQueueRecord>(filePath);
            if (existing?.dedupKey === dedupKey) return null;
          }
        }
      }
      const record: FsQueueRecord<T> = {
        id: randomUUID(),
        body,
        enqueuedAt: new Date().toISOString(),
        attempt: 0,
        ...(dedupKey ? { dedupKey } : {}),
      };
      writeJsonAtomic(stagedPath(record.id), record);
      return queueRecordToMessage(record);
    },

    commitStaged(messageId: string): boolean {
      const filePath = stagedPath(messageId);
      const record = readJsonFile<FsQueueRecord>(filePath);
      if (!record) return false;
      const promoted: FsQueueRecord = {
        ...record,
        attempt: 0,
        enqueuedAt: new Date().toISOString(),
      };
      writeJsonAtomic(activePath(promoted), promoted);
      try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
      return true;
    },

    discardStaged(messageId: string, reason?: string): boolean {
      const filePath = stagedPath(messageId);
      const record = readJsonFile<FsQueueRecord>(filePath);
      if (!record) return false;
      const discarded: FsQueueRecord = {
        id: record.id,
        body: record.body,
        enqueuedAt: record.enqueuedAt,
        attempt: record.attempt,
        reason,
      };
      writeJsonAtomic(deadPath(messageId), discarded);
      try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
      return true;
    },

    peekStaged<T>(_prefix?: string): QueueMessage<T>[] {
      return listJsonFiles(stagedDir)
        .map((filePath) => readJsonFile<FsQueueRecord<T>>(filePath))
        .filter((record): record is FsQueueRecord<T> => Boolean(record))
        .map(queueRecordToMessage);
    },
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

    renameKey(from: string, to: string): boolean {
      if (!fs.existsSync(from)) return false;
      fs.mkdirSync(path.dirname(to), { recursive: true });
      renameSync(from, to);
      return true;
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
// FsArchiveFactory
//
// Long-lived archival store rooted at <archiveDir>. Layout:
//   <archiveDir>/__archive-marker         (safety guard; sweep refuses w/o it)
//   <archiveDir>/__archive-config.json    (retention bag)
//   <archiveDir>/streams/<name>.jsonl     (one JournalStorage per stream)
//   <archiveDir>/blobs/<name>/...         (one BlobStorage per namespace)
//
// Retention is disabled by default (archives are long-lived). Embedders may
// set 'retention.maxAgeMs' and 'retention.sweepIntervalMs' via config to
// enable best-effort sweep of stream and blob files older than maxAgeMs.
// ============================================================================

const ARCHIVE_MARKER_FILE = '__archive-marker';
const ARCHIVE_CONFIG_FILE = '__archive-config.json';
const ARCHIVE_STREAMS_DIR = 'streams';
const ARCHIVE_BLOBS_DIR = 'blobs';
const ARCHIVE_SWEEP_WALL_TIME_BUDGET_MS = 500;

function sanitizeArchiveSegment(s: string): string {
  const cleaned = s.replace(/[^A-Za-z0-9._-]/g, '_');
  if (!cleaned) throw new Error('Archive segment name cannot be empty after sanitization');
  return cleaned;
}

export function createFsArchiveFactory(archiveDir: string): import('../common/storage-interface.js').ArchiveFactory {
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.mkdirSync(path.join(archiveDir, ARCHIVE_STREAMS_DIR), { recursive: true });
  fs.mkdirSync(path.join(archiveDir, ARCHIVE_BLOBS_DIR), { recursive: true });
  const markerPath = path.join(archiveDir, ARCHIVE_MARKER_FILE);
  const configPath = path.join(archiveDir, ARCHIVE_CONFIG_FILE);
  if (!fs.existsSync(markerPath)) {
    try { fs.writeFileSync(markerPath, `archive-store\n${new Date().toISOString()}\n`, 'utf-8'); } catch { /* best-effort */ }
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

  function maybeSweep(): void {
    if (!fs.existsSync(markerPath)) return;
    const bag = readConfigBag();
    const maxAgeMs = typeof bag['retention.maxAgeMs'] === 'number' ? (bag['retention.maxAgeMs'] as number) : 0;
    const sweepIntervalMs = typeof bag['retention.sweepIntervalMs'] === 'number' ? (bag['retention.sweepIntervalMs'] as number) : 0;
    if (maxAgeMs <= 0 || sweepIntervalMs <= 0) return;
    const lastSweepAt = typeof bag['retention.lastSweepAt'] === 'number' ? (bag['retention.lastSweepAt'] as number) : 0;
    const now = Date.now();
    if (now - lastSweepAt < sweepIntervalMs) return;
    bag['retention.lastSweepAt'] = now;
    writeConfigBag(bag);

    const sweepStart = now;
    const walk = (root: string): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (Date.now() - sweepStart > ARCHIVE_SWEEP_WALL_TIME_BUDGET_MS) return;
        const full = path.join(root, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.isFile()) continue;
        try {
          const st = fs.statSync(full);
          if (now - st.mtimeMs > maxAgeMs) {
            try { fs.unlinkSync(full); } catch { /* best-effort */ }
          }
        } catch { /* best-effort */ }
      }
    };
    walk(path.join(archiveDir, ARCHIVE_STREAMS_DIR));
    walk(path.join(archiveDir, ARCHIVE_BLOBS_DIR));
  }

  return {
    stream(name: string) {
      const safe = sanitizeArchiveSegment(name);
      const streamPath = path.join(archiveDir, ARCHIVE_STREAMS_DIR, `${safe}.jsonl`);
      const inner = createFsJournalStorage(streamPath);
      return {
        append(payload: unknown): JournalEntry {
          const entry = inner.append(payload);
          try { maybeSweep(); } catch { /* best-effort */ }
          return entry;
        },
        readAll: () => inner.readAll(),
        readAfter: (cursor: string | null) => inner.readAfter(cursor),
        clear: () => { if (inner.clear) inner.clear(); },
      };
    },

    blob(name: string) {
      const safe = sanitizeArchiveSegment(name);
      const blobDir = path.join(archiveDir, ARCHIVE_BLOBS_DIR, safe);
      fs.mkdirSync(blobDir, { recursive: true });
      const inner = createFsBlobStorage(blobDir);
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
        listKeys: (prefix?: string) => inner.listKeys(prefix),
        stat: inner.stat ? (key: string) => inner.stat!(key) : undefined,
        renameKey: (from: string, to: string) => inner.renameKey(from, to),
      };
    },

    listStreams(prefix?: string): string[] {
      const dir = path.join(archiveDir, ARCHIVE_STREAMS_DIR);
      try {
        return fs.readdirSync(dir, { withFileTypes: true })
          .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
          .map(e => e.name.slice(0, -'.jsonl'.length))
          .filter(n => !prefix || n.startsWith(prefix))
          .sort();
      } catch { return []; }
    },

    listBlobs(prefix?: string): string[] {
      const dir = path.join(archiveDir, ARCHIVE_BLOBS_DIR);
      try {
        return fs.readdirSync(dir, { withFileTypes: true })
          .filter(e => e.isDirectory())
          .map(e => e.name)
          .filter(n => !prefix || n.startsWith(prefix))
          .sort();
      } catch { return []; }
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
// createFsJsonStorage — delegates to platform-neutral createJsonStorage
// ============================================================================

export function createFsJsonStorage(kvDir: string): JSONStorage {
  return createJsonStorage(createFsKvStorage(kvDir));
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
  return createStorageProvider(
    createFsBlobStorage(boardDir),
    createFsKvStorage(path.join(boardDir, '.kv')),
    createFsJournalStorage(path.join(boardDir, journalFile)),
  );
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
// createFsCardStorageAdapter — delegates to platform-neutral createCardStorageAdapter
// kvDir is the KV storage directory (used directly, no hidden subdirectory added).
// ============================================================================

export function createFsCardStorageAdapter(kvDir: string): CardStorageAdapter {
  return createCardStorageAdapter(createFsJsonStorage(kvDir), computeStableJsonHash);
}

// ============================================================================
// createFsStateSnapshotStorageAdapter — delegates to platform-neutral createStateSnapshotAdapter
// scopeId is a directory path; KV is scoped to <scopeDir>/.state-snapshot/
// ============================================================================

export function createFsStateSnapshotStorageAdapter(): StateSnapshotStorageAdapter {
  return createStateSnapshotAdapter(
    (scopeDir) => createFsKvStorage(path.join(scopeDir, '.state-snapshot')),
    computeStableJsonHash,
  );
}
