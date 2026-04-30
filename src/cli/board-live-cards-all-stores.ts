/**
 * board-live-cards-all-stores — Pure store logic for cards and journal.
 *
 * Zero platform imports. All storage is injected via adapter interfaces.
 * Platform implementations (Node fs, CosmosDB, localStorage, Python) are
 * provided by the CLI entry point and passed in at construction time.
 */

import type { KVStorage } from './storage-interface.js';
import type { GraphEvent } from '../event-graph/types.js';
// ============================================================================
// Card store — types
// ============================================================================

export interface LiveCard {
  id: string;
  [key: string]: unknown;
}

export interface CardIndexEntry {
  /** Storage-specific address (file path, Cosmos doc id, localStorage key). */
  key: string;
  /** Checksum of card content — computed by the adapter at write time. */
  checksum: string;
  updatedAt: string;
}

export type CardIndex = Record<string, CardIndexEntry>;
export type CardChecksumIndex = Record<string, string>;

/**
 * Per-card entry stored in the card-upsert KV cache (one key per cardId).
 * Lives alongside the board journal — NOT inside the board snapshot.
 * Purpose: dedup gate to avoid redundant task-upsert journal entries.
 *
 * Write order: journal.append() THEN kv.write() — so a crash between the two
 * leaves the journal entry intact (board is correct) and the KV stale (next
 * upsert will see "changed" and re-append; addNode is idempotent in the board).
 */
export interface CardUpsertIndexEntry {
  /** Logical reference to the card blob — absolute path for fs, blob name for cloud. */
  blobRef: string;
  /** SHA-256 of stable-JSON-serialised taskConfig. Dedup key. */
  taskConfigHash: string;
  updatedAt: string;
}

// ============================================================================
// CardStorageAdapter — injected by the caller
// ============================================================================

export interface CardStorageAdapter {
  readIndex(): CardIndex | null;
  writeIndex(index: CardIndex): void;
  readCard(key: string): LiveCard | null;
  /** Write card content; returns checksum of what was written. */
  writeCard(key: string, card: LiveCard): string;
  cardExists(key: string): boolean;
  readSourceOutput(cardId: string, outputFile: string): unknown;
  defaultCardKey(cardId: string): string;
}

// ============================================================================
// CardStore — board one-cycle (read-only)
// ============================================================================

export interface CardStore {
  readCard(id: string): LiveCard | null;
  readCardKey(id: string): string | null;
  readAllCards(): LiveCard[];
  readChecksumIndex(): CardChecksumIndex;
  changedSince(snapshotChecksumIndex: CardChecksumIndex): string[];
  readSourceFileContent(cardId: string, outputFile: string): unknown;
}

// ============================================================================
// CardAdminStore — CLI write interface
// ============================================================================

export interface CardUpsertValidation {
  ok: boolean;
  error?: string;
}

export interface CardAdminStore extends CardStore {
  validateUpsert(id: string, cardKey: string): CardUpsertValidation;
  writeCard(id: string, card: LiveCard, cardKey?: string): void;
  removeCard(id: string): void;
  readIndex(): CardIndex;
}

// ============================================================================
// createCardStore — pure logic factory
// ============================================================================

export function createCardStore(adapter: CardStorageAdapter): CardAdminStore {
  function loadIndex(): CardIndex {
    return adapter.readIndex() ?? {};
  }

  return {
    readCard(id: string): LiveCard | null {
      const entry = loadIndex()[id];
      if (!entry || !adapter.cardExists(entry.key)) return null;
      return adapter.readCard(entry.key);
    },

    readCardKey(id: string): string | null {
      return loadIndex()[id]?.key ?? null;
    },

    readAllCards(): LiveCard[] {
      const cards: LiveCard[] = [];
      for (const [id, entry] of Object.entries(loadIndex())) {
        if (!adapter.cardExists(entry.key)) continue;
        const card = adapter.readCard(entry.key);
        if (card) cards.push(card);
        else console.warn(`[card-store] could not read card "${id}" at key "${entry.key}"`);
      }
      return cards;
    },

    readChecksumIndex(): CardChecksumIndex {
      const result: CardChecksumIndex = {};
      for (const [id, entry] of Object.entries(loadIndex())) result[id] = entry.checksum;
      return result;
    },

    changedSince(snapshotChecksumIndex: CardChecksumIndex): string[] {
      const localIndex = loadIndex();
      const changed: string[] = [];
      for (const [id, entry] of Object.entries(localIndex)) {
        if (snapshotChecksumIndex[id] !== entry.checksum) changed.push(id);
      }
      for (const id of Object.keys(snapshotChecksumIndex)) {
        if (!localIndex[id]) changed.push(id);
      }
      return changed;
    },

    readSourceFileContent(cardId: string, outputFile: string): unknown {
      return adapter.readSourceOutput(cardId, outputFile);
    },

    validateUpsert(id: string, cardKey: string): CardUpsertValidation {
      const index = loadIndex();
      const existingById = index[id];
      const existingByKey = Object.entries(index).find(([, e]) => e.key === cardKey);
      if (existingById && existingById.key !== cardKey)
        return { ok: false, error: `Card id "${id}" is already mapped to key "${existingById.key}", cannot remap to "${cardKey}"` };
      if (existingByKey && existingByKey[0] !== id)
        return { ok: false, error: `Key "${cardKey}" is already mapped to card id "${existingByKey[0]}", cannot remap to "${id}"` };
      return { ok: true };
    },

    writeCard(id: string, card: LiveCard, cardKey?: string): void {
      const index = loadIndex();
      const resolvedKey = cardKey ?? index[id]?.key ?? adapter.defaultCardKey(id);
      const checksum = adapter.writeCard(resolvedKey, card);
      index[id] = { key: resolvedKey, checksum, updatedAt: new Date().toISOString() };
      adapter.writeIndex(index);
    },

    removeCard(id: string): void {
      const index = loadIndex();
      if (!index[id]) return;
      delete index[id];
      adapter.writeIndex(index);
    },

    readIndex(): CardIndex {
      return loadIndex();
    },
  };
}

// ============================================================================
// Journal store — types
// ============================================================================

export interface JournalEntry {
  id: string;
  event: GraphEvent;
}

// ============================================================================
// JournalStorageAdapter — injected by the caller
// ============================================================================

export interface JournalStorageAdapter {
  readAllEntries(): JournalEntry[];
  appendEntry(entry: JournalEntry): void;
  generateId(): string;
}

// ============================================================================
// JournalStore — board one-cycle (read-only)
// ============================================================================

export interface JournalStore {
  readEntriesAfterCursor(cursor: string): { events: GraphEvent[]; newCursor: string };
  pendingCount(cursor: string): number;
}

// ============================================================================
// JournalAdminStore — CLI write interface
// ============================================================================

export interface JournalAdminStore extends JournalStore {
  appendEvent(event: GraphEvent): void;
}

// ============================================================================
// createJournalStore — pure logic factory
// ============================================================================

export function createJournalStore(adapter: JournalStorageAdapter): JournalAdminStore {
  function entriesAfterCursor(cursor: string): JournalEntry[] {
    const all = adapter.readAllEntries();
    if (!cursor) return all;
    const idx = all.findIndex(e => e.id === cursor);
    return idx === -1 ? all : all.slice(idx + 1);
  }

  return {
    readEntriesAfterCursor(cursor: string): { events: GraphEvent[]; newCursor: string } {
      const entries = entriesAfterCursor(cursor);
      if (entries.length === 0) return { events: [], newCursor: cursor };
      return { events: entries.map(e => e.event), newCursor: entries[entries.length - 1].id };
    },

    pendingCount(cursor: string): number {
      return entriesAfterCursor(cursor).length;
    },

    appendEvent(event: GraphEvent): void {
      adapter.appendEntry({ id: adapter.generateId(), event });
    },
  };
}

// ============================================================================
// ExecutionRequest store — types
// ============================================================================

/**
 * A single pending execution request queued by the card-handler.
 * taskKind discriminates how the payload is dispatched by the CLI processor fn.
 * payload is opaque at this layer — interpreted only by the CLI dispatcher.
 */
export interface ExecutionRequestEntry {
  taskKind: string;
  payload: unknown;
}

// ============================================================================
// ExecutionRequestStorageAdapter — key-value blob semantics, injected by caller
// ============================================================================

export interface ExecutionRequestStorageAdapter {
  /** Replace the stored entry list for this journalId key. Creates if absent. */
  writeEntries(journalId: string, entries: ExecutionRequestEntry[]): void;
  /** Read all entries for this journalId. Returns null if key does not exist. */
  readEntries(journalId: string): ExecutionRequestEntry[] | null;
  /** Remove the key entirely. No-op if absent. */
  deleteEntries(journalId: string): void;
}

// ============================================================================
// ExecutionRequestStore — pure logic
// ============================================================================

export interface ExecutionRequestStore {
  /**
   * Append execution request entries for the given journalId.
   * Multiple calls with the same journalId accumulate (read-merge-write).
   * Called by card-handler once per invocation with all accumulated requests.
   * No-op if journalId is empty or entries array is empty.
   */
  appendEntries(journalId: string, entries: ExecutionRequestEntry[]): void;
  /**
   * Read all entries for journalId, invoke processorFn for each, then delete the key.
   * No-op if journalId is empty or no entries exist for it.
   * Called by the board AFTER saveBoard succeeds.
   */
  dispatchEntriesForJournalId(journalId: string, processorFn: (entry: ExecutionRequestEntry) => void): void;
}

// ============================================================================
// createExecutionRequestStore — pure logic factory
// ============================================================================

export function createExecutionRequestStore(
  adapter: ExecutionRequestStorageAdapter,
  onDispatchFailed: (entry: ExecutionRequestEntry, error: string) => void,
): ExecutionRequestStore {
  return {
    appendEntries(journalId: string, entries: ExecutionRequestEntry[]): void {
      if (!journalId || entries.length === 0) return;
      const existing = adapter.readEntries(journalId) ?? [];
      adapter.writeEntries(journalId, [...existing, ...entries]);
    },

    dispatchEntriesForJournalId(journalId: string, processorFn: (entry: ExecutionRequestEntry) => void): void {
      if (!journalId) return;
      const entries = adapter.readEntries(journalId);
      if (!entries || entries.length === 0) return;
      for (const entry of entries) {
        try { processorFn(entry); } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[execution-request-store] dispatch failed for taskKind "${entry.taskKind}":`, msg);
          try { onDispatchFailed(entry, msg); } catch { /* guard against failure in error handler */ }
        }
      }
      adapter.deleteEntries(journalId);
    },
  };
}

// ============================================================================
// ---- StateSnapshot store ----
//
// Key-value snapshot of authoritative runtime state.
// Adapter handles raw I/O and version computation.
// Store handles version-conflict guard and envelope application (pure logic).
// ============================================================================

export const SNAPSHOT_SCHEMA_VERSION_V1 = 'v1';

export const BOARD_GRAPH_KEY = 'board/graph';
export const BOARD_LAST_JOURNAL_PROCESSED_ID_KEY = 'board/lastJournalProcessedId';

export function cardRuntimeKey(cardId: string): string {
  return `cards/${cardId}/runtime`;
}

export function cardFetchedSourcesManifestKey(cardId: string): string {
  return `cards/${cardId}/fetched-sources-manifest`;
}

/** Per-card runtime state stored under cards/<id>/runtime. */
export interface CardRuntimeSnapshot {
  _sources: Record<string, { lastRequestedAt?: string; lastFetchedAt?: string; queueRequestedAt?: string }>;
  _inferenceEntry?: { lastRequestedAt?: string; queueRequestedAt?: string; inferenceCompletedAt?: string };
  _lastExecutionCount?: number;
}

/** Metadata entry for a fetched source payload blob. */
export interface FetchedSourceManifestEntry {
  outputFile: string;
  blobRef: string;
  fetchedAt: string;
  sourceChecksum?: string;
  contentType?: string;
  sizeBytes?: number;
}

export interface StateSnapshotReadView {
  /** Storage-level version token. Null means no snapshot exists yet. */
  version: string | null;
  values: Record<string, unknown>;
}

export interface StateSnapshotCommitEnvelope {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_V1;
  expectedVersion: string | null;
  commitId: string;
  committedAt: string;
  /** Applied first, before shallowMerge. */
  deleteKeys: string[];
  /** Each key fully replaces current value. Applied after deletes. */
  shallowMerge: Record<string, unknown>;
}

export interface StateSnapshotCommitSuccess {
  ok: true;
  newVersion: string;
}

export interface StateSnapshotCommitVersionMismatch {
  ok: false;
  reason: 'version-mismatch';
  currentVersion: string | null;
}

export type StateSnapshotCommitResult =
  | StateSnapshotCommitSuccess
  | StateSnapshotCommitVersionMismatch;

/**
 * Adapter contract — raw I/O only.
 * - readValues: returns current key-value map and opaque version token.
 * - writeValues: persists nextValues atomically, returns new version token.
 */
export interface StateSnapshotStorageAdapter {
  readValues(scopeId: string): StateSnapshotReadView;
  writeValues(scopeId: string, nextValues: Record<string, unknown>, deletedKeys: string[]): string;
}

export interface StateSnapshotStore {
  readSnapshot(scopeId: string): StateSnapshotReadView;
  commitSnapshot(scopeId: string, envelope: StateSnapshotCommitEnvelope): StateSnapshotCommitResult;
}

/**
 * Pure-logic helper — applies commit envelope semantics deterministically:
 * 1. delete keys
 * 2. shallow merge replacements
 */
export function applyStateSnapshotCommitEnvelope(
  current: Record<string, unknown>,
  envelope: Pick<StateSnapshotCommitEnvelope, 'deleteKeys' | 'shallowMerge'>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };
  for (const key of envelope.deleteKeys) {
    delete next[key];
  }
  return { ...next, ...envelope.shallowMerge };
}

// ============================================================================
// createStateSnapshotStore — pure logic factory
// ============================================================================

export function createStateSnapshotStore(adapter: StateSnapshotStorageAdapter): StateSnapshotStore {
  return {
    readSnapshot(scopeId: string): StateSnapshotReadView {
      return adapter.readValues(scopeId);
    },

    commitSnapshot(scopeId: string, envelope: StateSnapshotCommitEnvelope): StateSnapshotCommitResult {
      if (envelope.schemaVersion !== SNAPSHOT_SCHEMA_VERSION_V1) {
        throw new Error(`Unsupported snapshot schema version: ${envelope.schemaVersion}`);
      }
      const current = adapter.readValues(scopeId);
      if (current.version !== envelope.expectedVersion) {
        return { ok: false, reason: 'version-mismatch', currentVersion: current.version };
      }
      const nextValues = applyStateSnapshotCommitEnvelope(current.values, envelope);
      const newVersion = adapter.writeValues(scopeId, nextValues, envelope.deleteKeys);
      return { ok: true, newVersion };
    },
  };
}

// ============================================================================
// Config store — types
// ============================================================================

/**
 * Parsed config for a registered task-executor.
 * Supports both the preferred structured form and the legacy plain-string form.
 *   Preferred:  { "command": "node", "args": ["executor.js"], "extra": {} }
 *   Legacy cmd: { "command": "node executor.js" }
 *   Legacy str: "node executor.js"
 */
export interface TaskExecutorConfig {
  command: string;
  args?: string[];
  extra?: Record<string, unknown>;
}

// ============================================================================
// BoardConfigStore — pure logic interface
// ============================================================================

export interface BoardConfigStore {
  readTaskExecutorConfig(): TaskExecutorConfig | undefined;
  writeTaskExecutorConfig(config: TaskExecutorConfig): void;
  readInferenceAdapter(): string | undefined;
  writeInferenceAdapter(value: string): void;
  readChatHandler(): string | undefined;
  writeChatHandler(value: string): void;
}

// ============================================================================
// createBoardConfigStore — pure logic factory
// ============================================================================

/**
 * @param kv          Key-value store. Keys used: 'task-executor', 'inference-adapter', 'chat-handler'.
 * @param parseSpec   Normalises legacy string or structured { command, args } →
 *                    { command, args }. Injected to keep this module platform-free.
 */
export function createBoardConfigStore(
  kv: KVStorage,
  parseSpec: (raw: string | { command: string; args?: string[] }) => { command: string; args?: string[] },
): BoardConfigStore {
  function readKey(key: string): string | null {
    const v = kv.read(key);
    if (v == null) return null;
    return typeof v === 'string' ? v : JSON.stringify(v);
  }

  return {
    readTaskExecutorConfig(): TaskExecutorConfig | undefined {
      const raw = readKey('task-executor');
      if (!raw?.trim()) return undefined;
      const trimmed = raw.trim();
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === 'object' && typeof parsed.command === 'string') {
          const spec = parseSpec({ command: parsed.command, args: parsed.args });
          return { command: spec.command, args: spec.args, extra: parsed.extra };
        }
      } catch { /* not JSON — treat as plain command string */ }
      const spec = parseSpec(trimmed);
      return { command: spec.command, args: spec.args };
    },

    writeTaskExecutorConfig(config: TaskExecutorConfig): void {
      kv.write('task-executor', JSON.stringify(config, null, 2));
    },

    readInferenceAdapter(): string | undefined {
      return readKey('inference-adapter')?.trim() || undefined;
    },

    writeInferenceAdapter(value: string): void {
      kv.write('inference-adapter', value);
    },

    readChatHandler(): string | undefined {
      return readKey('chat-handler')?.trim() || undefined;
    },

    writeChatHandler(value: string): void {
      kv.write('chat-handler', value);
    },
  };
}

// ============================================================================
// Future-facing blob and read-model cache interfaces (not yet implemented)
// ============================================================================

/** Immutable payload blobs referenced from authoritative manifest keys. */
export interface FetchedSourcesBlobStore {
  readBlob(blobRef: string): Promise<unknown | null>;
}

/** Published read-model cache — not authoritative state, best-effort writes. */
export interface PublishedBoardStatusCache {
  writeStatusBestEffort(scopeId: string, statusPayload: unknown): Promise<void>;
  readStatus(scopeId: string): Promise<unknown | null>;
}
