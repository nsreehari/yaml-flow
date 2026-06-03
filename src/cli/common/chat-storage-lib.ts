/**
 * chat-storage-lib.ts
 *
 * ChatStorage interface + factories backed by JournalStorage (history) and
 * KVStorage (processing state and config).
 *
 * Platform-free — no node:fs or node:crypto imports.
 */

import type { JournalEntry, JournalStorage, KVStorage } from './storage-interface.js';
import type { AsyncJournalStorage, AsyncKVStorage } from '../cloud/storage-async-interface.js';

type Awaitable<T> = T | Promise<T>;

// ============================================================================
// Public types
// ============================================================================

export interface ChatRecord {
  /** Journal entry id — also used as SSE cursor. */
  id: string;
  role: string;
  text: string;
  files: unknown[];
  turn: string;
  updated_at: string;
}

export interface ChatConfig {
  systemPrompt?: string;
}

export interface ChatReadAfterResult {
  records: ChatRecord[];
  /** Pass as cursor on the next call. Null when the journal is empty. */
  cursor: string | null;
}

export interface ChatStorage {
  // ── History (journal) ────────────────────────────────────────────────────

  /** Append a message; returns the new entry id (usable as a cursor). */
  append(cardId: string, role: string, text: string, files?: unknown[], turn?: string): Awaitable<string>;

  /** Read all messages in insertion order. */
  readAll(cardId: string): Awaitable<ChatRecord[]>;

  /**
   * Read messages appended after cursor.
   * Pass null to read from the beginning.
   */
  readAfter(cardId: string, cursor: string | null): Awaitable<ChatReadAfterResult>;

  /** Remove all messages for this card. */
  clear(cardId: string): Awaitable<void>;

  // ── State (KV) ───────────────────────────────────────────────────────────

  setProcessing(cardId: string, active: boolean): Awaitable<void>;
  isProcessing(cardId: string): Awaitable<boolean>;

  // ── Config (KV) ──────────────────────────────────────────────────────────

  getConfig(cardId: string): Awaitable<ChatConfig>;
  setConfig(cardId: string, patch: Partial<ChatConfig>): Awaitable<void>;
}

// ============================================================================
// createChatStorage — backed by JournalStorage + KVStorage
// ============================================================================

function safeCardKey(cardId: string): string {
  return String(cardId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function toRecord(entry: JournalEntry): ChatRecord {
  const p = (entry.payload ?? {}) as Record<string, unknown>;
  return {
    id: entry.id,
    role: typeof p.role === 'string' ? p.role : 'system',
    text: typeof p.text === 'string' ? p.text : '',
    files: Array.isArray(p.files) ? p.files : [],
    turn: typeof p.turn === 'string' ? p.turn : '',
    updated_at: typeof p.updated_at === 'string' ? p.updated_at : '',
  };
}

/**
 * Create a ChatStorage backed by:
 *  - journalFactory(cardId) → JournalStorage  (one per-card journal for history)
 *  - kv                     → KVStorage       (shared processing flags + config)
 */
export function createChatStorage(
  journalFactory: (cardId: string) => JournalStorage,
  kv: KVStorage,
): ChatStorage {
  const processingKey = (cardId: string) => `chats/${safeCardKey(cardId)}/processing`;
  const configKey = (cardId: string) => `chats/${safeCardKey(cardId)}/config`;

  return {
    append(cardId, role, text, files = [], turn = '') {
      const entry = journalFactory(cardId).append({
        role,
        text,
        files,
        turn,
        updated_at: new Date().toISOString(),
      });
      return entry.id;
    },

    readAll(cardId) {
      return journalFactory(cardId).readAll().map(toRecord);
    },

    readAfter(cardId, cursor) {
      const result = journalFactory(cardId).readAfter(cursor);
      return {
        records: result.entries.map(toRecord),
        cursor: result.newCursor,
      };
    },

    clear(cardId) {
      journalFactory(cardId).clear?.();
    },

    setProcessing(cardId, active) {
      if (active) kv.write(processingKey(cardId), true);
      else kv.delete(processingKey(cardId));
    },

    isProcessing(cardId) {
      return kv.read(processingKey(cardId)) === true;
    },

    getConfig(cardId) {
      return (kv.read(configKey(cardId)) as ChatConfig | null) ?? {};
    },

    setConfig(cardId, patch) {
      const existing = (kv.read(configKey(cardId)) as ChatConfig | null) ?? {};
      kv.write(configKey(cardId), { ...existing, ...patch });
    },
  };
}

export function createAsyncChatStorage(
  journalFactory: (cardId: string) => AsyncJournalStorage,
  kv: AsyncKVStorage,
): ChatStorage {
  const processingKey = (cardId: string) => `chats/${safeCardKey(cardId)}/processing`;
  const configKey = (cardId: string) => `chats/${safeCardKey(cardId)}/config`;

  return {
    async append(cardId, role, text, files = [], turn = '') {
      const entry = await journalFactory(cardId).append({
        role,
        text,
        files,
        turn,
        updated_at: new Date().toISOString(),
      });
      return entry.id;
    },

    async readAll(cardId) {
      return (await journalFactory(cardId).readAll()).map(toRecord);
    },

    async readAfter(cardId, cursor) {
      const result = await journalFactory(cardId).readAfter(cursor);
      return {
        records: result.entries.map(toRecord),
        cursor: result.newCursor,
      };
    },

    async clear(cardId) {
      await journalFactory(cardId).clear?.();
    },

    async setProcessing(cardId, active) {
      if (active) await kv.write(processingKey(cardId), true);
      else await kv.delete(processingKey(cardId));
    },

    async isProcessing(cardId) {
      return await kv.read(processingKey(cardId)) === true;
    },

    async getConfig(cardId) {
      return (await kv.read(configKey(cardId)) as ChatConfig | null) ?? {};
    },

    async setConfig(cardId, patch) {
      const existing = (await kv.read(configKey(cardId)) as ChatConfig | null) ?? {};
      await kv.write(configKey(cardId), { ...existing, ...patch });
    },
  };
}

// ============================================================================
// createInMemoryChatStorage — fully in-memory (tests + hosts that don't need
// persistent chat history)
// ============================================================================

function genId(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const crypto = (globalThis as any).crypto;
  if (typeof crypto?.randomUUID === 'function') return String(crypto.randomUUID());
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createInMemoryChatStorage(): ChatStorage {
  const journals = new Map<string, ChatRecord[]>();
  const kv = new Map<string, unknown>();

  function journal(cardId: string): ChatRecord[] {
    if (!journals.has(cardId)) journals.set(cardId, []);
    return journals.get(cardId)!;
  }

  return {
    append(cardId, role, text, files = [], turn = '') {
      const rec: ChatRecord = { id: genId(), role, text, files, turn, updated_at: new Date().toISOString() };
      journal(cardId).push(rec);
      return rec.id;
    },

    readAll(cardId) {
      return journal(cardId).slice();
    },

    readAfter(cardId, cursor) {
      const all = journal(cardId);
      if (!cursor) {
        return { records: all.slice(), cursor: all.length > 0 ? all[all.length - 1].id : null };
      }
      const idx = all.findIndex(e => e.id === cursor);
      const slice = idx === -1 ? all.slice() : all.slice(idx + 1);
      return {
        records: slice,
        cursor: slice.length > 0 ? slice[slice.length - 1].id : cursor,
      };
    },

    clear(cardId) { journals.set(cardId, []); },

    setProcessing(cardId, active) {
      if (active) kv.set(`p:${cardId}`, true);
      else kv.delete(`p:${cardId}`);
    },
    isProcessing(cardId) { return kv.get(`p:${cardId}`) === true; },

    getConfig(cardId) { return (kv.get(`c:${cardId}`) as ChatConfig | null) ?? {}; },
    setConfig(cardId, patch) {
      const existing = (kv.get(`c:${cardId}`) as ChatConfig | null) ?? {};
      kv.set(`c:${cardId}`, { ...existing, ...patch });
    },
  };
}
