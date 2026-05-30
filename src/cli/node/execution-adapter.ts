/**
 * execution-adapter.ts
 *
 * Node.js-specific adapter that resolves an ExecutionRef + logical args
 * into a physical invocation (process spawn, HTTP request, or built-in call).
 *
 * This is the platform layer that pairs with execution-interface.ts (pure types).
 * Import this only from Node contexts — not from browser bundles.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WELL-KNOWN INVOCATION KINDS
 * ────────────────────────────────────────────────────────────────────────────
 *
 *  invokeTaskExecutor(ref, args)
 *    Standard task-executor protocol.
 *    Logical args: { subcommand, inRef, outRef, errRef?, extra? }
 *    Default cmdTemplate (local): ['subcommand', '--in-ref', inRef, '--out-ref', outRef, '--err-ref', errRef]
 *    Default body (http):         { subcommand, inRef, outRef, errRef }
 *
 *  invokeBoardCliCallback(ref, args)
 *    Back-channel from a task-executor to the board CLI.
 *    Logical args: { command, argv[] }
 *    Resolves 'built-in' to the board CLI script alongside cliDir.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * BUILT-IN RESOLUTION
 * ────────────────────────────────────────────────────────────────────────────
 *
 *  howToRun: 'built-in' with whatToRun: 'b64:<base64url({"kind":"built-in","value":"source-cli-task-executor"})>'
 *  → resolves to node <cliDir>/source-cli-task-executor.js
 *
 *  howToRun: 'built-in' with whatToRun: 'b64:<base64url({"kind":"built-in","value":"board-live-cards"})>'
 *  → resolves to node <cliDir>/board-live-cards-cli.js (via buildBoardCliInvocation)
 *
 * ────────────────────────────────────────────────────────────────────────────
 * argsMassaging EVALUATION
 * ────────────────────────────────────────────────────────────────────────────
 *
 *  Each argsMassaging field is a JSONata expression evaluated against the
 *  logical args object merged with { whatToRun } (the address from the ref).
 *
 *  If argsMassaging is absent, the adapter uses its default mapping.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { jsonata } from '../common/jsonata-loader.js';
import type { ArgsMassaging, ExecutionRef, ExecutionResult } from '../common/execution-interface.js';
import { parseRef, serializeRef } from '../common/storage-interface.js';
import type { KindValueRef } from '../common/storage-interface.js';
import { buildBoardCliInvocation, runSync, runDetached } from './process-runner.js';

const require = createRequire(import.meta.url);

// ============================================================================
// Logical args shapes for well-known invocation kinds
// ============================================================================

/** Logical args for invokeTaskExecutor — standard task-executor protocol. */
export interface TaskExecutorArgs {
  /** Subcommand to dispatch: 'run-source-fetch' | 'validate-source-def' | 'describe-capabilities' | ... */
  subcommand: string;
  /** Input ref (b64:<base64url(json)> wire form) pointing to the task payload. */
  inRef?: string;
  /** Output ref (b64:<base64url(json)> wire form) where the executor writes its result. */
  outRef?: string;
  /** Error ref (b64:<base64url(json)> wire form) for structured error output. */
  errRef?: string;
}

/** Logical args for invokeBoardCliCallback — back-channel from executor to board. */
export interface BoardCliCallbackArgs {
  /** Board CLI subcommand to invoke (e.g. 'source-data-fetched', 'source-data-fetch-failure'). */
  command: string;
  /** Additional argv strings passed after the command. */
  argv: string[];
}

// ============================================================================
// ExecutionAdapterOptions
// ============================================================================

/**
 * Options passed when constructing an execution adapter.
 * Provides the platform-specific context needed for built-in resolution.
 */
export interface ExecutionAdapterOptions {
  /**
   * Absolute path to the directory containing the compiled CLI files.
   * Required for resolving 'built-in' refs (e.g. source-cli-task-executor.js,
   * board-live-cards-cli.js).
   */
  cliDir: string;
}

function parseWhatToRunRef(whatToRun: string | KindValueRef): KindValueRef {
  return typeof whatToRun === 'object' ? whatToRun : parseRef(whatToRun);
}

export function resolveYamlFlowCliPath(cliFileName: string): string {
  const trimmed = path.basename(String(cliFileName || '').trim());
  if (!trimmed) {
    throw new Error(`resolveYamlFlowCliPath: expected non-empty cli file name, got ${JSON.stringify(cliFileName)}`);
  }
  const packageRoot = path.dirname(require.resolve('yaml-flow/package.json'));
  // Prefer cli/bundled/<stem>.mjs (shipped); fall back to cli/node/<trimmed> for dev/legacy.
  const stem = trimmed.replace(/\.[^.]+$/, '');
  const bundled = path.join(packageRoot, 'cli', 'bundled', `${stem}.mjs`);
  if (fs.existsSync(bundled)) return bundled;
  const legacy = path.join(packageRoot, 'cli', 'node', trimmed);
  if (fs.existsSync(legacy)) return legacy;
  throw new Error(`resolveYamlFlowCliPath: could not find ${trimmed} under cli/bundled or cli/node in ${packageRoot}`);
}

export function resolveWhatToRunValue(whatToRun: string | KindValueRef): string {
  const ref = parseWhatToRunRef(whatToRun);
  switch (ref.kind) {
    case 'yaml-flow-cli':
      return resolveYamlFlowCliPath(ref.value);
    default:
      return ref.value;
  }
}

// ============================================================================
// JSONata evaluation helper
// ============================================================================

/**
 * Evaluate a single JSONata expression against a context object.
 * Returns the result as-is (string, object, array, etc.).
 */
async function evalJsonata(expr: string, context: Record<string, unknown>): Promise<unknown> {
  const compiled = jsonata(expr);
  return compiled.evaluate(context);
}

/**
 * Evaluate a JSONata expression and coerce the result to a string.
 * Throws if the result is not a string.
 */
async function evalJsonataString(expr: string, context: Record<string, unknown>): Promise<string> {
  const result = await evalJsonata(expr, context);
  if (typeof result !== 'string') {
    throw new Error(`argsMassaging expression did not produce a string: ${expr} → ${JSON.stringify(result)}`);
  }
  return result;
}

// ============================================================================
// Built-in ref resolution
// ============================================================================

/**
 * Resolve a 'built-in' ExecutionRef to a concrete { command, args } invocation.
 * The whatToRun value names the built-in implementation.
 *
 * Supported built-in names:
 *   source-cli-task-executor  → node <cliDir>/source-cli-task-executor.js
 *   board-live-cards          → node <cliDir>/board-live-cards-cli.js (via buildBoardCliInvocation)
 */
function resolveBuiltIn(whatToRun: string | { kind: string; value: string }, cliDir: string): { command: string; args: string[] } {
  // whatToRun must be a b64 KindValueRef string or a plain-object ref
  const name = resolveWhatToRunValue(whatToRun);

  switch (name) {
    case 'source-cli-task-executor': {
      const jsPath = path.join(cliDir, 'source-cli-task-executor.js');
      if (fs.existsSync(jsPath)) {
        return { command: process.execPath, args: [jsPath] };
      }
      const tsPath = path.join(cliDir, 'source-cli-task-executor.ts');
      const tsxMjs = path.join(cliDir, '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');
      const tsxBin = path.join(cliDir, '..', '..', 'node_modules', '.bin', 'tsx');
      const tsx = fs.existsSync(tsxMjs) ? tsxMjs : tsxBin;
      if (fs.existsSync(tsPath) && fs.existsSync(tsx)) {
        return { command: process.execPath, args: [tsx, tsPath] };
      }
      return { command: process.execPath, args: [jsPath] }; // fallback — will fail with clear error
    }
    case 'board-live-cards': {
      const { cmd, args } = buildBoardCliInvocation(cliDir, '_', []);
      return { command: cmd, args };
    }
    default:
      throw new Error(`resolveBuiltIn: unknown built-in name "${name}". Supported: source-cli-task-executor, board-live-cards`);
  }
}

/**
 * Resolve an ExecutionRef's whatToRun + howToRun to a base { command, args }
 * for local transports, or a URL string for http transports.
 */
function resolveBaseInvocation(
  ref: ExecutionRef,
  cliDir: string,
): { command: string; baseArgs: string[] } {
  if (ref.howToRun === 'built-in') {
    const { command, args } = resolveBuiltIn(ref.whatToRun, cliDir);
    return { command, baseArgs: args };
  }

  // For local-* transports, resolve the whatToRun as a KindValueRef
  const scriptPath: string = typeof ref.whatToRun === 'object'
    ? resolveWhatToRunValue(ref.whatToRun)
    : resolveWhatToRunValue(ref.whatToRun);

  switch (ref.howToRun) {
    case 'local-node':
      return { command: process.execPath, baseArgs: [scriptPath] };
    case 'local-python': {
      const python = process.platform === 'win32' ? 'python' : 'python3';
      return { command: python, baseArgs: [scriptPath] };
    }
    case 'local-process':
      return { command: scriptPath, baseArgs: [] };
    default:
      throw new Error(`resolveBaseInvocation: howToRun "${ref.howToRun}" is not a local transport`);
  }
}

// ============================================================================
// Default arg mappings per invocation kind
// ============================================================================

/**
 * Build the default argv for a task-executor invocation (local transports).
 * Protocol: <subcommand> [--in-ref <inRef>] [--out-ref <outRef>] [--err-ref <errRef>] [--extra <base64>]
 *
 * @param extra  Opaque executor config from ExecutionRef.extra — base64-encoded before passing.
 */
function buildDefaultTaskExecutorArgv(
  args: TaskExecutorArgs,
  extra?: Record<string, unknown>,
): string[] {
  const argv: string[] = [args.subcommand];
  if (args.inRef)  argv.push('--in-ref',  args.inRef);
  if (args.outRef) argv.push('--out-ref', args.outRef);
  if (args.errRef) argv.push('--err-ref', args.errRef);
  if (extra) argv.push('--extra', Buffer.from(JSON.stringify(extra)).toString('base64'));
  return argv;
}

/**
 * Build the default HTTP body for a task-executor invocation.
 *
 * @param extra  Opaque executor config from ExecutionRef.extra — passed as-is in the body.
 */
function buildDefaultTaskExecutorBody(
  args: TaskExecutorArgs,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    subcommand: args.subcommand,
    ...(args.inRef  ? { inRef:  args.inRef  } : {}),
    ...(args.outRef ? { outRef: args.outRef } : {}),
    ...(args.errRef ? { errRef: args.errRef } : {}),
    ...(extra       ? { extra }               : {}),
  };
}

// ============================================================================
// buildLocalBaseSpec — sync helper for callers that stay synchronous
// ============================================================================

/**
 * Resolve an ExecutionRef to its base { command, baseArgs } for local transports.
 *
 * Exported for callers that need to stay synchronous (e.g. validate-source-def,
 * describe-capabilities) and build their own final argv.
 * Does NOT evaluate argsMassaging — append custom argv after baseArgs.
 *
 * @example
 *   const { command, baseArgs } = buildLocalBaseSpec(teRef, cliDir);
 *   executor.executeSync(command, [...baseArgs, 'describe-capabilities'], { timeout: 10_000 });
 */
export function buildLocalBaseSpec(
  ref: ExecutionRef,
  cliDir: string,
): { command: string; baseArgs: string[] } {
  return resolveBaseInvocation(ref, cliDir);
}

// ============================================================================
// invokeRefSync — synchronous request/reply for ref-based invocations
// ============================================================================

import { resolveArgsMassaging } from '../common/args-massaging.js';
import type { MassagedArgs } from '../common/args-massaging.js';
import { createNodeCommandExecutor } from './process-runner.js';

/** Normalized envelope returned by invokeRefSync. */
export interface InvokeRefResult {
  /** Outcome key — drives transitions in the step machine ('success' | 'failure' | custom). */
  result: string;
  /** Response payload as a record (always object-shaped; raw stdout wrapped under `stdout` if not JSON object). */
  data: Record<string, unknown>;
  /** Optional human-readable error detail. */
  error?: string;
}

export interface InvokeRefSyncOptions {
  /** Directory used to resolve `built-in` refs (defaults to ref's cwd / process cwd). */
  cliDir?: string;
  /** Working directory for the spawned child (default: process cwd). */
  cwd?: string;
  /** Timeout in milliseconds (default: 30_000). */
  timeoutMs?: number;
  /** Label used in error messages (default: 'invokeRefSync'). */
  label?: string;
}

export interface InvokeExecutionRefOptions extends InvokeRefSyncOptions {
  /** Extra async transport handlers keyed by `ExecutionRef.howToRun`. */
  transports?: Record<string, TransportInvoker>;
  /** Extra synchronous transport handlers keyed by `ExecutionRef.howToRun`. */
  syncTransports?: Record<string, SyncTransportInvoker>;
}

export type TransportInvoker = (
  ref: ExecutionRef,
  args: Record<string, unknown>,
  options?: InvokeExecutionRefOptions,
) => Promise<InvokeRefResult>;

export type InProcessExecutionHandler = (
  ref: ExecutionRef,
  args: Record<string, unknown>,
  options?: InvokeExecutionRefOptions,
) => Promise<InvokeRefResult> | InvokeRefResult;

const inProcessExecutionHandlerRegistry = new Map<string, InProcessExecutionHandler>();

export function registerInProcessExecutionHandler(key: string, handler: InProcessExecutionHandler): void {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) {
    throw new Error('registerInProcessExecutionHandler: key is required');
  }
  inProcessExecutionHandlerRegistry.set(normalizedKey, handler);
}

export function unregisterInProcessExecutionHandler(key: string): void {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return;
  inProcessExecutionHandlerRegistry.delete(normalizedKey);
}

export type SyncTransportInvoker = (
  ref: ExecutionRef,
  args: Record<string, unknown>,
  options?: InvokeExecutionRefOptions,
) => InvokeRefResult;

export interface CreateExecutionRefInvokerOptions extends InvokeExecutionRefOptions {}

export interface ExecutionRefInvoker {
  invoke(ref: ExecutionRef, args: Record<string, unknown>): Promise<InvokeRefResult>;
  invokeSync(ref: ExecutionRef, args: Record<string, unknown>): InvokeRefResult;
}

function _parseStdoutAsJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error('empty stdout');
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    const last = lines[lines.length - 1];
    return JSON.parse(last);
  }
}

function buildMassagingContext(ref: ExecutionRef, args: Record<string, unknown>): Record<string, unknown> {
  return {
    ...args,
    whatToRun: resolveWhatToRunValue(ref.whatToRun),
    ...(ref.extra ? { extra: ref.extra } : {}),
  };
}

export function evaluateArgsMassaging(
  argsMassaging: ArgsMassaging | undefined,
  args: Record<string, unknown>,
  label = 'invokeExecutionRef',
): MassagedArgs {
  return resolveArgsMassaging(argsMassaging, args, label);
}

function normalizeSuccessPayload(payload: unknown): InvokeRefResult {
  if (
    payload
    && typeof payload === 'object'
    && !Array.isArray(payload)
    && typeof (payload as { result?: unknown }).result === 'string'
    && (payload as { data?: unknown }).data
    && typeof (payload as { data?: unknown }).data === 'object'
    && !Array.isArray((payload as { data?: unknown }).data)
  ) {
    return payload as InvokeRefResult;
  }

  const data: Record<string, unknown> =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : { stdout: payload };

  return { result: 'success', data };
}

function normalizeFailure(message: string): InvokeRefResult {
  return { result: 'failure', data: { error: message } };
}

function invokeLocalExecutionRefSync(
  ref: ExecutionRef,
  args: Record<string, unknown>,
  options?: InvokeExecutionRefOptions,
): InvokeRefResult {
  const label = options?.label ?? 'invokeExecutionRefSync';
  const cliDir = options?.cliDir ?? options?.cwd ?? process.cwd();

  let massaged: MassagedArgs;
  try {
    massaged = evaluateArgsMassaging(ref.argsMassaging, buildMassagingContext(ref, args), label);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return normalizeFailure(msg);
  }

  let baseSpec;
  try {
    baseSpec = buildLocalBaseSpec(ref, cliDir);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return normalizeFailure(`[${label}] ref resolution failed: ${msg}`);
  }

  const argv = [...baseSpec.baseArgs, ...(massaged.cmdArgs ?? [])];
  const stdinPayload = JSON.stringify(massaged.stdin ?? args);
  const executor = createNodeCommandExecutor();

  let stdout: string;
  try {
    stdout = executor.executeSync(baseSpec.command, argv, {
      timeout: options?.timeoutMs ?? 30_000,
      encoding: 'utf-8',
      cwd: options?.cwd,
      input: stdinPayload,
    });
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: Buffer | string; status?: number | null };
    const stderr = (e.stderr ? String(e.stderr) : '').trim();
    const status = typeof e.status === 'number' ? e.status : 'unknown';
    const detail = stderr || e.message;
    return normalizeFailure(`[${label}] ref exited with status ${status}${detail ? `: ${detail}` : ''}`);
  }

  try {
    return normalizeSuccessPayload(_parseStdoutAsJson(stdout));
  } catch {
    return { result: 'success', data: { stdout: stdout.trim() } };
  }
}

async function invokeHttpExecutionRef(
  ref: ExecutionRef,
  args: Record<string, unknown>,
  options?: InvokeExecutionRefOptions,
): Promise<InvokeRefResult> {
  const label = options?.label ?? 'invokeExecutionRef';

  let massaged: MassagedArgs;
  try {
    massaged = evaluateArgsMassaging(ref.argsMassaging, buildMassagingContext(ref, args), label);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return normalizeFailure(msg);
  }

  const baseUrl = resolveWhatToRunValue(ref.whatToRun);
  const headers = massaged.headers
    ? { 'Content-Type': 'application/json', ...massaged.headers }
    : { 'Content-Type': 'application/json' };

  let url = massaged.url ?? baseUrl;
  let body: string | undefined;

  if (ref.howToRun === 'http:get') {
    const querySource = massaged.body && typeof massaged.body === 'object' && !Array.isArray(massaged.body)
      ? massaged.body as Record<string, unknown>
      : args;
    const params = new URLSearchParams(
      Object.entries(querySource)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => [key, String(value)]),
    );
    if (params.size > 0) {
      url = `${url}${url.includes('?') ? '&' : '?'}${params.toString()}`;
    }
  } else {
    body = JSON.stringify(massaged.body ?? args);
  }

  try {
    const response = await fetch(url, {
      method: ref.howToRun === 'http:get' ? 'GET' : 'POST',
      headers,
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return normalizeFailure(`[${label}] HTTP ${response.status}${text ? `: ${text}` : ''}`);
    }

    const text = await response.text();
    if (!text.trim()) return { result: 'success', data: {} };

    try {
      return normalizeSuccessPayload(_parseStdoutAsJson(text));
    } catch {
      return { result: 'success', data: { stdout: text.trim() } };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return normalizeFailure(`[${label}] ${msg}`);
  }
}

async function invokeInProcessExecutionRef(
  ref: ExecutionRef,
  args: Record<string, unknown>,
  options?: InvokeExecutionRefOptions,
): Promise<InvokeRefResult> {
  const label = options?.label ?? 'invokeExecutionRef';
  const handlerKey = resolveWhatToRunValue(ref.whatToRun).trim();
  if (!handlerKey) {
    return normalizeFailure(`[${label}] in-process-loop requires a non-empty handler key`);
  }
  const handler = inProcessExecutionHandlerRegistry.get(handlerKey);
  if (!handler) {
    return normalizeFailure(`[${label}] no in-process handler registered for: ${handlerKey}`);
  }
  try {
    return await handler(ref, args, options);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return normalizeFailure(`[${label}] ${msg}`);
  }
}

const defaultAsyncTransportInvokers: Record<string, TransportInvoker> = {
  'local-node': async (ref, args, options) => invokeLocalExecutionRefSync(ref, args, options),
  'local-python': async (ref, args, options) => invokeLocalExecutionRefSync(ref, args, options),
  'local-process': async (ref, args, options) => invokeLocalExecutionRefSync(ref, args, options),
  'built-in': async (ref, args, options) => invokeLocalExecutionRefSync(ref, args, options),
  'http:post': invokeHttpExecutionRef,
  'http:get': invokeHttpExecutionRef,
  'in-process-loop': invokeInProcessExecutionRef,
};

const defaultSyncTransportInvokers: Record<string, SyncTransportInvoker> = {
  'local-node': invokeLocalExecutionRefSync,
  'local-python': invokeLocalExecutionRefSync,
  'local-process': invokeLocalExecutionRefSync,
  'built-in': invokeLocalExecutionRefSync,
};

export async function invokeExecutionRef(
  ref: ExecutionRef,
  args: Record<string, unknown>,
  options?: InvokeExecutionRefOptions,
): Promise<InvokeRefResult> {
  const transport = options?.transports?.[ref.howToRun] ?? defaultAsyncTransportInvokers[ref.howToRun];
  if (!transport) {
    return normalizeFailure(`[${options?.label ?? 'invokeExecutionRef'}] unsupported howToRun: ${ref.howToRun}`);
  }
  return transport(ref, args, options);
}

export function invokeExecutionRefSync(
  ref: ExecutionRef,
  args: Record<string, unknown>,
  options?: InvokeExecutionRefOptions,
): InvokeRefResult {
  const transport = options?.syncTransports?.[ref.howToRun] ?? defaultSyncTransportInvokers[ref.howToRun];
  if (!transport) {
    return normalizeFailure(`[${options?.label ?? 'invokeExecutionRefSync'}] unsupported sync howToRun: ${ref.howToRun}`);
  }
  return transport(ref, args, options);
}

export function createExecutionRefInvoker(options?: CreateExecutionRefInvokerOptions): ExecutionRefInvoker {
  return {
    invoke(ref: ExecutionRef, args: Record<string, unknown>): Promise<InvokeRefResult> {
      return invokeExecutionRef(ref, args, options);
    },
    invokeSync(ref: ExecutionRef, args: Record<string, unknown>): InvokeRefResult {
      return invokeExecutionRefSync(ref, args, options);
    },
  };
}

/**
 * Invoke an ExecutionRef synchronously with a request/reply contract.
 *
 * Used by:
 *   - step-machine ref steps (each step's handler dispatches through here)
 *   - any utility that needs sync request/reply against an ExecutionRef
 *
 * Behavior:
 *   1. Resolve `ref.argsMassaging` against `args` to get cmdArgs / stdin / body.
 *   2. Build the local base spec (node/python/process + script path).
 *   3. Spawn synchronously with `JSON.stringify(stdin ?? args)` on stdin.
 *   4. Map exit code into envelope:
 *        exit 0 → { result: 'success', data: parsed-stdout-or-{stdout: raw} }
 *        non-0  → { result: 'failure', data: { error: stderr-or-exit-detail } }
 *
 * The framework (engine) never inspects payload shape; it only routes on `result`.
 */
export function invokeRefSync(
  ref: ExecutionRef,
  args: Record<string, unknown>,
  options?: InvokeRefSyncOptions,
): InvokeRefResult {
  return invokeExecutionRefSync(ref, args, options);
}

// ============================================================================
// createExecutionAdapter — factory
// ============================================================================

export interface ExecutionAdapter {
  /**
   * Invoke a task-executor using the standard protocol.
   * Dispatches based on howToRun; applies argsMassaging if present, otherwise
   * uses the default task-executor protocol (--in-ref / --out-ref / --err-ref).
   */
  invokeTaskExecutor(ref: ExecutionRef, args: TaskExecutorArgs): Promise<ExecutionResult>;

  /**
   * Invoke the board CLI as a back-channel callback.
   * Used by task-executors to report source-data-fetched / source-data-fetch-failure.
   * Resolves 'built-in::board-live-cards' to the board CLI script alongside cliDir.
   */
  invokeBoardCliCallback(ref: ExecutionRef, args: BoardCliCallbackArgs): ExecutionResult;
}

/**
 * Create an ExecutionAdapter bound to a specific cliDir.
 *
 * @param options.cliDir  Absolute path to the compiled CLI directory.
 *                        Used to resolve 'built-in' refs.
 */
export function createExecutionAdapter(options: ExecutionAdapterOptions): ExecutionAdapter {
  const { cliDir } = options;

  return {
    async invokeTaskExecutor(ref: ExecutionRef, args: TaskExecutorArgs): Promise<ExecutionResult> {
      const isHttp = ref.howToRun === 'http:post' || ref.howToRun === 'http:get';

      if (isHttp) {
        return _invokeTaskExecutorHttp(ref, args);
      }

      // Local transports: local-node, local-python, local-process, built-in
      const { command, baseArgs } = resolveBaseInvocation(ref, cliDir);

      let callArgv: string[];
      if (ref.argsMassaging?.cmdTemplate) {
        // Evaluate each JSONata expression in the template
        const context: Record<string, unknown> = { ...args, whatToRun: resolveWhatToRunValue(ref.whatToRun) };
        const evaluated = await Promise.all(
          ref.argsMassaging.cmdTemplate.map(expr => evalJsonataString(expr, context)),
        );
        callArgv = evaluated;
      } else {
        callArgv = buildDefaultTaskExecutorArgv(args, ref.extra);
      }

      const finalArgs = [...baseArgs, ...callArgv];
      try {
        runSync({ command, args: finalArgs });
        return { status: 'success' };
      } catch (err) {
        return { status: 'error', error: err instanceof Error ? err.message : String(err) };
      }
    },

    invokeBoardCliCallback(ref: ExecutionRef, args: BoardCliCallbackArgs): ExecutionResult {
      // Resolve the board CLI invocation
      let cmd: string;
      let baseArgs: string[];

      if (ref.howToRun === 'built-in') {
        const resolved = buildBoardCliInvocation(cliDir, args.command, args.argv);
        // buildBoardCliInvocation already includes the command and argv
        const result = spawnSync(resolved.cmd, resolved.args, { encoding: 'utf-8', windowsHide: true });
        if (result.status !== 0) {
          return { status: 'error', error: `board CLI exited ${result.status}: ${result.stderr?.trim()}` };
        }
        return { status: 'success' };
      }

      ({ command: cmd, baseArgs } = resolveBaseInvocation(ref, cliDir));
      const result = spawnSync(cmd, [...baseArgs, args.command, ...args.argv], {
        encoding: 'utf-8',
        windowsHide: true,
      });
      if (result.status !== 0) {
        return { status: 'error', error: `board CLI exited ${result.status}: ${result.stderr?.trim()}` };
      }
      return { status: 'success' };
    },
  };
}

// ============================================================================
// HTTP transport (async — used for http:post / http:get)
// ============================================================================

async function _invokeTaskExecutorHttp(
  ref: ExecutionRef,
  args: TaskExecutorArgs,
): Promise<ExecutionResult> {
  const context: Record<string, unknown> = { ...args, whatToRun: resolveWhatToRunValue(ref.whatToRun) };
  const massaged = resolveArgsMassaging(ref.argsMassaging, context, '_invokeTaskExecutorHttp');

  const url = massaged.url
    ?? resolveWhatToRunValue(ref.whatToRun);

  const body = massaged.body
    ? massaged.body as Record<string, unknown>
    : buildDefaultTaskExecutorBody(args, ref.extra);

  // Use native fetch (Node 18+)
  const defaultHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
  const headers = massaged.headers
    ? { ...defaultHeaders, ...massaged.headers }
    : defaultHeaders;

  const response = await fetch(url, {
    method: ref.howToRun === 'http:get' ? 'GET' : 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { status: 'error', error: `HTTP ${response.status}: ${text}` };
  }

  const responseJson = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (responseJson && typeof responseJson.status === 'string') {
    return responseJson as unknown as ExecutionResult;
  }
  return { status: 'success' };
}

// ============================================================================
// Well-known ExecutionRef factories
// ============================================================================

/**
 * Create an ExecutionRef for the built-in source-cli task executor.
 * Resolves to node <cliDir>/source-cli-task-executor.js at runtime.
 */
export function builtInSourceCliExecutorRef(): ExecutionRef {
  return {
    meta: 'task-executor',
    howToRun: 'built-in',
    whatToRun: serializeRef({ kind: 'built-in', value: 'source-cli-task-executor' }),
  };
}

/**
 * Create an ExecutionRef for the board CLI callback back-channel.
 * Resolves to node <cliDir>/board-live-cards-cli.js at runtime.
 */
export function builtInBoardCliRef(): ExecutionRef {
  return {
    meta: 'board-live-cards',
    howToRun: 'built-in',
    whatToRun: serializeRef({ kind: 'built-in', value: 'board-live-cards' }),
  };
}

/**
 * Create an ExecutionRef for a local Node.js task executor script.
 *
 * @param scriptPath  Absolute path to the executor .js file.
 */
export function localNodeExecutorRef(scriptPath: string): ExecutionRef {
  return {
    meta: 'task-executor',
    howToRun: 'local-node',
    whatToRun: serializeRef({ kind: 'fs-path', value: scriptPath }),
  };
}

// ============================================================================
// Detached task-executor dispatch
// ============================================================================

/**
 * Dispatch a task-executor invocation as a detached background process.
 * Used by the board source-fetch dispatcher — fire-and-forget.
 *
 * For http transports, falls back to synchronous fetch (not truly detached).
 */
export function dispatchTaskExecutorDetached(
  ref: ExecutionRef,
  args: TaskExecutorArgs,
  cliDir: string,
): void {
  const isAsyncTransport = ref.howToRun === 'http:post' || ref.howToRun === 'http:get' || ref.howToRun === 'in-process-loop';
  if (isAsyncTransport) {
    void invokeExecutionRef(ref, args as unknown as Record<string, unknown>, {
      cliDir,
      cwd: process.cwd(),
      label: 'dispatchTaskExecutorDetached',
    }).then((result) => {
      if (result.result !== 'success') {
        const detail = typeof result.data?.error === 'string' ? result.data.error : result.error;
        console.error(`[dispatchTaskExecutorDetached] dispatch failed: ${detail || result.result}`);
      }
    }).catch(err => {
      console.error(`[dispatchTaskExecutorDetached] async dispatch failed: ${(err as Error).message}`);
    });
    return;
  }

  const { command, baseArgs } = resolveBaseInvocation(ref, cliDir);
  const callArgv = buildDefaultTaskExecutorArgv(args, ref.extra);
  runDetached({ command, args: [...baseArgs, ...callArgv] });
}
