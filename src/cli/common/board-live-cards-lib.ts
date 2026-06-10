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
import type { BoardOutputNotification } from './notification-interface.js';
import type { GraphEvent, TaskConfig, GraphConfig } from '../../event-graph/types.js';
import type { LiveGraph, LiveGraphSnapshot } from '../../continuous-event-graph/types.js';
import { schedule } from '../../continuous-event-graph/schedule.js';
import type { TaskHandlerFn } from '../../continuous-event-graph/reactive.js';
import { CardCompute } from '../../card-compute/index.js';
import type { ComputeNode, ComputeStep, ComputeSource } from '../../card-compute/index.js';
import {
  applyStateSnapshotCommitEnvelope as applySharedStateSnapshotCommitEnvelope,
  createJournalStoreFromEntriesAdapter,
  createStateSnapshotStoreFromAdapter,
} from './board-live-cards-shared-snapshot-journal.js';
import {
  createCardRuntimeStoreFromBacking,
  createExecutionRequestStoreFromBacking,
  createFetchedSourcesStoreFromBacking,
  createPublishedOutputsStoreFromBacking,
} from './board-live-cards-shared-stores.js';
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
  removeCard(key: string): void;
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
  patchCard(id: string, jsonPath: string, value: unknown): void;
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

  function applyJsonPath(obj: Record<string, unknown>, jsonPath: string, value: unknown): Record<string, unknown> {
    const segments = String(jsonPath || '').split('.').filter(Boolean);
    if (segments.length === 0) {
      return (value && typeof value === 'object' && !Array.isArray(value))
        ? value as Record<string, unknown>
        : { value };
    }

    const out: Record<string, unknown> = { ...obj };
    let target: Record<string, unknown> = out;
    for (let i = 0; i < segments.length - 1; i++) {
      const key = segments[i];
      const cur = target[key];
      const next = (cur && typeof cur === 'object' && !Array.isArray(cur))
        ? { ...(cur as Record<string, unknown>) }
        : {};
      target[key] = next;
      target = next;
    }
    target[segments[segments.length - 1]] = value;
    return out;
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

    patchCard(id: string, jsonPath: string, value: unknown): void {
      const index = loadIndex();
      const entry = index[id];
      if (!entry || !adapter.cardExists(entry.key)) {
        throw new Error(`card "${id}" not found`);
      }
      const current = adapter.readCard(entry.key);
      if (!current || typeof current !== 'object' || Array.isArray(current)) {
        throw new Error(`card "${id}" is not patchable`);
      }
      const next = applyJsonPath(current as Record<string, unknown>, jsonPath, value) as LiveCard;
      const checksum = adapter.writeCard(entry.key, next);
      index[id] = { key: entry.key, checksum, updatedAt: new Date().toISOString() };
      adapter.writeIndex(index);
    },

    removeCard(id: string): void {
      const index = loadIndex();
      const entry = index[id];
      if (!entry) return;
      adapter.removeCard(entry.key);
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
  /** List the outputFile names for all committed source files belonging to a card. */
  listSources(cardId: string): string[];
}

export function createFetchedSourcesStore(
  blob: BlobStorage,
  resolveRef: (ref: KindValueRef) => string,
): FetchedSourcesStore {
  return createFetchedSourcesStoreFromBacking(blob, resolveRef);
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
  return createJournalStoreFromEntriesAdapter(adapter);
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
  return createExecutionRequestStoreFromBacking(kv, onDispatchFailed);
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

export type SourceCompletionStatus = 'success' | 'failure' | 'not-started';

export interface SourceRuntimeEntry {
  lastRequestedToken?: string;
  lastCompletedToken?: string;
  lastCompletionStatus?: SourceCompletionStatus;
  queueRequestedToken?: string;
}

export interface CardRuntimeSnapshot {
  _sources: Record<string, SourceRuntimeEntry>;
  _lastExecutionCount?: number;
}

export interface CardRuntimeStore {
  readRuntime(cardId: string): CardRuntimeSnapshot;
  writeRuntime(cardId: string, state: CardRuntimeSnapshot): void;
}

export function createCardRuntimeStore(kv: KVStorage): CardRuntimeStore {
  return createCardRuntimeStoreFromBacking(kv, cardRuntimeKey, () => ({ _sources: {} }));
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
  return applySharedStateSnapshotCommitEnvelope(current, envelope);
}

export function createStateSnapshotStore(adapter: StateSnapshotStorageAdapter): StateSnapshotStore {
  return createStateSnapshotStoreFromAdapter(adapter, SNAPSHOT_SCHEMA_VERSION_V1);
}

// ============================================================================
// BoardConfigStore
// ============================================================================

export interface BoardConfigStore {
  readTaskExecutorRef(): ExecutionRef | undefined;
  writeTaskExecutorRef(ref: ExecutionRef): void;
  readChatHandlerFlow(): unknown;
  writeChatHandlerFlow(flow: unknown): void;
  readBoardRuntimeStoreRef(): string | null;
  writeBoardRuntimeStoreRef(ref: string): void;
  readCardStoreRef(): string | null;
  writeCardStoreRef(ref: string): void;
  readOutputsStoreRef(): string | null;
  writeOutputsStoreRef(ref: string): void;
  readQueueStoreRef(): string | null;
  writeQueueStoreRef(ref: string): void;
  readScratchStoreRef(): string | null;
  writeScratchStoreRef(ref: string): void;
  readChatStoreRef(): string | null;
  writeChatStoreRef(ref: string): void;
  readArtifactsStoreRef(): string | null;
  writeArtifactsStoreRef(ref: string): void;
  readFetchedSourcesStoreRef(): string | null;
  writeFetchedSourcesStoreRef(ref: string): void;
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

    readChatHandlerFlow(): unknown {
      return kv.read('chat-handler-flow');
    },

    writeChatHandlerFlow(flow: unknown): void {
      kv.write('chat-handler-flow', flow);
    },

    readBoardRuntimeStoreRef(): string | null {
      return readKey('board-runtime-store-ref');
    },

    writeBoardRuntimeStoreRef(ref: string): void {
      kv.write('board-runtime-store-ref', ref);
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

    readQueueStoreRef(): string | null {
      return readKey('queue-store-ref');
    },

    writeQueueStoreRef(ref: string): void {
      kv.write('queue-store-ref', ref);
    },

    readScratchStoreRef(): string | null {
      return readKey('scratch-store-ref');
    },

    writeScratchStoreRef(ref: string): void {
      kv.write('scratch-store-ref', ref);
    },

    readChatStoreRef(): string | null {
      return readKey('chat-store-ref');
    },

    writeChatStoreRef(ref: string): void {
      kv.write('chat-store-ref', ref);
    },

    readArtifactsStoreRef(): string | null {
      return readKey('artifacts-store-ref');
    },

    writeArtifactsStoreRef(ref: string): void {
      kv.write('artifacts-store-ref', ref);
    },

    readFetchedSourcesStoreRef(): string | null {
      return readKey('fetched-sources-store-ref');
    },

    writeFetchedSourcesStoreRef(ref: string): void {
      kv.write('fetched-sources-store-ref', ref);
    },
  };
}

// ============================================================================
// PublishedOutputsStore
// ============================================================================

export type OutputStoreEvent = BoardOutputNotification;

export interface PublishedOutputsStore {
  writeComputedValues(cardId: string, values: Record<string, unknown>): void;
  readComputedValues(cardId: string): unknown | null;
  readAllComputedValues(): Record<string, unknown>;
  writeDataObjects(data: Record<string, unknown>): void;
  readDataObject(key: string): unknown | null;
  readAllDataObjects(): Record<string, unknown>;
  writeStatusSnapshot(status: unknown): void;
  readStatusSnapshot(): unknown | null;
}

export function createPublishedOutputsStore(kv: KVStorage): PublishedOutputsStore {
  return createPublishedOutputsStoreFromBacking(kv);
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

export function normalizeSourceRuntimeEntry(entry: SourceRuntimeEntry | undefined): SourceRuntimeEntry {
  if (!entry) return { lastCompletionStatus: 'not-started' };
  return {
    lastRequestedToken: entry.lastRequestedToken,
    lastCompletedToken: entry.lastCompletedToken,
    lastCompletionStatus:
      entry.lastCompletionStatus ?? (entry.lastCompletedToken ? 'success' : 'not-started'),
    queueRequestedToken: entry.queueRequestedToken,
  };
}

export function isSourceInFlight(entry: FetchRuntimeEntry | undefined): boolean {
  if (!entry?.lastRequestedToken) return false;
  return entry.lastCompletedToken !== entry.lastRequestedToken;
}

export function decideSourceAction(
  entry: FetchRuntimeEntry | undefined,
  queueRequestedToken: string,
): 'dispatch' | 'in-flight' | 'idle' {
  if (!entry?.lastRequestedToken) return 'dispatch';
  const inFlight = isSourceInFlight(entry);
  if (inFlight) return 'in-flight';
  if (!entry.lastCompletedToken) return 'dispatch';
  if (entry.lastCompletedToken < queueRequestedToken) return 'dispatch';
  return 'idle';
}

export function nextEntryAfterFetchDelivery<T extends FetchRuntimeEntry>(
  entry: T,
  completionToken: string,
): T {
  return {
    ...entry,
    lastCompletedToken: completionToken,
    lastCompletionStatus: 'success' as const,
  } as T;
}

export function nextEntryAfterFetchFailure<T extends FetchRuntimeEntry>(
  entry: T,
  completionToken: string,
): T {
  return {
    ...entry,
    lastCompletedToken: completionToken,
    lastCompletionStatus: 'failure' as const,
  } as T;
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
        // Keep status snapshots immutable across reads: this field must not depend on wall-clock pull time.
        status_age_ms: state.lastUpdated ? 0 : null,
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
  writeComputedValuesFn?: (cardId: string, values: Record<string, unknown>) => void,
  writeDataObjectsFn?: (data: Record<string, unknown>) => void,
): TaskHandlerFn {
  return async (input) => {
        const pendingRequests: ExecutionRequestEntry[] = [];
        const card = adapters.cardStore.readCard(input.nodeId);
        if (!card) return 'task-initiate-failure';

        const cardId = card.id as string;
        const cardState = (card.card_data ?? {}) as Record<string, unknown>;
        const allSources: ComputeSource[] = (card.source_defs ?? []) as ComputeSource[];
        const requiredSources = allSources;

        let state: CardRuntimeSnapshot = adapters.cardRuntimeStore.readRuntime(cardId);
        let dirty = false;

        const flush = (): void => {
          if (!dirty) return;
          adapters.cardRuntimeStore.writeRuntime(cardId, state);
          dirty = false;
        };

        const getSourceEntry = (outputFile: string): SourceRuntimeEntry =>
          normalizeSourceRuntimeEntry(state._sources[outputFile]);
        const setSourceEntry = (outputFile: string, entry: SourceRuntimeEntry): void => {
          state._sources[outputFile] = normalizeSourceRuntimeEntry(entry); dirty = true;
        };

        const currentExecutionCount = input.taskState?.executionCount ?? 0;
        const lastExecCount = state._lastExecutionCount;
        if (lastExecCount !== currentExecutionCount) {
          // Wipe source entries whenever the execution count changes (retrigger / first run).
          // The typeof guard was removed: on first run lastExecCount is undefined, and
          // _sources is already empty, so the wipe is a no-op. The guard was creating a gap
          // for migrated snapshots that have source entries but no _lastExecutionCount — those
          // would retain stale data across a retrigger without the unconditional wipe.
          state._sources = {};
          state._lastExecutionCount = currentExecutionCount;
          dirty = true;
        }


        if (input.update) {
          const u = input.update;
          const outputFile = u.outputFile as string;
          if (outputFile) {
            const entry = getSourceEntry(outputFile);
            if (u.failure) {
              const failureToken = (u.rqt as string | undefined) ?? entry.lastRequestedToken ?? entry.queueRequestedToken;
              if (failureToken) {
                setSourceEntry(
                  outputFile,
                  nextEntryAfterFetchFailure(entry, failureToken),
                );
              }
            } else {
              const incomingRqt = u.rqt as string;
              if (!entry.lastCompletedToken || incomingRqt > entry.lastCompletedToken) {
                const deliveryToken = typeof u.deliveryToken === 'string' ? u.deliveryToken : undefined;
                let committed = false;
                if (deliveryToken) {
                  committed = adapters.fetchedSourcesStore.commitSourceData(cardId, outputFile, deliveryToken);
                }
                if (committed) {
                  setSourceEntry(outputFile, nextEntryAfterFetchDelivery(entry, incomingRqt));
                } else {
                  setSourceEntry(
                    outputFile,
                    nextEntryAfterFetchFailure(entry, incomingRqt),
                  );
                }
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
          CardCompute.runSync(computeNode, { sourcesData });
        }

        (writeComputedValuesFn ?? adapters.outputStore.writeComputedValues.bind(adapters.outputStore))(cardId, computeNode.computed_values ?? {});

        const enrichedCard = { ...card };
        const enrichedSources = CardCompute.enrichSourcesSync(
          Array.isArray(card.source_defs) ? card.source_defs : undefined,
          {
            card_data: card.card_data as Record<string, unknown>,
            requires,
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
        const runQueuedToken = input.update ? undefined : now;

        const undeliveredRequired = requiredSources.filter(s => {
          const outputFile = s.outputFile;
          if (typeof outputFile !== 'string' || !outputFile) return true;
          let entry = getSourceEntry(outputFile);
          if (runQueuedToken) {
            entry = { ...entry, queueRequestedToken: runQueuedToken };
            setSourceEntry(outputFile, entry);
          }
          const qrt = entry.queueRequestedToken ?? entry.lastRequestedToken ?? now;
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
            const queuedAt = entry.queueRequestedToken ?? now;
            setSourceEntry(outputFile, { ...entry, lastRequestedToken: queuedAt });
            dispatchRqt = queuedAt;
            stampedAny = true;
          }
          if (stampedAny) flush();
          if (!stampedAny) return 'task-initiated';

          pendingRequests.push({ taskKind: 'source-fetch', payload: { boardRef: serializeRef(baseRef), enrichedCard: enrichedCard as Record<string, unknown>, callbackToken: input.callbackToken, rqt: dispatchRqt } });
          adapters.executionRequestStore.appendEntries(journalId, pendingRequests);
          return 'task-initiated';
        }

        // Guard: do not complete the card while any required source is still in-flight.
        // undeliveredRequired excludes in-flight sources (they don't need re-dispatch), so a card
        // with N required sources where the first N-1 have delivered but the last is still in-flight
        // would otherwise fall through to taskCompletedFn prematurely.
        const anyRequiredInFlight = requiredSources.some(s => {
          const outputFile = s.outputFile;
          if (typeof outputFile !== 'string' || !outputFile) return false;
          const entry = getSourceEntry(outputFile);
          const qrt = entry.queueRequestedToken ?? entry.lastRequestedToken ?? now;
          return decideSourceAction(entry, qrt) === 'in-flight';
        });
        if (anyRequiredInFlight) return 'task-initiated';

        const providesBindings = (card.provides ?? []) as { bindTo: string; ref: string }[];
        const data: Record<string, unknown> = {};
        for (const { bindTo, ref } of providesBindings) {
          data[bindTo] = CardCompute.resolve(computeNode, ref);
        }

        (writeDataObjectsFn ?? adapters.outputStore.writeDataObjects.bind(adapters.outputStore))(data);

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
  runtimeByCardId: Record<string, CardRuntimeSnapshot>;
}

export function boardEnvelopeToSnapshotEntries(envelope: BoardEnvelope): Record<string, unknown> {
  return {
    [BOARD_GRAPH_KEY]: envelope.graph,
    [BOARD_LAST_JOURNAL_PROCESSED_ID_KEY]: envelope.lastDrainedJournalId,
    board: {
      runtimeByCardId: envelope.runtimeByCardId,
    },
  };
}

export function snapshotEntriesToBoardEnvelope(entries: Record<string, unknown>): BoardEnvelope {
  const graph = entries[BOARD_GRAPH_KEY] as LiveGraphSnapshot | undefined;
  const lastDrainedJournalId = entries[BOARD_LAST_JOURNAL_PROCESSED_ID_KEY] as string | undefined;
  const board = entries['board'] as Record<string, unknown> | undefined;
  const runtimeByCardId = board?.['runtimeByCardId'] as Record<string, CardRuntimeSnapshot> | undefined;
  if (!graph || typeof graph !== 'object') {
    throw new Error(`State snapshot is missing required key: ${BOARD_GRAPH_KEY}`);
  }
  return {
    graph,
    lastDrainedJournalId: typeof lastDrainedJournalId === 'string' ? lastDrainedJournalId : '',
    runtimeByCardId: runtimeByCardId && typeof runtimeByCardId === 'object' ? runtimeByCardId : {},
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
    provides,
    taskHandlers: ['card-handler'],
    description: (card.meta as { title?: string } | undefined)?.title ?? card.id,
    ...(requires && requires.length > 0 ? { requires } : {}),
  };
}
