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

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));

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
import {
  type InProcessBoardWorkerInvokeHandler,
  type InProcessBoardWorkerInvokeRequest,
  type InProcessBoardWorkerInvokeResult,
  invokeBoardWorkerInProcess,
  registerInProcessBoardWorkerInvoke,
  unregisterInProcessBoardWorkerInvoke,
} from './board-worker-invoke-inprocess.js';

export {
  registerInProcessBoardWorkerCallback,
  registerInProcessBoardWorkerInvoke,
  unregisterInProcessBoardWorkerCallback,
  unregisterInProcessBoardWorkerInvoke,
};
export type {
  InProcessBoardWorkerCallbackHandler,
  InProcessBoardWorkerCallbackPayload,
  InProcessBoardWorkerCallbackResult,
  InProcessBoardWorkerInvokeHandler,
  InProcessBoardWorkerInvokeRequest,
  InProcessBoardWorkerInvokeResult,
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
  /** Address of the target in b64:<base64url(json)> wire form or plain object ref form. */
  whatToRun: string | KindValueRef;
  /** Optional JSONata-based mapping from logical args to transport shape. */
  argsMassaging?: ArgsMassaging;
  /** Optional raw-result transforms expected by step-machine-public. */
  outputTransforms?: OutputTransforms;
  /** Opaque executor config stored with the ref. */
  extra?: Record<string, unknown>;
}

export interface LocalNodeExecutionRef extends ExecutionRef {
  howToRun: 'local-node' | 'local-process';
}

interface HttpExecutionRef extends ExecutionRef {
  howToRun: 'http:post' | 'http:get';
}

interface InProcessExecutionRef extends ExecutionRef {
  howToRun: 'in-process-loop';
}

export interface ArgsMassaging {
  cmdTemplate?: string[];
  stdinTemplate?: string;
  urlTemplate?: string;
  headerTemplate?: string;
  bodyTemplate?: string;
}

export interface OutputTransforms {
  resultExpr?: string;
  dataTemplate?: string;
  errorExpr?: string;
}

export interface NormalizedHandlerResult {
  result: string;
  data: Record<string, unknown>;
  error?: string;
}

export interface StepMachineInvokeOptions {
  timeoutMs?: number;
  label?: string;
}

export interface BoardWorkerInvokeRequest {
  subcommand?: string;
  inRef?: string;
  outRef?: string;
  errRef?: string;
  input?: string;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

export type BoardWorkerInvokeResult = unknown;

export interface ImmediateBoardWorkerRequest {
  subcommand: string;
  input?: string;
  timeoutMs?: number;
  extra?: Record<string, unknown>;
}

export type ImmediateBoardWorkerHandler = (
  request: ImmediateBoardWorkerRequest,
) => unknown | Promise<unknown>;

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

type JsonataExpression = {
  evaluate: (data: unknown) => unknown;
  registerFunction?: (name: string, impl: (...args: unknown[]) => unknown, signature?: string) => void;
};

type MassagedArgs = {
  cmdArgs?: string[];
  stdin?: unknown;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
};

function resolveJsonataCjsPath(): string {
  const sibling = path.resolve(THIS_DIR, './jsonata-sync.cjs');
  if (fs.existsSync(sibling)) return sibling;
  const sourceCopy = path.resolve(THIS_DIR, '../../card-compute/jsonata-sync.cjs');
  if (fs.existsSync(sourceCopy)) return sourceCopy;
  return path.resolve(THIS_DIR, '../../../lib/jsonata-sync.cjs');
}

const jsonata = require(resolveJsonataCjsPath()) as (expr: string) => JsonataExpression;

function registerJsonataHelpers(expr: JsonataExpression): void {
  expr.registerFunction?.('fsPathRef', (value: unknown) => serializeRef({ kind: 'fs-path', value: String(value) }), '<s:s>');
}

function resolveWhatToRunValue(whatToRun: string | KindValueRef): string {
  return typeof whatToRun === 'string' ? parseRef(whatToRun).value : whatToRun.value;
}

function isLocalNodeExecutionRef(ref: ExecutionRef): ref is LocalNodeExecutionRef {
  return ref.howToRun === 'local-node' || ref.howToRun === 'local-process';
}

function isHttpExecutionRef(ref: ExecutionRef): ref is HttpExecutionRef {
  return ref.howToRun === 'http:post' || ref.howToRun === 'http:get';
}

function isInProcessExecutionRef(ref: ExecutionRef): ref is InProcessExecutionRef {
  return ref.howToRun === 'in-process-loop';
}

function normalizeLocalNodeCallbackRef(via: LocalNodeExecutionRef): { whatToRun: string; extra?: Record<string, unknown> } {
  return {
    ...via,
    whatToRun: typeof via.whatToRun === 'string' ? via.whatToRun : serializeRef(via.whatToRun),
  };
}

function normalizeExecutionRef(ref: ExecutionRef): ExecutionRef {
  return typeof ref.whatToRun === 'string'
    ? ref
    : { ...ref, whatToRun: serializeRef(ref.whatToRun) };
}

function normalizeHandlerResult(raw: unknown, stepName: string): NormalizedHandlerResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`[board-worker-adapter] Step "${stepName}" returned a non-object result.`);
  }

  const obj = raw as Record<string, unknown>;
  const result = obj.result ?? obj.status;
  if (typeof result === 'string' && result.trim()) {
    const data = obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)
      ? { ...(obj.data as Record<string, unknown>) }
      : {};
    const error = typeof obj.error === 'string' ? obj.error : undefined;
    if (error && !Object.prototype.hasOwnProperty.call(data, 'error')) {
      data.error = error;
    }
    return error ? { result, data, error } : { result, data };
  }

  return { result: 'success', data: { ...obj } };
}

function createFailureResult(message: string): NormalizedHandlerResult {
  return {
    result: 'failure',
    data: { error: message },
    error: message,
  };
}

function evalJsonataValue(expr: string, context: Record<string, unknown>, label: string): unknown {
  try {
    const compiled = jsonata(expr);
    registerJsonataHelpers(compiled);
    return compiled.evaluate(context);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`[${label}] JSONata evaluation failed for "${expr}": ${message}`);
  }
}

function resolveArgsMassaging(
  argsMassaging: ArgsMassaging | undefined,
  context: Record<string, unknown>,
  label: string,
): MassagedArgs {
  if (!argsMassaging || typeof argsMassaging !== 'object') return {};

  const massaged: MassagedArgs = {};
  if (Array.isArray(argsMassaging.cmdTemplate)) {
    massaged.cmdArgs = argsMassaging.cmdTemplate.map((expr) => String(evalJsonataValue(expr, context, `${label}.cmdTemplate`)));
  }
  if (typeof argsMassaging.stdinTemplate === 'string') {
    massaged.stdin = evalJsonataValue(argsMassaging.stdinTemplate, context, `${label}.stdinTemplate`);
  }
  if (typeof argsMassaging.urlTemplate === 'string') {
    massaged.url = String(evalJsonataValue(argsMassaging.urlTemplate, context, `${label}.urlTemplate`));
  }
  if (typeof argsMassaging.headerTemplate === 'string') {
    const value = evalJsonataValue(argsMassaging.headerTemplate, context, `${label}.headerTemplate`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`[${label}.headerTemplate] expected an object result`);
    }
    massaged.headers = value as Record<string, string>;
  }
  if (typeof argsMassaging.bodyTemplate === 'string') {
    massaged.body = evalJsonataValue(argsMassaging.bodyTemplate, context, `${label}.bodyTemplate`);
  }
  return massaged;
}

function parseStepMachineOutput(stdout: string): unknown {
  const text = String(stdout || '').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { stdout: text };
  }
}

export async function invokeBoardWorker(
  via: ExecutionRef,
  request: BoardWorkerInvokeRequest,
): Promise<BoardWorkerInvokeResult> {
  const mergedRequest = mergeBoardWorkerInvokeRequest(via, request);
  if (isLocalNodeExecutionRef(via)) {
    return invokeBoardWorkerLocalNode(via, mergedRequest);
  }
  if (via.howToRun === 'http:post') {
    return invokeBoardWorkerHttp(resolveWhatToRunValue(via.whatToRun), mergedRequest);
  }
  if (isInProcessExecutionRef(via)) {
    return invokeBoardWorkerInProcess(mergedRequest, resolveWhatToRunValue(via.whatToRun));
  }
  throw new Error(`invokeBoardWorker: unsupported via.howToRun "${via.howToRun}"`);
}

export function invokeBoardWorkerSync(
  via: ExecutionRef,
  request: BoardWorkerInvokeRequest,
): BoardWorkerInvokeResult {
  const mergedRequest = mergeBoardWorkerInvokeRequest(via, request);
  if (isLocalNodeExecutionRef(via)) {
    return invokeBoardWorkerLocalNode(via, mergedRequest);
  }
  if (via.howToRun === 'http:post') {
    return invokeBoardWorkerHttpSync(resolveWhatToRunValue(via.whatToRun), mergedRequest);
  }
  throw new Error(`invokeBoardWorkerSync: unsupported via.howToRun "${via.howToRun}"`);
}

function resolveStepMachineLocalInvocation(ref: ExecutionRef): { command: string; baseArgs: string[] } {
  const target = parseWhatToRun(ref.whatToRun);
  switch (ref.howToRun) {
    case 'local-node':
      return { command: process.execPath, baseArgs: [target] };
    case 'local-python':
      return { command: process.platform === 'win32' ? 'python' : 'python3', baseArgs: [target] };
    case 'local-process':
      return { command: target, baseArgs: [] };
    default:
      throw new Error(`invokeStepMachineExecutionRef: unsupported local transport "${ref.howToRun}"`);
  }
}

function resolveOutputTransforms(
  transforms: OutputTransforms | undefined,
  raw: NormalizedHandlerResult,
  label: string,
): NormalizedHandlerResult {
  if (!transforms || typeof transforms !== 'object') return raw;

  const context = { output: raw };
  let result = raw.result;
  let data = raw.data;
  let error = raw.error;

  if (typeof transforms.resultExpr === 'string') {
    const value = evalJsonataValue(transforms.resultExpr, context, `${label}.resultExpr`);
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(`[${label}.resultExpr] expected a non-empty string result`);
    }
    result = value;
  }
  if (typeof transforms.dataTemplate === 'string') {
    const value = evalJsonataValue(transforms.dataTemplate, context, `${label}.dataTemplate`);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`[${label}.dataTemplate] expected an object result`);
    }
    data = value as Record<string, unknown>;
  }
  if (typeof transforms.errorExpr === 'string') {
    const value = evalJsonataValue(transforms.errorExpr, context, `${label}.errorExpr`);
    error = value != null ? String(value) : undefined;
  }

  return error !== undefined ? { result, data, error } : { result, data };
}

function invokeStepMachineLocal(
  ref: ExecutionRef,
  args: Record<string, unknown>,
  options: StepMachineInvokeOptions,
  context: Record<string, unknown>,
): NormalizedHandlerResult {
  const label = options.label || 'invokeStepMachineExecutionRef';
  const massaged = resolveArgsMassaging(ref.argsMassaging, context, label);
  const { command, baseArgs } = resolveStepMachineLocalInvocation(ref);
  const stdinPayload = massaged.stdin !== undefined ? massaged.stdin : args;
  const result = spawnSync(command, [...baseArgs, ...(massaged.cmdArgs || [])], {
    encoding: 'utf-8',
    windowsHide: true,
    ...(stdinPayload !== undefined ? { input: JSON.stringify(stdinPayload) } : {}),
    ...(typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? { timeout: Math.floor(options.timeoutMs) } : {}),
    ...(ref.howToRun === 'local-process' && process.platform === 'win32' ? { shell: true } : {}),
  });

  if (result.error) {
    const message = result.error instanceof Error ? result.error.message : String(result.error);
    return createFailureResult(message);
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    return createFailureResult(result.stderr?.trim() || `process exited ${result.status}`);
  }

  const normalized = normalizeHandlerResult(parseStepMachineOutput(result.stdout || ''), label);
  if (ref.outputTransforms && normalized.result === 'success') {
    return resolveOutputTransforms(ref.outputTransforms, normalized, label);
  }
  return normalized;
}

async function invokeStepMachineHttp(
  ref: ExecutionRef,
  args: Record<string, unknown>,
  options: StepMachineInvokeOptions,
  context: Record<string, unknown>,
): Promise<NormalizedHandlerResult> {
  const label = options.label || 'invokeStepMachineExecutionRef';
  const massaged = resolveArgsMassaging(ref.argsMassaging, context, label);
  const url = massaged.url || resolveWhatToRunValue(ref.whatToRun);
  const headers = {
    'Content-Type': 'application/json',
    ...(massaged.headers || {}),
  };
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? Math.floor(options.timeoutMs) : 0;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeoutHandle = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const body = massaged.body !== undefined ? massaged.body : args;
    const response = await fetch(url, {
      method: ref.howToRun === 'http:get' ? 'GET' : 'POST',
      headers,
      ...(ref.howToRun === 'http:get' ? {} : { body: JSON.stringify(body) }),
      ...(controller ? { signal: controller.signal } : {}),
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      return createFailureResult(`HTTP ${response.status}: ${text || response.statusText || 'request failed'}`);
    }
    const normalized = normalizeHandlerResult(parseStepMachineOutput(text), label);
    if (ref.outputTransforms && normalized.result === 'success') {
      return resolveOutputTransforms(ref.outputTransforms, normalized, label);
    }
    return normalized;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createFailureResult(message);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

export async function invokeStepMachineExecutionRef(
  via: ExecutionRef,
  args: Record<string, unknown>,
  options: StepMachineInvokeOptions = {},
): Promise<NormalizedHandlerResult> {
  try {
    const normalizedVia = normalizeExecutionRef(via);
    const context = {
      ...(args && typeof args === 'object' && !Array.isArray(args) ? args : {}),
      whatToRun: resolveWhatToRunValue(normalizedVia.whatToRun),
      ...(normalizedVia.extra ? { extra: normalizedVia.extra } : {}),
    };

    if (
      normalizedVia.howToRun === 'local-node'
      || normalizedVia.howToRun === 'local-python'
      || normalizedVia.howToRun === 'local-process'
    ) {
      return invokeStepMachineLocal(normalizedVia, args, options, context);
    }

    if (normalizedVia.howToRun === 'http:post' || normalizedVia.howToRun === 'http:get') {
      return invokeStepMachineHttp(normalizedVia, args, options, context);
    }

    if (normalizedVia.howToRun === 'in-process-loop') {
      const result = await invokeBoardWorkerInProcess(args, resolveWhatToRunValue(normalizedVia.whatToRun));
      const normalized = normalizeHandlerResult(result, options.label || 'invokeStepMachineExecutionRef');
      if (normalizedVia.outputTransforms && normalized.result === 'success') {
        return resolveOutputTransforms(normalizedVia.outputTransforms, normalized, options.label || 'invokeStepMachineExecutionRef');
      }
      return normalized;
    }

    return createFailureResult(`invokeStepMachineExecutionRef: unsupported howToRun "${normalizedVia.howToRun}"`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return createFailureResult(message);
  }
}

function mergeBoardWorkerInvokeRequest(
  via: ExecutionRef,
  request: BoardWorkerInvokeRequest,
): BoardWorkerInvokeRequest {
  return {
    ...request,
    ...(request.extra ? {} : (via.extra ? { extra: via.extra } : {})),
  };
}

function invokeBoardWorkerLocalNode(
  via: LocalNodeExecutionRef,
  request: BoardWorkerInvokeRequest,
): BoardWorkerInvokeResult {
  const scriptPath = parseWhatToRun(via.whatToRun);
  const { cmd, args } = resolveLocalNodeInvocation(scriptPath);
  const workerArgs = buildBoardWorkerInvokeLocalNodeArgs(request);
  const result = spawnSync(cmd, [...args, ...workerArgs], {
    encoding: 'utf-8',
    windowsHide: true,
    ...(typeof request.input === 'string' ? { input: request.input } : {}),
  });
  if (result.status !== 0) {
    const error = new Error(`invokeBoardWorker: board worker exited ${result.status}: ${result.stderr?.trim() || 'unknown error'}`) as Error & { stdout?: string; stderr?: string };
    error.stdout = result.stdout ?? '';
    error.stderr = result.stderr ?? '';
    throw error;
  }
  return parseBoardWorkerInvokeOutput(result.stdout);
}

function buildBoardWorkerInvokeLocalNodeArgs(request: BoardWorkerInvokeRequest): string[] {
  const subcommand = typeof request.subcommand === 'string' ? request.subcommand.trim() : '';
  if (!subcommand) {
    throw new Error('invokeBoardWorker: request.subcommand is required');
  }
  const args = [subcommand];
  if (typeof request.inRef === 'string' && request.inRef.trim()) args.push('--in-ref', request.inRef.trim());
  if (typeof request.outRef === 'string' && request.outRef.trim()) args.push('--out-ref', request.outRef.trim());
  if (typeof request.errRef === 'string' && request.errRef.trim()) args.push('--err-ref', request.errRef.trim());
  if (request.extra && typeof request.extra === 'object' && !Array.isArray(request.extra)) {
    args.push('--extra', Buffer.from(JSON.stringify(request.extra)).toString('base64'));
  }
  return args;
}

async function invokeBoardWorkerHttp(url: string, request: BoardWorkerInvokeRequest): Promise<BoardWorkerInvokeResult> {
  return runBoardWorkerHttp(url, request);
}

function invokeBoardWorkerHttpSync(url: string, request: BoardWorkerInvokeRequest): BoardWorkerInvokeResult {
  return runBoardWorkerHttp(url, request);
}

function runBoardWorkerHttp(url: string, request: BoardWorkerInvokeRequest): BoardWorkerInvokeResult {
  const script = `
    const rawUrl = ${JSON.stringify(url)};
    const rawBody = ${JSON.stringify(JSON.stringify(request))};
    const u = new URL(rawUrl);
    const mod = require(u.protocol === 'https:' ? 'https' : 'http');
    const req = mod.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawBody) } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        const code = res.statusCode || 500;
        if (code < 200 || code >= 300) {
          process.stderr.write(body.trim() || res.statusMessage || ('HTTP ' + code));
          process.exit(1);
        }
        process.stdout.write(body);
      });
    });
    req.on('error', (err) => { process.stderr.write(err.message); process.exit(1); });
    req.write(rawBody);
    req.end();
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`invokeBoardWorker: http-post failed: ${result.stderr?.trim() || 'unknown error'}`);
  }
  return parseBoardWorkerInvokeOutput(result.stdout);
}

function parseBoardWorkerInvokeOutput(stdout: string): BoardWorkerInvokeResult {
  const text = String(stdout || '').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { stdout: text };
  }
}

function parseWhatToRun(whatToRun: string | KindValueRef): string {
  const parsed = typeof whatToRun === 'string' ? parseRef(whatToRun) : whatToRun;
  if (parsed.kind === 'yaml-flow-cli') {
    const trimmed = path.basename(parsed.value.trim());
    if (!trimmed) {
      throw new Error(`Invalid yaml-flow-cli ref: expected non-empty cli file name, got ${JSON.stringify(parsed.value)}`);
    }
    const packageRoot = path.dirname(require.resolve('yaml-flow/package.json'));
    const stem = trimmed.replace(/\.[^.]+$/, '');
    const bundled = path.join(packageRoot, 'cli', 'bundled', `${stem}.mjs`);
    if (fs.existsSync(bundled)) return bundled;
    const legacy = path.join(packageRoot, 'cli', 'node', trimmed);
    if (fs.existsSync(legacy)) return legacy;
    throw new Error(`Invalid yaml-flow-cli ref: could not find ${trimmed} under cli/bundled or cli/node in ${packageRoot}`);
  }
  return parsed.value;
}

function resolveLocalNodeInvocation(scriptPath: string): { cmd: string; args: string[] } {
  if (!scriptPath.endsWith('.ts')) {
    return { cmd: process.execPath, args: [scriptPath] };
  }
  const dir = path.dirname(scriptPath);
  const candidates: string[] = [];
  for (let up = 1; up <= 5; up++) {
    const base = path.join(dir, ...Array(up).fill('..'), 'node_modules');
    candidates.push(path.join(base, 'tsx', 'dist', 'cli.mjs'));
    candidates.push(path.join(base, '.bin', 'tsx'));
  }
  const tsx = candidates.find((candidatePath) => fs.existsSync(candidatePath));
  if (tsx) return { cmd: process.execPath, args: [tsx, scriptPath] };
  return { cmd: 'npx', args: ['tsx', scriptPath] };
}

export function createImmediateBoardWorkerRef(
  scriptPath: string,
  extra?: Record<string, unknown>,
): LocalNodeExecutionRef {
  const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(process.cwd(), scriptPath);
  return {
    meta: 'task-executor',
    howToRun: 'local-node',
    whatToRun: serializeRef({ kind: 'fs-path', value: resolved }),
    ...(extra ? { extra } : {}),
  };
}

export async function loadImmediateBoardWorkerHandler(
  scriptPath: string,
): Promise<ImmediateBoardWorkerHandler> {
  const resolved = path.isAbsolute(scriptPath) ? scriptPath : path.resolve(process.cwd(), scriptPath);
  const mod = await import(pathToFileURL(resolved).href);
  const execute = typeof mod.executeTaskExecutorRequest === 'function'
    ? mod.executeTaskExecutorRequest
    : (typeof mod.executeBoardWorkerRequest === 'function' ? mod.executeBoardWorkerRequest : undefined);
  if (typeof execute !== 'function') {
    throw new Error(`Immediate board worker module must export executeTaskExecutorRequest(request) or executeBoardWorkerRequest(request): ${resolved}`);
  }
  return execute as ImmediateBoardWorkerHandler;
}

export function createImmediateBoardWorkerHook(
  execute: ImmediateBoardWorkerHandler,
  defaultExtra: Record<string, unknown> = {},
): ImmediateBoardWorkerHandler {
  return async ({ subcommand, input, timeoutMs, extra }: ImmediateBoardWorkerRequest) => {
    if (typeof subcommand !== 'string' || !subcommand.trim()) {
      throw new Error('Immediate board worker hook requires subcommand');
    }
    const mergedExtra = {
      ...defaultExtra,
      ...(extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {}),
    };
    return await execute({
      subcommand,
      ...(input !== undefined ? { input } : {}),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(Object.keys(mergedExtra).length > 0 ? { extra: mergedExtra } : {}),
    });
  };
}

/**
 * Report successful task completion back to the board.
 * Call this from a task-executor after writing the result to outRef.
 */
export function reportComplete(callback: TaskCallback, outRef: KindValueRef): void {
  const { token, via } = callback;
  if (isLocalNodeExecutionRef(via)) {
    reportBoardWorkerCallbackLocalNodeSuccess(normalizeLocalNodeCallbackRef(via), token, serializeRef(outRef));
    return;
  }
  if (isHttpExecutionRef(via)) {
    reportBoardWorkerCallbackHttpSuccess(resolveWhatToRunValue(via.whatToRun), token, serializeRef(outRef));
    return;
  }
  if (isInProcessExecutionRef(via)) {
    reportBoardWorkerCallbackInProcess({ token, outcome: 'success', ref: serializeRef(outRef) }, resolveWhatToRunValue(via.whatToRun));
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
  if (isLocalNodeExecutionRef(via)) {
    reportBoardWorkerCallbackLocalNodeFailure(normalizeLocalNodeCallbackRef(via), token, reason);
    return;
  }
  if (isHttpExecutionRef(via)) {
    reportBoardWorkerCallbackHttpFailure(resolveWhatToRunValue(via.whatToRun), token, reason);
    return;
  }
  if (isInProcessExecutionRef(via)) {
    reportBoardWorkerCallbackInProcess({ token, outcome: 'failure', reason }, resolveWhatToRunValue(via.whatToRun));
    return;
  }
  throw new Error(`reportFailed: unsupported via.howToRun "${via.howToRun}"`);
}
