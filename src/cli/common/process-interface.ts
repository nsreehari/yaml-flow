/**
 * process-interface.ts
 *
 * The interface contract for plugging in a host-side process-dispatch backend.
 *
 * To add a new backend (e.g. Azure Functions, AWS Lambda, in-process test double):
 *   1. Create a new file (e.g. process-azure-runner.ts, process-lambda-runner.ts).
 *   2. Implement the `InvocationAdapter` interface — two methods:
 *        - requestSourceFetch   — dispatch a source-data fetch for a card
 *        - requestProcessAccumulated — schedule the next drain pass
 *   3. Export a factory (e.g. `createAzureInvocationAdapter(...): InvocationAdapter`).
 *   4. Wire the factory at the top-level host entrypoint (for example the
 *      Node board CLI/server setup) as the `invocationAdapter` implementation.
 *
 * This is host adapter infrastructure, not board-core behavior.
 * The Node host implementation lives in the Node FS host adapter and related
 * process utilities.
 */

import type { KindValueRef } from './storage-interface.js';

// ============================================================================
// DispatchResult — structured result returned by every InvocationAdapter method
// ============================================================================

export interface DispatchResult {
  /** Whether the request was successfully dispatched (does not mean completed). */
  dispatched: boolean;
  /** Opaque identifier for the dispatched invocation, if available. */
  invocationId?: string;
  /** Human-readable error message if dispatched is false. */
  error?: string;
}

// ============================================================================
// InvocationAdapter — implement this interface to add a new process backend
//
// Invariant: Results are a structured DispatchResult, not raw shell output or callbacks.
// The adapter owns all host-specific concerns (temp files, process spawning, queue messages).
// All methods are fire-and-forget from the caller's perspective — the Promise resolves once
// the dispatch is enqueued/spawned, not when the work completes.
// ============================================================================

export interface InvocationAdapter {
  /**
   * Dispatch a source-data fetch for a card.
   * `enrichedCard` is passed by value; the adapter owns temp file management if needed.
   */
  requestSourceFetch(
    baseRef: KindValueRef,
    enrichedCard: Record<string, unknown>,
    callbackToken: string,
  ): Promise<DispatchResult>;

  /**
   * Schedule a new drain pass for the board (the `process-accumulated-events` cycle).
    * Node host adapter: may spawn a detached CLI process.
   * Azure: enqueues a function trigger / storage-queue message.
   * In-process test double: calls the handler synchronously or records the call.
   */
  requestProcessAccumulated(baseRef: KindValueRef): Promise<DispatchResult>;
}

// ============================================================================
// ExecOptions — options for synchronous/async command execution
// ============================================================================

export interface ExecOptions {
  shell?: boolean;
  timeout?: number;
  encoding?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Optional stdin payload string written to the child process. */
  input?: string;
}

// ============================================================================
// CommandExecutor — injectable abstraction over child-process execution
//
// Replaces ad-hoc execCommandSync / execCommandAsync / resolveCommandInvocation /
// splitCommandLine dep-function bundles in command handlers.
//
// Node implementation: createNodeCommandExecutor() in process-runner.ts.
// Test double: provide an in-memory stub that records calls / returns canned output.
// ============================================================================

export interface CommandExecutor {
  /** Run a command synchronously and return stdout. */
  executeSync(cmd: string, args: string[], options?: ExecOptions): string;
  /** Run a command asynchronously; callback receives (err, stdout, stderr). */
  executeAsync(
    cmd: string,
    args: string[],
    callback: (err: Error | null, stdout: string, stderr: string) => void,
  ): void;
  /** Resolve a raw cmd+args pair through node/script detection (parseCommandSpec). */
  resolveInvocation(rawCmd: string, rawArgs: string[]): { cmd: string; args: string[] };
  /** Split a shell-style command string into tokens (legacy compat). */
  splitCommand(command: string): string[];
}
