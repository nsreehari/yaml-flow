/**
 * board-live-cards — Cross-host authoritative snapshot contracts.
 *
 * This file captures the locked V1 rules for deterministic state commits across
 * Node CLI, Python CLI, Azure Function, and Browser adapters.
 *
 * AUTHORITATIVE STATE (5 MUTABLE KEYS IN SNAPSHOT):
 * - board/graph: LiveGraphSnapshot (reactive state, changes during execution)
 * - board/lastJournalProcessedId: string (drain cursor, changes during drain cycle)
 * - cards/<id>/runtime: CardRuntimeSnapshot (per-card engine state)
 * - cards/<id>/fetched-sources-manifest: FetchedSourceManifestEntry[] (source fetch metadata)
 * - outputStore: computed values, inference logs (changes during execution)
 *
 * CONFIGURATION STATE (NOT IN SNAPSHOT - loaded from files at init):
 * - CardsStore: card definitions from card-source-kinds.json
 *   (When upsert-card is called, updates are written directly to the config file,
 *    not persisted via snapshot. Snapshot contains only runtime state.)
 * - ControlStore: task executor & inference config from .task-executor, .inference-adapter
 * - LockingAdapter: transient, never persisted
 * - InvocationAdapter: stateless, never persisted
 *
 * DESIGN CONSTRAINTS:
 * - Authoritative state uses commit envelopes with shallow merge + deletes.
 * - Deletes are applied before shallow merge.
 * - Commits are optimistic-concurrency guarded via expectedVersion.
 * - Adapters must expose all-or-nothing commit semantics.
 * - Fetched source payloads are immutable blobs; authoritative state stores refs only.
 * - Snapshot is atomic: crash mid-commit leaves no partial state visible.
 

import type { LiveGraphSnapshot } from '../continuous-event-graph/types.js';
import type {
  SourceRuntimeEntry,
  InferenceRuntimeEntry,
} from './board-live-cards-lib-types.js';

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
  _sources: Record<string, SourceRuntimeEntry>;
  _inferenceEntry?: InferenceRuntimeEntry;
  _lastExecutionCount?: number;
}

export interface FetchedSourceManifestEntry {
  /** Relative path used by source_defs[].outputFile. */
  outputFile: string;
  /** Immutable blob reference in FetchedSourcesBlobStore. */
  blobRef: string;
  fetchedAt: string;
  sourceChecksum?: string;
  contentType?: string;
  sizeBytes?: number;
}

export interface BoardAuthoritativeRoot {
  graph: LiveGraphSnapshot;
  lastJournalProcessedId: string;
}

/*******************************************************************************
 * State Snapshot Store contracts
 ******************************************************************************/

export interface StateSnapshotReadView {
  /**
   * Storage-level version token (ETag/revision/hash) returned by adapter.
   * Null means "no snapshot exists yet".
   */
  version: string | null;
  /**
   * Key-value map of mutable authoritative runtime state (5 keys only).
   * Configuration state (CardsStore, ControlStore) is loaded from files at init time, not here.
   *
   * Keys in this map:
   * - board/graph: LiveGraphSnapshot
   * - board/lastJournalProcessedId: string
   * - cards/<id>/runtime: CardRuntimeSnapshot
   * - cards/<id>/fetched-sources-manifest: FetchedSourceManifestEntry[]
   * - outputStore: computed values & logs
   */
  values: Record<string, unknown>;
}

export interface StateSnapshotCommitEnvelope {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION_V1;
  expectedVersion: string | null;
  commitId: string;
  committedAt: string;
  /** Deleted first, then shallowMerge is applied. */
  deleteKeys: string[];
  /**
   * Replacement semantics only.
   * Each key fully replaces current value at that key.
   */
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
 * Adapter contract:
 * - readSnapshot + commitSnapshot form optimistic-concurrency transaction API.
 * - commitSnapshot must be all-or-nothing from caller perspective.
 * - On expectedVersion mismatch, return reason=version-mismatch and do not write.
 */
export interface StateSnapshotStore {
  readSnapshot(scopeId: string): Promise<StateSnapshotReadView>;
  commitSnapshot(
    scopeId: string,
    envelope: StateSnapshotCommitEnvelope,
  ): Promise<StateSnapshotCommitResult>;
}

/*******************************************************************************
 * Fetched source payload contracts
 ******************************************************************************/

/*******************************************************************************
 * Payload blobs are immutable and referenced from authoritative manifest keys.
 * The handler reads them through this store as read-only data.
 ******************************************************************************/
export interface FetchedSourcesBlobStore {
  readBlob(blobRef: string): Promise<unknown | null>;
}

/*******************************************************************************
 * Published read-model cache contracts
 ******************************************************************************/

/*******************************************************************************
 * Published status cache is not authoritative state. Writes are best-effort.
 * Readers may recompute from authoritative snapshot if cache is missing/stale.
 ******************************************************************************/
export interface PublishedBoardStatusCache {
  writeStatusBestEffort(scopeId: string, statusPayload: unknown): Promise<void>;
  readStatus(scopeId: string): Promise<unknown | null>;
}

/*******************************************************************************
 * Deterministic envelope semantics helper (pure function)
 ******************************************************************************/

/**
 * Applies commit envelope semantics in a host-neutral deterministic way:
 * 1) delete keys
 * 2) shallow merge replacements
 */
export function applyStateSnapshotCommitEnvelope(
  current: Record<string, unknown>,
  envelope: Pick<StateSnapshotCommitEnvelope, 'deleteKeys' | 'shallowMerge'>,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current };

  for (const key of envelope.deleteKeys) {
    delete next[key];
  }

  return {
    ...next,
    ...envelope.shallowMerge,
  };
}
