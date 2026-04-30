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
import { randomUUID } from 'crypto';

import type {
  BlobStorage,
  JournalEntry,
  JournalReadResult,
  JournalStorage,
  KVStorage,
  StorageProvider,
} from './storage-interface.js';

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
      fs.renameSync(tmp, p);
    },

    exists(key: string): boolean {
      return fs.existsSync(resolve(key));
    },

    remove(key: string): void {
      const p = resolve(key);
      try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch { /* best-effort */ }
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
      fs.renameSync(tmp, p);
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

export function createFsStorageProvider(boardDir: string, journalFile: string): StorageProvider {
  return {
    blob:    createFsBlobStorage(boardDir),
    kv:      createFsKvStorage(path.join(boardDir, '.kv')),
    journal: createFsJournalStorage(path.join(boardDir, journalFile)),
  };
}
