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
 *  howToRun: 'built-in' with whatToRun: '::built-in::source-cli-task-executor'
 *  → resolves to node <cliDir>/source-cli-task-executor.js
 *
 *  howToRun: 'built-in' with whatToRun: '::built-in::board-live-cards'
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

import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import jsonata from 'jsonata';
import type { ExecutionRef, ExecutionResult } from './execution-interface.js';
import { parseRef } from './storage-interface.js';
import { buildBoardCliInvocation, runSync, runDetached } from './process-runner.js';

// ============================================================================
// Logical args shapes for well-known invocation kinds
// ============================================================================

/** Logical args for invokeTaskExecutor — standard task-executor protocol. */
export interface TaskExecutorArgs {
  /** Subcommand to dispatch: 'run-source-fetch' | 'validate-source-def' | 'describe-capabilities' | ... */
  subcommand: string;
  /** Input ref (::kind::value wire form) pointing to the task payload. */
  inRef?: string;
  /** Output ref (::kind::value wire form) where the executor writes its result. */
  outRef?: string;
  /** Error ref (::kind::value wire form) for structured error output. */
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
function resolveBuiltIn(whatToRun: string, cliDir: string): { command: string; args: string[] } {
  // whatToRun is a ::kind::value ref — parse the value portion
  let name: string;
  try {
    name = parseRef(whatToRun).value;
  } catch {
    // fallback: treat as bare name
    name = whatToRun;
  }

  switch (name) {
    case 'source-cli-task-executor': {
      const scriptPath = path.join(cliDir, 'source-cli-task-executor.js');
      return { command: process.execPath, args: [scriptPath] };
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

  // For local-* transports, parse the whatToRun as a storage ref or bare path
  let scriptPath: string;
  try {
    scriptPath = parseRef(ref.whatToRun).value;
  } catch {
    scriptPath = ref.whatToRun;
  }

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
        const context: Record<string, unknown> = { ...args, whatToRun: ref.whatToRun };
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
  let url: string;
  let body: Record<string, unknown>;

  const context: Record<string, unknown> = { ...args, whatToRun: ref.whatToRun };

  if (ref.argsMassaging?.urlTemplate) {
    url = await evalJsonataString(ref.argsMassaging.urlTemplate, context);
  } else {
    // Default: use whatToRun as URL directly (strip ::http-url:: prefix if present)
    try {
      url = parseRef(ref.whatToRun).value;
    } catch {
      url = ref.whatToRun;
    }
  }

  if (ref.argsMassaging?.bodyTemplate) {
    const evaluated = await evalJsonata(ref.argsMassaging.bodyTemplate, context);
    if (typeof evaluated !== 'object' || evaluated === null) {
      throw new Error(`bodyTemplate must produce an object, got: ${JSON.stringify(evaluated)}`);
    }
    body = evaluated as Record<string, unknown>;
  } else {
    body = buildDefaultTaskExecutorBody(args, ref.extra);
  }

  // Use native fetch (Node 18+)
  const response = await fetch(url, {
    method: ref.howToRun === 'http:get' ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    whatToRun: '::built-in::source-cli-task-executor',
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
    whatToRun: '::built-in::board-live-cards',
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
    whatToRun: `::fs-path::${scriptPath}`,
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
  const isHttp = ref.howToRun === 'http:post' || ref.howToRun === 'http:get';
  if (isHttp) {
    // For HTTP, we can't easily detach — fire async and ignore result
    void _invokeTaskExecutorHttp(ref, args).catch(err => {
      console.error(`[dispatchTaskExecutorDetached] HTTP dispatch failed: ${(err as Error).message}`);
    });
    return;
  }

  const { command, baseArgs } = resolveBaseInvocation(ref, cliDir);
  const callArgv = buildDefaultTaskExecutorArgv(args, ref.extra);
  runDetached({ command, args: [...baseArgs, ...callArgv] });
}
