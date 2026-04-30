/**
 * board-live-cards-lib — Adapter interfaces and shared domain types.
 *
 * This file contains only pure TypeScript — no Node built-ins.
 * It is safe to include in a neutral/browser/V8 (PyMiniRacer) bundle.
 *
 * Invariants enforced here:
 *   - RuntimeInternalStore is never returned raw from public APIs.
 *   - OutputStore writes are idempotent and schema-versioned.
 *   - InputStore mutations are explicit operations, never side effects.
 *   - Locking is acquired at the lib service boundary, not inside adapters.
 *   - ControlStore writes only during init/administrative flows.
 *   - InvocationAdapter results are structured, not raw shell-centric.
 */

import type { CardStore } from './board-live-cards-all-stores.js';
export type { CardStore };
import type { ExecutionRequestStore } from './board-live-cards-all-stores.js';
export type { ExecutionRequestStore };

// ============================================================================
// Shared domain types
// ============================================================================

export interface SourceRuntimeEntry {
  lastRequestedAt?: string;
  lastFetchedAt?: string;
  lastError?: string;
  /** Timestamp of the most recent card-handler dispatch for this execution run. */
  queueRequestedAt?: string;
}

export interface InferenceRuntimeEntry {
  lastRequestedAt?: string;
  lastFetchedAt?: string;
  lastError?: string;
  /** Same semantics as SourceRuntimeEntry.queueRequestedAt. */
  queueRequestedAt?: string;
}

export type FetchRuntimeEntry = SourceRuntimeEntry | InferenceRuntimeEntry;

export interface SourceTokenPayload {
  /** Original callback token from the reactive graph (encodes taskName) */
  cbk: string;
  /** Board directory (absolute path) */
  rg: string;
  /** Card id */
  cid: string;
  /** source_defs[].bindTo */
  b: string;
  /** source_defs[].outputFile (relative to boardDir) */
  d: string;
  /** Per-source invocation checksum */
  cs?: string;
}

export interface TaskExecutorConfig {
  command: string;
  extra?: Record<string, unknown>;
}

// ============================================================================
// Pure domain functions (no I/O — safe in neutral bundle)
// ============================================================================

export function isSourceInFlight(entry: FetchRuntimeEntry | undefined): boolean {
  if (!entry?.lastRequestedAt) return false;
  return !entry.lastFetchedAt || entry.lastFetchedAt < entry.lastRequestedAt;
}

/**
 * Decide what to do with a source/inference fetch given the current runtime entry
 * and the timestamp of the latest card-handler dispatch (queueRequestedAt).
 *
 * - 'dispatch'  : fetch not yet started for this run, or previous fetch predates the request
 * - 'in-flight' : fetch is already running for this run — update queueRequestedAt and wait
 * - 'idle'      : fetch already completed for this run — nothing to do
 */
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

// ============================================================================
// RuntimeInternalStore — opaque session-based interface
//
// Invariant: CardRuntimeState is never returned raw from public APIs.
// The raw persisted shape is hidden inside the store implementation.
// All reads/writes go through a RuntimeStoreSession, which is acquired
// per card-handler invocation and flushed once at natural checkpoints.
// ============================================================================

export interface RuntimeStoreSession {
  /** Returns the source runtime entry for the given outputFile, or {} if absent. */
  getSourceEntry(outputFile: string): SourceRuntimeEntry;
  setSourceEntry(outputFile: string, entry: SourceRuntimeEntry): void;
  /** Clear all source entries (called when execution count changes). */
  resetSources(): void;

  /** Returns the inference runtime entry, or {} if absent. */
  getInferenceEntry(): InferenceRuntimeEntry;
  setInferenceEntry(entry: InferenceRuntimeEntry): void;
  resetInferenceEntry(): void;

  getLastExecutionCount(): number | undefined;
  setLastExecutionCount(count: number): void;

  /** Write all dirty state to backing store. No-op if nothing changed. */
  flush(): void;
}

export interface RuntimeInternalStore {
  openSession(boardDir: string, cardId: string): RuntimeStoreSession;
}

// ============================================================================
// OutputStore — idempotent, schema-versioned writes
//
// Invariant: schema_version is enforced by the store, not by call sites.
// All writes are atomic where the backing store supports it.
// ============================================================================

export interface OutputStore {
  /** Write computed values for a card. Enforces schema_version: 'v1' internally. */
  writeComputedValues(boardDir: string, cardId: string, values: Record<string, unknown>): void;
  /** Write task-completed data objects. Idempotent (atomic rename on Node, blob PUT on Azure). */
  writeDataObjects(boardDir: string, data: Record<string, unknown>): void;
  /** Append a structured inference diagnostic log entry. */
  appendInferenceLog(boardDir: string, cardId: string, payload: unknown): void;
}

// ============================================================================
// LockingAdapter — board-level exclusive lock
//
// Invariant: Locking is acquired at the lib service boundary (processAccumulatedEvents),
// not inside individual adapters or handlers.
// ============================================================================

export interface LockingAdapter {
  withLock<T>(boardDir: string, fn: () => T): T;
}

// ============================================================================
// InvocationAdapter — normalized, structured dispatch
//
// Invariant: Results are a structured DispatchResult, not raw shell output or callbacks.
// The adapter owns all host-specific concerns (temp files, process spawning, queue messages).
// ============================================================================

export interface DispatchResult {
  dispatched: boolean;
  invocationId?: string;
  error?: string;
}

export interface InvocationAdapter {
  /**
   * Fire-and-forget: dispatch a source fetch for a card.
   * enrichedCard is passed by value; the adapter owns temp file management if needed.
   * Returns Promise so Azure Function / queue-backed adapters can await message enqueue.
   */
  requestSourceFetch(
    boardDir: string,
    enrichedCard: Record<string, unknown>,
    callbackToken: string,
  ): Promise<DispatchResult>;

  /**
   * Fire-and-forget: dispatch LLM inference for a card.
   * inferencePayload is passed by value; the adapter owns temp file management if needed.
   */
  requestInference(
    boardDir: string,
    cardId: string,
    inferencePayload: unknown,
    callbackToken: string,
  ): Promise<DispatchResult>;
}

// ============================================================================
// ControlStore — read-only in handlers; written only during init/admin flows
//
// Invariant: ControlStore writes only during init/administrative flows.
// Handlers must never write .task-executor or .inference-adapter.
// ============================================================================

export interface ControlStore {
  readTaskExecutorConfig(boardDir: string): TaskExecutorConfig | undefined;
  /** Returns the inference adapter command string, or undefined if not configured. */
  readInferenceAdapterConfig(boardDir: string): string | undefined;
}

// ============================================================================
// CardHandlerAdapters — aggregate of all adapters consumed by createCardHandler
// ============================================================================

export interface CardHandlerAdapters {
  cardStore: CardStore;
  runtimeStore: RuntimeInternalStore;
  outputStore: OutputStore;
  executionRequestStore: ExecutionRequestStore;
}
