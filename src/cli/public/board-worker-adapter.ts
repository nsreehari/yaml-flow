/**
 * board-worker-adapter.ts
 *
 * Standalone file — copy this to your board worker project (task executor, chat handler, etc.).
 * Zero dependencies on the rest of yaml-flow.
 *
 * NOTE: KindValueRef / parseRef / serializeRef are intentionally duplicated here
 * instead of re-exported from cli/common/storage-interface.ts. This file is a
 * published worker-facing entrypoint (`yaml-flow/board-worker-adapter`) and must
 * stay self-contained so executors can vendor or copy it without pulling in the
 * broader runtime package surface. Keep the wire format in sync with the common
 * storage-interface helpers.
 *
 * Provides:
 *   - KindValueRef      wire format: b64:<base64url(json)>
 *   - parseRef()        parse a b64:<base64url(json)> string
 *   - serializeRef()    produce a b64:<base64url(json)> string
 *   - BlobStorage       read/write interface
 *   - blobStorageForRef resolve a ref to its BlobStorage backend
 *   - ExecutionRef      portable invocation descriptor (inlined, stays standalone)
 *   - TaskCallback      how to report task completion back to the board
 *   - reportComplete()  call from executor on success
 *   - reportFailed()    call from executor on failure
 *
 * Supported storage kinds:
 *   fs-path   — ref.value is an absolute file path; reads/writes via node:fs
 *   (add more cases to blobStorageForRef for other backends, e.g. cosmos, azure-blob)
 *
 * Supported callback transports (via ExecutionRef.howToRun):
 *   local-node     — invoke board CLI as a child Node process
 *   http:post      — HTTP POST to a board endpoint
 *   in-process-loop — invoke a registered same-process callback handler
 *
 * Usage:
 *   import { parseRef, blobStorageForRef, reportComplete, reportFailed } from 'yaml-flow/board-worker-adapter';
 *
 *   const { source_def, callback } = JSON.parse(blobStorageForRef(inRef).read(inRef.value));
 *   // ... do work, write to outRef ...
 *   reportComplete(callback, outRef);
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  type InProcessBoardWorkerCallbackHandler,
  type InProcessBoardWorkerCallbackPayload,
  type InProcessBoardWorkerCallbackResult,
  registerInProcessBoardWorkerCallback,
  reportBoardWorkerCallbackInProcess,
  unregisterInProcessBoardWorkerCallback,
} from './board-worker-callback-inprocess.js';
import {
  reportBoardWorkerCallbackHttpFailure,
  reportBoardWorkerCallbackHttpSuccess,
} from './board-worker-callback-http.js';
import {
  reportBoardWorkerCallbackLocalNodeFailure,
  reportBoardWorkerCallbackLocalNodeSuccess,
} from './board-worker-callback-local-node.js';

export {
  registerInProcessBoardWorkerCallback,
  unregisterInProcessBoardWorkerCallback,
};
export type {
  InProcessBoardWorkerCallbackHandler,
  InProcessBoardWorkerCallbackPayload,
  InProcessBoardWorkerCallbackResult,
};

// ============================================================================
// KindValueRef
// ============================================================================

export interface KindValueRef {
  readonly kind: string;
  readonly value: string;
}

/** Parse a wire-format ref string (b64:<base64url(json)>) into a KindValueRef. */
export function parseRef(s: string): KindValueRef {
  if (!s.startsWith('b64:')) throw new Error(`Invalid ref format (expected b64:<base64url(json)>): ${s}`);
  const payload = s.slice(4);
  const padded = payload.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (payload.length % 4)) % 4);
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  } catch {
    throw new Error(`Invalid ref format (malformed base64url/json): ${s}`);
  }
  if (!decoded || typeof decoded !== 'object') {
    throw new Error(`Invalid ref format (expected object payload): ${s}`);
  }
  const candidate = decoded as { kind?: unknown; value?: unknown };
  if (typeof candidate.kind !== 'string' || typeof candidate.value !== 'string') {
    throw new Error(`Invalid ref format (payload must contain string kind/value): ${s}`);
  }
  return { kind: candidate.kind, value: candidate.value };
}

/** Serialize a KindValueRef to the wire format: b64:<base64url(json)> */
export function serializeRef(ref: KindValueRef): string {
  return `b64:${Buffer.from(JSON.stringify(ref), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')}`;
}

// ============================================================================
// BlobStorage
// ============================================================================

export interface BlobStorage {
  /** Returns content string, or null if not found. */
  read(key: string): string | null;
  /** Write content at key. */
  write(key: string, content: string): void;
}

// ============================================================================
// fs-path backend — key IS the absolute file path
// ============================================================================

function createFsPathBlobStorage(): BlobStorage {
  return {
    read(key: string): string | null {
      if (!fs.existsSync(key)) return null;
      try { return fs.readFileSync(key, 'utf-8'); } catch { return null; }
    },
    write(key: string, content: string): void {
      fs.mkdirSync(path.dirname(key), { recursive: true });
      fs.writeFileSync(key, content, 'utf-8');
    },
  };
}

// ============================================================================
// blobStorageForRef
// ============================================================================

/**
 * Resolve a KindValueRef to its BlobStorage backend.
 * Throws a clear error for unrecognised kinds.
 */
export function blobStorageForRef(ref: KindValueRef): BlobStorage {
  switch (ref.kind) {
    case 'fs-path': return createFsPathBlobStorage();
    default: throw new Error(`Unsupported storage kind: "${ref.kind}". Supported kinds: fs-path`);
  }
}

// ============================================================================
// TaskCallback — how a task-executor reports results back to the board
// ============================================================================

/**
 * Portable invocation descriptor for the board CLI back-channel.
 * Inlined here so this file stays standalone (zero deps on yaml-flow internals).
 * Shape matches ExecutionRef in execution-interface.ts — keep in sync.
 *
 * Supported howToRun values for TaskCallback.via:
 *   local-node   — invoke board CLI as: node [tsx?] <whatToRun.value> <cmd> [...argv]
 *   http:post    — POST to <whatToRun.value> with a JSON body
 */
export interface ExecutionRef {
  /** Optional human-readable label. Not used for dispatch. */
  meta?: string;
  /** Transport / runtime kind. */
  howToRun: 'local-node' | 'local-python' | 'local-process' | 'http:post' | 'http:get' | 'built-in' | 'in-process-loop';
  /** Address of the target in b64:<base64url(json)> wire form. */
  whatToRun: string;
  /** Opaque executor config stored with the ref. */
  extra?: Record<string, unknown>;
}

export type BoardWorkerCallbackOutcome = 'success' | 'failure';

/**
 * Describes how the board wants to receive task completion callbacks.
 * Baked into the inRef payload as { source_def, callback }.
 * The executor treats `token` as opaque and passes it back unchanged.
 */
export interface TaskCallback {
  /** Opaque routing token — generated by the board, passed back unchanged. */
  token: string;
  /** Delivery mechanism — an ExecutionRef pointing at the board CLI or endpoint. */
  via: ExecutionRef;
}

/**
 * Report successful task completion back to the board.
 * Call this from a task-executor after writing the result to outRef.
 */
export function reportComplete(callback: TaskCallback, outRef: KindValueRef): void {
  const { token, via } = callback;
  if (via.howToRun === 'local-node' || via.howToRun === 'local-process') {
    reportBoardWorkerCallbackLocalNodeSuccess(via, token, serializeRef(outRef));
    return;
  }
  if (via.howToRun === 'http:post') {
    reportBoardWorkerCallbackHttpSuccess(parseRef(via.whatToRun).value, token, serializeRef(outRef));
    return;
  }
  if (via.howToRun === 'in-process-loop') {
    reportBoardWorkerCallbackInProcess({ token, outcome: 'success', ref: serializeRef(outRef) }, parseRef(via.whatToRun).value);
    return;
  }
  throw new Error(`reportComplete: unsupported via.howToRun "${via.howToRun}"`);
}

/**
 * Report task failure back to the board.
 * Call this from a task-executor instead of writing to outRef.
 */
export function reportFailed(callback: TaskCallback, reason: string): void {
  const { token, via } = callback;
  if (via.howToRun === 'local-node' || via.howToRun === 'local-process') {
    reportBoardWorkerCallbackLocalNodeFailure(via, token, reason);
    return;
  }
  if (via.howToRun === 'http:post') {
    reportBoardWorkerCallbackHttpFailure(parseRef(via.whatToRun).value, token, reason);
    return;
  }
  if (via.howToRun === 'in-process-loop') {
    reportBoardWorkerCallbackInProcess({ token, outcome: 'failure', reason }, parseRef(via.whatToRun).value);
    return;
  }
  throw new Error(`reportFailed: unsupported via.howToRun "${via.howToRun}"`);
}
