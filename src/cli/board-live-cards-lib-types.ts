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

import type { CardStore, FetchedSourcesStore, CardRuntimeStore, ExecutionRequestStore, PublishedOutputsStore } from './board-live-cards-all-stores.js';
export type { CardStore, FetchedSourcesStore, CardRuntimeStore, ExecutionRequestStore, PublishedOutputsStore };

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

export type FetchRuntimeEntry = SourceRuntimeEntry;

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
// InvocationAdapter — see process-interface.ts for the full contract and
// instructions for adding a new backend.
// ============================================================================

export type { DispatchResult, InvocationAdapter } from './process-interface.js';

// ============================================================================
// CardHandlerAdapters — aggregate of all adapters consumed by createCardHandler
// ============================================================================

export interface CardHandlerAdapters {
  cardStore: CardStore;
  cardRuntimeStore: CardRuntimeStore;
  /** Blob store for fetched source payloads. Key: <cardId>/<outputFile>. */
  fetchedSourcesStore: FetchedSourcesStore;
  outputStore: PublishedOutputsStore;
  executionRequestStore: ExecutionRequestStore;
}

// ============================================================================
// CommandResponse — standard response envelope for CLI commands
// ============================================================================

export interface CommandResponse<T extends Record<string, unknown> = Record<string, unknown>> {
  status: 'success' | 'error';
  data: T;
  error?: string;
}

/**
 * Helpers for constructing and inspecting CommandResponse objects.
 *
 * Usage:
 *   Resp.success({ cardId: 'T1', errors: [] })
 *   Resp.error('Card not found')
 *   Resp.getData(response)
 *   Resp.getStatus(response)
 *   Resp.isSuccess(response)
 */
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
