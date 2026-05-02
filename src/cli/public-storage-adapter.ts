/**
 * public-storage-adapter.ts
 *
 * Standalone file — copy this to your task-executor project.
 * Zero dependencies on the rest of yaml-flow.
 *
 * Provides:
 *   - KindValueRef      wire format: ::kind::value
 *   - parseRef()        parse a ::kind::value string
 *   - serializeRef()    produce a ::kind::value string
 *   - BlobStorage       read/write interface
 *   - blobStorageForRef resolve a ref to its BlobStorage backend
 *   - ExecutionRef      portable invocation descriptor (inlined, stays standalone)
 *   - TaskCallback      how to report task completion back to the board
 *   - reportComplete()  call from executor on success
 *   - reportFailed()    call from executor on failure
 *
 * Supported storage kinds:
 *   fs-path   — ref.value is an absolute file path; reads/writes via node:fs
 *
 * Supported callback transports (via ExecutionRef.howToRun):
 *   local-node     — invoke board CLI as a child Node process
 *   http:post      — HTTP POST to a board endpoint
 *
 * Usage:
 *   import { parseRef, blobStorageForRef, reportComplete, reportFailed } from './public-storage-adapter.js';
 *
 *   const { source_def, callback } = JSON.parse(blobStorageForRef(inRef).read(inRef.value));
 *   // ... do work, write to outRef ...
 *   reportComplete(callback, outRef);
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

// ============================================================================
// KindValueRef
// ============================================================================

export interface KindValueRef {
  readonly kind: string;
  readonly value: string;
}

/** Parse a wire-format ref string (::kind::value) into a KindValueRef. */
export function parseRef(s: string): KindValueRef {
  if (!s.startsWith('::')) throw new Error(`Invalid ref format (expected ::kind::value): ${s}`);
  const inner = s.slice(2);
  const idx = inner.indexOf('::');
  if (idx === -1) throw new Error(`Invalid ref format (expected ::kind::value): ${s}`);
  return { kind: inner.slice(0, idx), value: inner.slice(idx + 2) };
}

/** Serialize a KindValueRef to the wire format: ::kind::value */
export function serializeRef(ref: KindValueRef): string {
  return `::${ref.kind}::${ref.value}`;
}

// ============================================================================
// BlobStorage
// ============================================================================

export interface BlobStorage {
  /** Returns content string, or null if not found. */
  read(key: string): string | null;
  /** Write content at key. */
  write(key: string, content: string): void;
  /** Returns true if a blob exists at key. */
  exists(key: string): boolean;
  /** Delete the blob at key. No-op if it does not exist. */
  remove(key: string): void;
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
    exists(key: string): boolean {
      return fs.existsSync(key);
    },
    remove(key: string): void {
      try { if (fs.existsSync(key)) fs.unlinkSync(key); } catch { /* best-effort */ }
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
  howToRun: 'local-node' | 'local-python' | 'local-process' | 'http:post' | 'http:get' | 'built-in';
  /** Address of the target in ::kind::value wire form (e.g. ::fs-path::/path/to/cli.js). */
  whatToRun: string;
  /** Opaque executor config stored with the ref. */
  extra?: Record<string, unknown>;
}

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
 * Extract the path/url value from a whatToRun ::kind::value wire string.
 * Falls back to the raw string if it isn’t in ::kind::value form.
 */
function _parseWhatToRun(whatToRun: string): string {
  try { return parseRef(whatToRun).value; } catch { return whatToRun; }
}

/**
 * Resolve the Node invocation for a local board CLI script.
 * If the path ends in .ts (dev mode), attempts to locate tsx alongside it;
 * otherwise assumes it’s a compiled .js and invokes directly with node.
 */
function _resolveLocalNodeInvocation(scriptPath: string): { cmd: string; args: string[] } {
  if (!scriptPath.endsWith('.ts')) {
    return { cmd: process.execPath, args: [scriptPath] };
  }
  // Dev path: look for tsx next to node_modules relative to the script
  const candidates = [
    path.join(path.dirname(scriptPath), '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs'),
    path.join(path.dirname(scriptPath), '..', '..', 'node_modules', '.bin', 'tsx'),
  ];
  const tsx = candidates.find(p => fs.existsSync(p));
  if (tsx) return { cmd: process.execPath, args: [tsx, scriptPath] };
  return { cmd: 'npx', args: ['tsx', scriptPath] };
}

/**
 * Report successful task completion back to the board.
 * Call this from a task-executor after writing the result to outRef.
 */
export function reportComplete(callback: TaskCallback, outRef: KindValueRef): void {
  const { token, via } = callback;
  if (via.howToRun === 'local-node' || via.howToRun === 'local-process') {
    const scriptPath = _parseWhatToRun(via.whatToRun);
    const { cmd, args } = _resolveLocalNodeInvocation(scriptPath);
    const result = spawnSync(cmd, [...args, 'source-data-fetched',
      '--ref', serializeRef(outRef), '--token', token,
    ], { encoding: 'utf-8', windowsHide: true });
    if (result.status !== 0) {
      throw new Error(`reportComplete: board CLI exited ${result.status}: ${result.stderr?.trim()}`);
    }
    return;
  }
  if (via.howToRun === 'http:post') {
    const url = _parseWhatToRun(via.whatToRun);
    const body = JSON.stringify({ status: 'complete', ref: serializeRef(outRef), token });
    _httpPostSync(url, body);
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
    const scriptPath = _parseWhatToRun(via.whatToRun);
    const { cmd, args } = _resolveLocalNodeInvocation(scriptPath);
    const result = spawnSync(cmd, [...args, 'source-data-fetch-failure',
      '--token', token, '--reason', reason,
    ], { encoding: 'utf-8', windowsHide: true });
    if (result.status !== 0) {
      throw new Error(`reportFailed: board CLI exited ${result.status}: ${result.stderr?.trim()}`);
    }
    return;
  }
  if (via.howToRun === 'http:post') {
    const url = _parseWhatToRun(via.whatToRun);
    const body = JSON.stringify({ status: 'failed', reason, token });
    _httpPostSync(url, body);
    return;
  }
  throw new Error(`reportFailed: unsupported via.howToRun "${via.howToRun}"`);
}

/** Synchronous HTTP POST using a child node process (keeps this file free of async). */
function _httpPostSync(url: string, body: string): void {
  const script = `
    const {request} = require(new URL('${url}').protocol === 'https:' ? 'https' : 'http');
    const h = ${JSON.stringify({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })};
    const u = new URL('${url}');
    const req = request({hostname:u.hostname,port:u.port,path:u.pathname+u.search,method:'POST',headers:h});
    req.on('error', e => { process.stderr.write(e.message); process.exit(1); });
    req.write(${JSON.stringify(body)});
    req.end();
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', windowsHide: true });
  if (result.status !== 0) throw new Error(`http-post failed: ${result.stderr?.trim()}`);
}
