/**
 * board-live-cards-lib — Pure logic library for the board-live-cards CLI.
 *
 * Merged from:
 *   board-live-cards-all-stores.ts
 *   board-live-cards-lib-types.ts
 *   board-live-cards-lib-board-status.ts
 *   board-live-cards-lib-card-handler.ts
 *   board-live-cards-cli-board-commands.ts
 *   board-live-cards-cli-card-commands.ts
 *   board-live-cards-cli-callbacks.ts
 *
 * Zero platform imports. All storage is injected via adapter interfaces.
 * Safe for Node, browser, and neutral (V8/PyMiniRacer) bundles.
 */

import type { KVStorage, BlobStorage, KindValueRef } from './storage-interface.js';
import { serializeRef } from './storage-interface.js';
import { parseExecutionRef, serializeExecutionRef } from './execution-interface.js';
import type { ExecutionRef } from './execution-interface.js';
import type { GraphEvent, TaskConfig, GraphConfig } from '../../event-graph/types.js';
import type { LiveGraph, LiveGraphSnapshot } from '../../continuous-event-graph/types.js';
import { schedule } from '../../continuous-event-graph/schedule.js';
import type { TaskHandlerFn } from '../../continuous-event-graph/reactive.js';
import { CardCompute } from '../../card-compute/index.js';
import type { ComputeNode, ComputeStep, ComputeSource } from '../../card-compute/index.js';
export type { DispatchResult, InvocationAdapter } from './process-interface.js';

// ============================================================================
// ---- from board-live-cards-all-stores.ts ----
// ============================================================================

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

export function createCardStore(adapter: CardStorageAdapter, onWarn?: (msg: string) => void): CardAdminStore {
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
        else onWarn?.(`[card-store] could not read card "${id}" at key "${entry.key}"`);
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
// FetchedSourcesStore
// ============================================================================

export interface FetchedSourcesStore {
  /** Read committed source content. Returns parsed JSON or raw string; null if not yet committed. */
  readSourceData(cardId: string, outputFile: string): unknown;
  /** Stage incoming source data under deliveryToken. resolveRef converts the ref to content bytes. */
  ingestSourceDataStaged(cardId: string, outputFile: string, ref: KindValueRef, deliveryToken: string): void;
  /** Move staged data to live position. Returns false if staged entry is absent (stale delivery). */
  commitSourceData(cardId: string, outputFile: string, deliveryToken: string): boolean;
  /** True if live (committed) source data exists for this outputFile. */
  hasSource(cardId: string, outputFile: string): boolean;
}

export function createFetchedSourcesStore(
  blob: BlobStorage,
  resolveRef: (ref: KindValueRef) => string,
): FetchedSourcesStore {
  return {
    readSourceData(cardId, outputFile): unknown {
      const raw = blob.read(`${cardId}/${outputFile}`);
      if (raw == null) return null;
      const trimmed = raw.trim();
      if (!trimmed) return null;
      try { return JSON.parse(trimmed); } catch { return trimmed; }
    },
    ingestSourceDataStaged(cardId, outputFile, ref, deliveryToken): void {
      const content = resolveRef(ref);
      blob.write(`${cardId}/.staged/${deliveryToken}/${outputFile}`, content);
    },
    commitSourceData(cardId, outputFile, deliveryToken): boolean {
      const stagedKey = `${cardId}/.staged/${deliveryToken}/${outputFile}`;
      const content = blob.read(stagedKey);
      if (content == null) return false;
      blob.write(`${cardId}/${outputFile}`, content);
      blob.remove(stagedKey);
      return true;
    },
    hasSource(cardId, outputFile): boolean {
      return blob.exists(`${cardId}/${outputFile}`);
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

export interface JournalStorageAdapter {
  readAllEntries(): JournalEntry[];
  appendEntry(entry: JournalEntry): void;
  generateId(): string;
}

export interface JournalStore {
  readEntriesAfterCursor(cursor: string): { events: GraphEvent[]; newCursor: string };
  pendingCount(cursor: string): number;
}

export interface JournalAdminStore extends JournalStore {
  appendEvent(event: GraphEvent): void;
}

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
// ExecutionRequest store
// ============================================================================

export interface ExecutionRequestEntry {
  taskKind: string;
  payload: unknown;
}

export interface ExecutionRequestStore {
  appendEntries(journalId: string, entries: ExecutionRequestEntry[]): void;
  dispatchEntriesForJournalId(journalId: string, processorFn: (entry: ExecutionRequestEntry) => void): void;
}

export function createExecutionRequestStore(
  kv: KVStorage,
  onDispatchFailed: (entry: ExecutionRequestEntry, error: string) => void,
): ExecutionRequestStore {
  return {
    appendEntries(journalId: string, entries: ExecutionRequestEntry[]): void {
      if (!journalId || entries.length === 0) return;
      const existing = (kv.read(journalId) as ExecutionRequestEntry[] | null) ?? [];
      kv.write(journalId, [...existing, ...entries]);
    },

    dispatchEntriesForJournalId(journalId: string, processorFn: (entry: ExecutionRequestEntry) => void): void {
      if (!journalId) return;
      const entries = kv.read(journalId) as ExecutionRequestEntry[] | null;
      if (!entries || entries.length === 0) return;
      for (const entry of entries) {
        try { processorFn(entry); } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          try { onDispatchFailed(entry, msg); } catch { /* guard against failure in error handler */ }
        }
      }
      kv.delete(journalId);
    },
  };
}

// ============================================================================
// StateSnapshot store
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

export interface CardRuntimeSnapshot {
  _sources: Record<string, { lastRequestedAt?: string; lastFetchedAt?: string; queueRequestedAt?: string }>;
  _lastExecutionCount?: number;
}

export interface CardRuntimeStore {
  readRuntime(cardId: string): CardRuntimeSnapshot;
  writeRuntime(cardId: string, state: CardRuntimeSnapshot): void;
}

export function createCardRuntimeStore(kv: KVStorage): CardRuntimeStore {
  return {
    readRuntime(cardId) {
      return (kv.read(cardRuntimeKey(cardId)) as CardRuntimeSnapshot | null) ?? { _sources: {} };
    },
    writeRuntime(cardId, state) {
      kv.write(cardRuntimeKey(cardId), state);
    },
  };
}

export interface FetchedSourceManifestEntry {
  outputFile: string;
  blobRef: string;
  fetchedAt: string;
  sourceChecksum?: string;
  contentType?: string;
  sizeBytes?: number;
}

export interface StateSnapshotReadView {
  version: string | null;
  values: Record<string, unknown>;
}

export interface StateSnapshotCommitEnvelope {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_V1;
  expectedVersion: string | null;
  commitId: string;
  committedAt: string;
  deleteKeys: string[];
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

export interface StateSnapshotStorageAdapter {
  readValues(scopeId: string): StateSnapshotReadView;
  writeValues(scopeId: string, nextValues: Record<string, unknown>, deletedKeys: string[]): string;
}

export interface StateSnapshotStore {
  readSnapshot(scopeId: string): StateSnapshotReadView;
  commitSnapshot(scopeId: string, envelope: StateSnapshotCommitEnvelope): StateSnapshotCommitResult;
}

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
// BoardConfigStore
// ============================================================================

export interface BoardConfigStore {
  readTaskExecutorRef(): ExecutionRef | undefined;
  writeTaskExecutorRef(ref: ExecutionRef): void;
  readChatHandlerRef(): ExecutionRef | undefined;
  writeChatHandlerRef(ref: ExecutionRef): void;
  readCardStoreRef(): string | null;
  writeCardStoreRef(ref: string): void;
  readOutputsStoreRef(): string | null;
  writeOutputsStoreRef(ref: string): void;
  /** @deprecated use readChatHandlerRef */
  readChatHandler(): string | undefined;
  /** @deprecated use writeChatHandlerRef */
  writeChatHandler(value: string): void;
}

export function createBoardConfigStore(kv: KVStorage): BoardConfigStore {
  function readKey(key: string): string | null {
    const v = kv.read(key);
    if (v == null) return null;
    return typeof v === 'string' ? v : JSON.stringify(v);
  }

  return {
    readTaskExecutorRef(): ExecutionRef | undefined {
      const raw = readKey('task-executor');
      if (!raw?.trim()) return undefined;
      return parseExecutionRef(raw.trim());
    },

    writeTaskExecutorRef(ref: ExecutionRef): void {
      kv.write('task-executor', serializeExecutionRef(ref));
    },

    readChatHandlerRef(): ExecutionRef | undefined {
      const raw = readKey('chat-handler');
      if (!raw?.trim()) return undefined;
      return parseExecutionRef(raw.trim());
    },

    writeChatHandlerRef(ref: ExecutionRef): void {
      kv.write('chat-handler', serializeExecutionRef(ref));
    },

    readCardStoreRef(): string | null {
      return readKey('card-store-ref');
    },

    writeCardStoreRef(ref: string): void {
      kv.write('card-store-ref', ref);
    },

    readOutputsStoreRef(): string | null {
      return readKey('outputs-store-ref');
    },

    writeOutputsStoreRef(ref: string): void {
      kv.write('outputs-store-ref', ref);
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
// PublishedOutputsStore
// ============================================================================

export interface PublishedOutputsStore {
  writeComputedValues(cardId: string, values: Record<string, unknown>): void;
  writeDataObjects(data: Record<string, unknown>): void;
  writeStatusSnapshot(status: unknown): void;
  readStatusSnapshot(): unknown | null;
}

export function createPublishedOutputsStore(kv: KVStorage): PublishedOutputsStore {
  return {
    writeComputedValues(cardId, values) { kv.write(`cards/${cardId}/computed_values`, values); },
    writeDataObjects(data) {
      for (const [token, payload] of Object.entries(data)) {
        if (!token) continue;
        kv.write(`data-objects/${token}`, payload);
      }
    },
    writeStatusSnapshot(status) { kv.write('status', status); },
    readStatusSnapshot() { return kv.read('status'); },
  };
}

// ============================================================================
// Future-facing blob and read-model cache interfaces
// ============================================================================

export interface FetchedSourcesBlobStore {
  readBlob(blobRef: string): Promise<unknown | null>;
}

export interface PublishedBoardStatusCache {
  writeStatusBestEffort(scopeId: string, statusPayload: unknown): Promise<void>;
  readStatus(scopeId: string): Promise<unknown | null>;
}

// ============================================================================
// ---- from board-live-cards-lib-types.ts ----
// ============================================================================

export interface SourceRuntimeEntry {
  lastRequestedAt?: string;
  lastFetchedAt?: string;
  lastError?: string;
  queueRequestedAt?: string;
}

export type FetchRuntimeEntry = SourceRuntimeEntry;

export interface SourceTokenPayload {
  cbk: string;
  rg: string;
  br: string;
  cid: string;
  b: string;
  d: string;
  cs?: string;
  rqt: string;
}

export function isSourceInFlight(entry: FetchRuntimeEntry | undefined): boolean {
  if (!entry?.lastRequestedAt) return false;
  return !entry.lastFetchedAt || entry.lastFetchedAt < entry.lastRequestedAt;
}

export function decideSourceAction(
  entry: FetchRuntimeEntry | undefined,
  queueRequestedAt: string,
): 'dispatch' | 'in-flight' | 'idle' {
  if (!entry?.lastRequestedAt) return 'dispatch';
  const inFlight = isSourceInFlight(entry);
  if (inFlight) return 'in-flight';
  if (!entry.lastFetchedAt) return 'dispatch';
  if (entry.lastFetchedAt < queueRequestedAt) return 'dispatch';
  return 'idle';
}

export function nextEntryAfterFetchDelivery<T extends FetchRuntimeEntry>(
  entry: T,
  fetchedAt: string,
): T {
  const next = { ...entry, lastFetchedAt: fetchedAt };
  delete (next as FetchRuntimeEntry).lastError;
  return next as T;
}

export function nextEntryAfterFetchFailure<T extends FetchRuntimeEntry>(
  entry: T,
  reason: string,
): T {
  const next = { ...entry, lastError: reason };
  delete (next as FetchRuntimeEntry).lastFetchedAt;
  return next as T;
}

export interface CardHandlerAdapters {
  cardStore: CardStore;
  cardRuntimeStore: CardRuntimeStore;
  fetchedSourcesStore: FetchedSourcesStore;
  outputStore: PublishedOutputsStore;
  executionRequestStore: ExecutionRequestStore;
}

export interface CommandResponse<T extends Record<string, unknown> = Record<string, unknown>> {
  status: 'success' | 'error';
  data: T;
  error?: string;
}

export const Resp = {
  success<T extends Record<string, unknown>>(data: T): CommandResponse<T> {
    return { status: 'success', data };
  },

  error(error: string, data: Record<string, unknown> = {}): CommandResponse {
    return { status: 'error', data, error };
  },

  getStatus(r: CommandResponse): 'success' | 'error' {
    return r.status;
  },

  getData<T extends Record<string, unknown>>(r: CommandResponse<T>): T {
    return r.data;
  },

  isSuccess(r: CommandResponse): boolean {
    return r.status === 'success';
  },
} as const;

// ============================================================================
// ---- from board-live-cards-lib-board-status.ts ----
// ============================================================================

export interface BoardStatusCard {
  name: string;
  status: string;
  error?: {
    message: string;
    code?: string;
    at?: string;
    source?: 'task-runtime' | 'source-fetch' | 'timeout' | 'unknown';
  };
  requires: string[];
  requires_satisfied: string[];
  requires_missing: string[];
  provides_declared: string[];
  provides_runtime: string[];
  blocked_by: string[];
  unblocks: string[];
  runtime: {
    attempt_count: number;
    restart_count: number;
    in_progress_since: string | null;
    last_transition_at: string | null;
    last_completed_at: string | null;
    last_restarted_at: string | null;
    status_age_ms: number | null;
  };
}

export interface BoardStatusObject {
  schema_version: 'v1';
  meta: {
    board: {
      path: string;
    };
  };
  summary: {
    card_count: number;
    completed: number;
    eligible: number;
    pending: number;
    blocked: number;
    unresolved: number;
    failed?: number;
    in_progress?: number;
    orphan_cards?: number;
    topology?: {
      edge_count: number;
      max_fan_out_card: string | null;
      max_fan_out: number;
    };
  };
  cards: BoardStatusCard[];
}

export function buildBoardStatusObject(boardPath: string, live: LiveGraph): BoardStatusObject {
  const taskState = live.state.tasks;
  const taskConfig = live.config.tasks;
  const cardNames = Object.keys(taskState);
  const sched = schedule(live);

  const statusCounts = {
    completed: 0,
    failed: 0,
    in_progress: 0,
    pending: 0,
    blocked: 0,
    unresolved: 0,
  };

  const waitingByCard = new Map<string, string[]>();
  for (const p of sched.pending) waitingByCard.set(p.taskName, p.waitingOn);
  for (const u of sched.unresolved) waitingByCard.set(u.taskName, u.missingTokens);
  for (const b of sched.blocked) waitingByCard.set(b.taskName, b.failedTokens);

  const dependentsByToken = new Map<string, string[]>();
  for (const [name, cfg] of Object.entries(taskConfig)) {
    for (const token of cfg.requires ?? []) {
      const dependents = dependentsByToken.get(token) ?? [];
      dependents.push(name);
      dependentsByToken.set(token, dependents);
    }
  }

  const cards: BoardStatusCard[] = cardNames.sort().map((name) => {
    const state = taskState[name] as {
      status: string;
      data?: Record<string, unknown>;
      error?: string;
      startedAt?: string;
      completedAt?: string;
      failedAt?: string;
      lastUpdated?: string;
      executionCount?: number;
      retryCount?: number;
    };
    const cfg = taskConfig[name] ?? { requires: [], provides: [] };

    if (state.status === 'completed') statusCounts.completed += 1;
    else if (state.status === 'failed') statusCounts.failed += 1;
    else if (state.status === 'in-progress') statusCounts.in_progress += 1;

    const requires = cfg.requires ?? [];
    const provides = cfg.provides ?? [];
    const runtimeKeys = Object.keys(state.data ?? {}).sort();
    const requiresSatisfied = requires.filter(token => live.state.availableOutputs.includes(token));
    const requiresMissing = requires.filter(token => !live.state.availableOutputs.includes(token));
    const blockedBy = waitingByCard.get(name) ?? requiresMissing;

    const unblocks = new Set<string>();
    for (const token of provides) {
      for (const dependent of dependentsByToken.get(token) ?? []) {
        if (dependent !== name) unblocks.add(dependent);
      }
    }

    const lastFailureAt = state.failedAt;
    const error = state.error
      ? {
          message: state.error,
          code: 'TASK_FAILED',
          at: lastFailureAt,
          source: 'task-runtime' as const,
        }
      : undefined;

    return {
      name,
      status: state.status,
      error,
      requires,
      requires_satisfied: requiresSatisfied,
      requires_missing: requiresMissing,
      provides_declared: provides,
      provides_runtime: runtimeKeys,
      blocked_by: blockedBy,
      unblocks: Array.from(unblocks).sort(),
      runtime: {
        attempt_count: state.executionCount ?? 0,
        restart_count: state.retryCount ?? 0,
        in_progress_since: state.status === 'in-progress' ? (state.startedAt ?? null) : null,
        last_transition_at: state.lastUpdated ?? null,
        last_completed_at: state.completedAt ?? null,
        last_restarted_at: state.startedAt ?? null,
        status_age_ms: state.lastUpdated ? Math.max(0, Date.now() - Date.parse(state.lastUpdated)) : null,
      },
    };
  });

  statusCounts.pending = sched.pending.length;
  statusCounts.blocked = sched.blocked.length;
  statusCounts.unresolved = sched.unresolved.length;

  const fanOut = cards
    .map(c => ({ name: c.name, fanOut: c.unblocks.length }))
    .sort((a, b) => b.fanOut - a.fanOut || a.name.localeCompare(b.name));
  const maxFanOut = fanOut.length > 0 ? fanOut[0] : { name: null, fanOut: 0 };

  const allRequires = new Set<string>();
  for (const cfg of Object.values(taskConfig)) {
    for (const r of cfg.requires ?? []) allRequires.add(r);
  }
  let orphanCards = 0;
  for (const [name, cfg] of Object.entries(taskConfig)) {
    const requiresNone = (cfg.requires ?? []).length === 0;
    const providesList = cfg.provides ?? [];
    const feedsAny = providesList.some(p => (dependentsByToken.get(p) ?? []).some(d => d !== name));
    if (requiresNone && !feedsAny) orphanCards += 1;
  }

  return {
    schema_version: 'v1',
    meta: { board: { path: boardPath } },
    summary: {
      card_count: cardNames.length,
      completed: statusCounts.completed,
      eligible: sched.eligible.length,
      pending: statusCounts.pending,
      blocked: statusCounts.blocked,
      unresolved: statusCounts.unresolved,
      failed: statusCounts.failed,
      in_progress: statusCounts.in_progress,
      orphan_cards: orphanCards,
      topology: {
        edge_count: Array.from(allRequires).length,
        max_fan_out_card: maxFanOut.name,
        max_fan_out: maxFanOut.fanOut,
      },
    },
    cards,
  };
}

// ============================================================================
// ---- from board-live-cards-lib-card-handler.ts ----
// ============================================================================

function nowHighRes(): string {
  return new Date().toISOString();
}

export function createCardHandlerFn(
  baseRef: KindValueRef,
  journalId: string,
  adapters: CardHandlerAdapters,
  taskCompletedFn: (taskName: string, data: Record<string, unknown>) => void,
  _taskFailedFn: (taskName: string, error: string) => void,
): TaskHandlerFn {
  return async (input) => {
        const pendingRequests: ExecutionRequestEntry[] = [];
        const card = adapters.cardStore.readCard(input.nodeId);
        if (!card) return 'task-initiate-failure';

        const cardId = card.id as string;
        const cardState = (card.card_data ?? {}) as Record<string, unknown>;
        const allSources: ComputeSource[] = (card.source_defs ?? []) as ComputeSource[];
        const requiredSources = allSources.filter(s => s.optionalForCompletionGating !== true);

        let state: CardRuntimeSnapshot = adapters.cardRuntimeStore.readRuntime(cardId);
        let dirty = false;

        const flush = (): void => {
          if (!dirty) return;
          adapters.cardRuntimeStore.writeRuntime(cardId, state);
          dirty = false;
        };

        const getSourceEntry = (outputFile: string): SourceRuntimeEntry =>
          ({ ...(state._sources[outputFile] ?? {}) });
        const setSourceEntry = (outputFile: string, entry: SourceRuntimeEntry): void => {
          state._sources[outputFile] = entry; dirty = true;
        };

        const currentExecutionCount = input.taskState?.executionCount ?? 0;
        const lastExecCount = state._lastExecutionCount;
        if (typeof lastExecCount === 'number' && lastExecCount !== currentExecutionCount) {
          state._sources = {}; dirty = true;
        }
        if (lastExecCount !== currentExecutionCount) {
          state._lastExecutionCount = currentExecutionCount; dirty = true;
        }

        if (input.update) {
          const u = input.update;
          const outputFile = u.outputFile as string;
          if (outputFile) {
            const entry = getSourceEntry(outputFile);
            if (u.failure) {
              setSourceEntry(outputFile, nextEntryAfterFetchFailure(entry, (u.reason as string | undefined) ?? 'unknown'));
            } else {
              const incomingRqt = u.rqt as string;
              if (!entry.lastFetchedAt || incomingRqt > entry.lastFetchedAt) {
                const deliveryToken = typeof u.deliveryToken === 'string' ? u.deliveryToken : undefined;
                if (deliveryToken) {
                  adapters.fetchedSourcesStore.commitSourceData(cardId, outputFile, deliveryToken);
                }
                setSourceEntry(outputFile, nextEntryAfterFetchDelivery(entry, incomingRqt));
              }
            }
            flush();
          }
        }

        const sourcesData: Record<string, unknown> = {};
        for (const src of allSources) {
          if (src.outputFile) {
            const content = adapters.fetchedSourcesStore.readSourceData(cardId, src.outputFile as string);
            if (content !== null) {
              sourcesData[src.bindTo] = content;
            }
          }
        }

        const requires: Record<string, unknown> = {};
        for (const [token, taskData] of Object.entries(input.state ?? {})) {
          if (taskData !== null && typeof taskData === 'object' && !Array.isArray(taskData)) {
            const unwrapped = (taskData as Record<string, unknown>)[token];
            requires[token] = unwrapped !== undefined ? unwrapped : taskData;
          } else {
            requires[token] = taskData;
          }
        }

        const computeNode: ComputeNode = {
          id: cardId,
          card_data: { ...cardState },
          requires,
          source_defs: allSources,
          compute: card.compute as ComputeStep[] | undefined,
        };
        computeNode._sourcesData = sourcesData;
        if (card.compute) {
          await CardCompute.run(computeNode, { sourcesData });
        }

        adapters.outputStore.writeComputedValues(cardId, computeNode.computed_values ?? {});

        const enrichedCard = { ...card };
        const enrichedSources = await CardCompute.enrichSources(
          Array.isArray(card.source_defs) ? card.source_defs : undefined,
          {
            card_data: card.card_data as Record<string, unknown>,
            requires,
            sourcesData,
            computed_values: computeNode.computed_values,
          },
        );

        const dir = baseRef.value;
        enrichedCard.source_defs = Array.isArray(enrichedSources)
          ? enrichedSources.map(src => ({
              ...src,
              boardDir: typeof src.boardDir === 'string' && src.boardDir ? src.boardDir : dir,
            }))
          : enrichedSources;

        const now = nowHighRes();
        const runQueuedAt = input.update ? undefined : now;

        const undeliveredRequired = requiredSources.filter(s => {
          const outputFile = s.outputFile;
          if (typeof outputFile !== 'string' || !outputFile) return true;
          let entry = getSourceEntry(outputFile);
          if (runQueuedAt) {
            entry = { ...entry, queueRequestedAt: runQueuedAt };
            setSourceEntry(outputFile, entry);
          }
          const qrt = entry.queueRequestedAt ?? entry.lastRequestedAt ?? now;
          const action = decideSourceAction(entry, qrt);
          if (action === 'in-flight') return false;
          return action === 'dispatch';
        });

        flush();

        if (undeliveredRequired.length > 0) {
          let stampedAny = false;
          let dispatchRqt = now;
          for (const src of undeliveredRequired) {
            const outputFile = src.outputFile;
            if (typeof outputFile !== 'string' || !outputFile) continue;
            const entry = getSourceEntry(outputFile);
            const queuedAt = entry.queueRequestedAt ?? now;
            setSourceEntry(outputFile, { ...entry, lastRequestedAt: queuedAt });
            dispatchRqt = queuedAt;
            stampedAny = true;
          }
          if (stampedAny) flush();
          if (!stampedAny) return 'task-initiated';

          pendingRequests.push({ taskKind: 'source-fetch', payload: { boardRef: serializeRef(baseRef), enrichedCard: enrichedCard as Record<string, unknown>, callbackToken: input.callbackToken, rqt: dispatchRqt } });
          adapters.executionRequestStore.appendEntries(journalId, pendingRequests);
          return 'task-initiated';
        }

        const providesBindings = (card.provides ?? []) as { bindTo: string; ref: string }[];
        const data: Record<string, unknown> = {};
        for (const { bindTo, ref } of providesBindings) {
          data[bindTo] = CardCompute.resolve(computeNode, ref);
        }

        adapters.outputStore.writeDataObjects(data);

        const undeliveredOptional = allSources.filter(s => {
          if (s.optionalForCompletionGating !== true) return false;
          const entry = getSourceEntry(s.outputFile as string);
          if (!entry.lastRequestedAt) return true;
          if (!entry.lastFetchedAt) return true;
          return entry.lastFetchedAt <= entry.lastRequestedAt;
        });
        if (undeliveredOptional.length > 0) {
          pendingRequests.push({ taskKind: 'source-fetch', payload: { boardRef: serializeRef(baseRef), enrichedCard: enrichedCard as Record<string, unknown>, callbackToken: input.callbackToken, rqt: now } });
        }

        taskCompletedFn(input.nodeId, data);
        if (pendingRequests.length > 0) adapters.executionRequestStore.appendEntries(journalId, pendingRequests);
        return 'task-initiated';
  };
}

// ============================================================================
// ---- pure constants / codecs lifted from board-live-cards-cli.ts ----
// ============================================================================

export const EMPTY_CONFIG: GraphConfig = { settings: { completion: 'manual', refreshStrategy: 'data-changed' }, tasks: {} } as GraphConfig;

/** Envelope stored in the snapshot store — wraps the LiveGraph snapshot with journal pointer. */
export interface BoardEnvelope {
  lastDrainedJournalId: string;
  graph: LiveGraphSnapshot;
}

export function boardEnvelopeToSnapshotEntries(envelope: BoardEnvelope): Record<string, unknown> {
  return {
    [BOARD_GRAPH_KEY]: envelope.graph,
    [BOARD_LAST_JOURNAL_PROCESSED_ID_KEY]: envelope.lastDrainedJournalId,
  };
}

export function snapshotEntriesToBoardEnvelope(entries: Record<string, unknown>): BoardEnvelope {
  const graph = entries[BOARD_GRAPH_KEY] as LiveGraphSnapshot | undefined;
  const lastDrainedJournalId = entries[BOARD_LAST_JOURNAL_PROCESSED_ID_KEY] as string | undefined;
  if (!graph || typeof graph !== 'object') {
    throw new Error(`State snapshot is missing required key: ${BOARD_GRAPH_KEY}`);
  }
  return {
    graph,
    lastDrainedJournalId: typeof lastDrainedJournalId === 'string' ? lastDrainedJournalId : '',
  };
}

export interface CardInventoryEntry {
  cardId: string;
  cardFilePath: string;
  addedAt: string;
}

export interface CardInventoryIndex {
  byCardId: Map<string, CardInventoryEntry>;
  byCardPath: Map<string, CardInventoryEntry>;
}

/**
 * Transform a LiveCard into a TaskConfig for the reactive graph.
 * Every card gets handler: 'card-handler'.
 */
export function liveCardToTaskConfig(card: LiveCard): TaskConfig {
  const requires = card.requires as string[] | undefined;
  const provides = (card.provides as Array<{ bindTo: string }> | undefined)?.map(p => p.bindTo) ?? [];

  return {
    requires: requires && requires.length > 0 ? requires : undefined,
    provides,
    taskHandlers: ['card-handler'],
    description: (card.meta as { title?: string } | undefined)?.title ?? card.id,
  };
}
