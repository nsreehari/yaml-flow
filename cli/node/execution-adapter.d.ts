import { E as ExecutionRef, a as ExecutionResult } from '../execution-interface-Ba-R-DNg.js';

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

/** Logical args for invokeTaskExecutor — standard task-executor protocol. */
interface TaskExecutorArgs {
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
interface BoardCliCallbackArgs {
    /** Board CLI subcommand to invoke (e.g. 'source-data-fetched', 'source-data-fetch-failure'). */
    command: string;
    /** Additional argv strings passed after the command. */
    argv: string[];
}
/**
 * Options passed when constructing an execution adapter.
 * Provides the platform-specific context needed for built-in resolution.
 */
interface ExecutionAdapterOptions {
    /**
     * Absolute path to the directory containing the compiled CLI files.
     * Required for resolving 'built-in' refs (e.g. source-cli-task-executor.js,
     * board-live-cards-cli.js).
     */
    cliDir: string;
}
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
declare function buildLocalBaseSpec(ref: ExecutionRef, cliDir: string): {
    command: string;
    baseArgs: string[];
};
/** Normalized envelope returned by invokeRefSync. */
interface InvokeRefResult {
    /** Outcome key — drives transitions in the step machine ('success' | 'failure' | custom). */
    result: string;
    /** Response payload as a record (always object-shaped; raw stdout wrapped under `stdout` if not JSON object). */
    data: Record<string, unknown>;
    /** Optional human-readable error detail. */
    error?: string;
}
interface InvokeRefSyncOptions {
    /** Directory used to resolve `built-in` refs (defaults to ref's cwd / process cwd). */
    cliDir?: string;
    /** Working directory for the spawned child (default: process cwd). */
    cwd?: string;
    /** Timeout in milliseconds (default: 30_000). */
    timeoutMs?: number;
    /** Label used in error messages (default: 'invokeRefSync'). */
    label?: string;
}
/**
 * Invoke an ExecutionRef synchronously with a request/reply contract.
 *
 * Used by:
 *   - step-machine ref steps (each step's handler dispatches through here)
 *   - any utility that needs sync request/reply against an ExecutionRef
 *
 * Behavior:
 *   1. Resolve `ref.argsMassaging` against `args` to get cmdArgs / body.
 *   2. Build the local base spec (node/python/process + script path).
 *   3. Spawn synchronously with `JSON.stringify(body ?? args)` on stdin.
 *   4. Map exit code into envelope:
 *        exit 0 → { result: 'success', data: parsed-stdout-or-{stdout: raw} }
 *        non-0  → { result: 'failure', data: { error: stderr-or-exit-detail } }
 *
 * The framework (engine) never inspects payload shape; it only routes on `result`.
 */
declare function invokeRefSync(ref: ExecutionRef, args: Record<string, unknown>, options?: InvokeRefSyncOptions): InvokeRefResult;
interface ExecutionAdapter {
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
declare function createExecutionAdapter(options: ExecutionAdapterOptions): ExecutionAdapter;
/**
 * Create an ExecutionRef for the built-in source-cli task executor.
 * Resolves to node <cliDir>/source-cli-task-executor.js at runtime.
 */
declare function builtInSourceCliExecutorRef(): ExecutionRef;
/**
 * Create an ExecutionRef for the board CLI callback back-channel.
 * Resolves to node <cliDir>/board-live-cards-cli.js at runtime.
 */
declare function builtInBoardCliRef(): ExecutionRef;
/**
 * Create an ExecutionRef for a local Node.js task executor script.
 *
 * @param scriptPath  Absolute path to the executor .js file.
 */
declare function localNodeExecutorRef(scriptPath: string): ExecutionRef;
/**
 * Dispatch a task-executor invocation as a detached background process.
 * Used by the board source-fetch dispatcher — fire-and-forget.
 *
 * For http transports, falls back to synchronous fetch (not truly detached).
 */
declare function dispatchTaskExecutorDetached(ref: ExecutionRef, args: TaskExecutorArgs, cliDir: string): void;

export { type BoardCliCallbackArgs, type ExecutionAdapter, type ExecutionAdapterOptions, type InvokeRefResult, type InvokeRefSyncOptions, type TaskExecutorArgs, buildLocalBaseSpec, builtInBoardCliRef, builtInSourceCliExecutorRef, createExecutionAdapter, dispatchTaskExecutorDetached, invokeRefSync, localNodeExecutorRef };
