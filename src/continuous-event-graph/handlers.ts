/**
 * Continuous Event Graph — Handler Factories
 *
 * Ready-made TaskHandlerFn factories for common integration patterns.
 * Each factory returns a TaskHandlerFn compatible with createReactiveGraph.
 *
 * In the callbackToken model, handlers are **initiators** — they kick off
 * background work and return 'task-initiated'. The background work calls
 * graph.resolveCallback(callbackToken, data) when done.
 *
 * Factories that wrap synchronous/async compute accept a `getGraph` getter
 * to obtain the resolveCallback reference (lazy-bound because the graph
 * doesn't exist yet at handler-creation time).
 *
 * Patterns:
 *   createCallbackHandler   — wrap an async function that computes data
 *   createFireAndForgetHandler — side-effect-only (always resolves empty data)
 *   createShellHandler      — run a shell command, resolve with stdout
 *   createScriptHandler     — spawn a Node.js/Python script
 *   createWebhookHandler    — POST to a URL, resolve with response
 *   createNoopHandler       — always resolves immediately (testing/placeholders)
 */

import { exec, execFile } from 'node:child_process';
import type { TaskHandlerFn, TaskHandlerInput, TaskHandlerReturn } from './reactive.js';

/** Minimal resolveCallback interface — matches ReactiveGraph.resolveCallback */
export interface ResolveCallbackFn {
  (callbackToken: string, data: Record<string, unknown>, errors?: string[]): void;
}

/**
 * Structured command specification for process-based handlers.
 *
 * Use this everywhere instead of raw command strings:
 * - command: the executable name or path (no embedded args)
 * - args:    explicit argument array (no shell quoting needed)
 *
 * JSON config format:
 *   Old: { "command": "node path/to/exec.js --flag" }  ← parsed for compat by parseCommandSpec
 *   New: { "command": "node", "args": ["path/to/exec.js", "--flag"] }
 */
export interface CommandSpec {
  /** Executable name or path. No embedded args. */
  command: string;
  /** Explicit argument list. No shell quoting needed. */
  args?: string[];
  /** Working directory. */
  cwd?: string;
  /** Additional environment variables merged over process.env. */
  env?: Record<string, string>;
  /** Timeout in milliseconds. */
  timeoutMs?: number;
}

// ============================================================================
// Callback handler — simplest pattern for plugging async functions
// ============================================================================

/**
 * Wrap a plain async function as a TaskHandlerFn.
 *
 * The function receives TaskHandlerInput and returns data.
 * The factory handles the callbackToken plumbing — it fires
 * the function in the background and calls resolveCallback.
 *
 * @param fn - Async function that computes and returns data
 * @param getResolve - Lazy getter for the resolveCallback function
 *
 * @example
 * ```ts
 * let graph: ReactiveGraph;
 * const handler = createCallbackHandler(
 *   async ({ state }) => {
 *     const prices = await fetchPrices(state['portfolio-form']?.symbols);
 *     return { prices };
 *   },
 *   () => graph.resolveCallback.bind(graph),
 * );
 * graph = createReactiveGraph(config, { handlers: { fetchPrices: handler } });
 * ```
 */
export function createCallbackHandler(
  fn: (input: TaskHandlerInput) => Promise<Record<string, unknown>>,
  getResolve: () => ResolveCallbackFn,
): TaskHandlerFn {
  return async (input: TaskHandlerInput): Promise<TaskHandlerReturn> => {
    const { callbackToken } = input;
    // Fire in background — do NOT await
    Promise.resolve(fn(input))
      .then(data => getResolve()(callbackToken, data))
      .catch(err => getResolve()(callbackToken, {}, [err instanceof Error ? err.message : String(err)]));
    return 'task-initiated';
  };
}

/**
 * Fire-and-forget variant — the async function is invoked but
 * the handler always resolves the task with empty data.
 * Useful for side-effect-only tasks (logging, notifications).
 *
 * @param fn - Side-effect function (logging, alerting, etc.)
 * @param getResolve - Lazy getter for the resolveCallback function
 *
 * @example
 * ```ts
 * const handler = createFireAndForgetHandler(
 *   async ({ nodeId }) => { await sendSlack(`${nodeId} started`); },
 *   () => graph.resolveCallback.bind(graph),
 * );
 * ```
 */
export function createFireAndForgetHandler(
  fn: (input: TaskHandlerInput) => Promise<void> | void,
  getResolve: () => ResolveCallbackFn,
): TaskHandlerFn {
  return async (input: TaskHandlerInput): Promise<TaskHandlerReturn> => {
    const { callbackToken } = input;
    // Fire side-effect in background, always resolve with empty data
    Promise.resolve(fn(input))
      .then(() => getResolve()(callbackToken, {}))
      .catch(() => getResolve()(callbackToken, {})); // swallow errors — fire and forget
    return 'task-initiated';
  };
}

// ============================================================================
// Shell handler — run a shell command
// ============================================================================

export interface ShellHandlerOptions {
  /** Shell command to run. Supports ${taskName} placeholder. */
  command: string;
  /** Working directory (default: process.cwd()) */
  cwd?: string;
  /** Additional environment variables */
  env?: Record<string, string>;
  /** Timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** Map exit codes to result keys (default: 0 → 'success', non-zero → 'failure') */
  exitCodeMap?: Record<number, string>;
  /** If true, include stdout/stderr in data payload */
  captureOutput?: boolean;
  /** Lazy getter for the resolveCallback function */
  getResolve: () => ResolveCallbackFn;
}

/**
 * Create a TaskHandlerFn that runs a shell command.
 *
 * By default, exit code 0 = resolves with stdout data, non-zero = resolves with error.
 * Use exitCodeMap to map specific codes to result keys for conditional routing.
 *
 * @example
 * ```ts
 * const handler = createShellHandler({
 *   command: 'python scripts/process.py --task ${taskName}',
 *   cwd: '/app',
 *   captureOutput: true,
 *   getResolve: () => graph.resolveCallback.bind(graph),
 * });
 * ```
 */
export function createShellHandler(options: ShellHandlerOptions): TaskHandlerFn {
  const {
    command: commandTemplate,
    cwd,
    env,
    timeoutMs = 30_000,
    exitCodeMap,
    captureOutput = false,
    getResolve,
  } = options;

  return async (input: TaskHandlerInput): Promise<TaskHandlerReturn> => {
    const { callbackToken, nodeId } = input;
    const command = commandTemplate.replace(/\$\{taskName\}/g, nodeId);

    // Fire in background
    exec(
      command,
      {
        cwd,
        env: env ? { ...process.env, ...env } : undefined,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024, // 10MB
      },
      (error, stdout, stderr) => {
        const exitCode = error?.code as number | undefined ?? (error ? 1 : 0);

        if (exitCode !== 0 && !exitCodeMap?.[exitCode]) {
          getResolve()(callbackToken, {}, [`Command exited with code ${exitCode}: ${stderr || error?.message}`]);
          return;
        }

        const data: Record<string, unknown> = {};
        if (captureOutput) {
          data.stdout = stdout;
          data.stderr = stderr;
          data.exitCode = exitCode;
        }

        getResolve()(callbackToken, data);
      },
    );

    return 'task-initiated';
  };
}

// ============================================================================
// Process handler — structured command execution (no shell)
// ============================================================================

export interface ProcessHandlerOptions extends CommandSpec {
  /** Map exit codes to result keys (default: 0 → success, non-zero → error) */
  exitCodeMap?: Record<number, string>;
  /** If true, include stdout/stderr/exitCode in the data payload */
  captureOutput?: boolean;
  /** Lazy getter for the resolveCallback function */
  getResolve: () => ResolveCallbackFn;
}

/**
 * Create a TaskHandlerFn that spawns a process using structured command + args.
 *
 * Unlike createShellHandler, this uses execFile — no ambient shell, no quoting
 * issues, safe on Windows and Linux. ${taskName} is substituted in both the
 * command and each arg string.
 *
 * Prefer this over createShellHandler for all programmatic invocations
 * (task-executors, source fetchers, inference adapters).
 *
 * @example
 * ```ts
 * const handler = createProcessHandler({
 *   command: 'node',
 *   args: ['scripts/fetch.js', '--task', '${taskName}'],
 *   cwd: '/app',
 *   captureOutput: true,
 *   getResolve: () => graph.resolveCallback.bind(graph),
 * });
 * ```
 */
export function createProcessHandler(options: ProcessHandlerOptions): TaskHandlerFn {
  const {
    command: commandTemplate,
    args: argsTemplate = [],
    cwd,
    env,
    timeoutMs = 30_000,
    exitCodeMap,
    captureOutput = false,
    getResolve,
  } = options;

  return async (input: TaskHandlerInput): Promise<TaskHandlerReturn> => {
    const { callbackToken, nodeId } = input;
    const command = commandTemplate.replace(/\$\{taskName\}/g, nodeId);
    const args = argsTemplate.map(a => a.replace(/\$\{taskName\}/g, nodeId));

    execFile(
      command,
      args,
      {
        cwd,
        env: env ? { ...process.env, ...env } : undefined,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode = error?.code as number | undefined ?? (error ? 1 : 0);

        if (exitCode !== 0 && !exitCodeMap?.[exitCode]) {
          getResolve()(callbackToken, {}, [`Process exited with code ${exitCode}: ${stderr || error?.message}`]);
          return;
        }

        const data: Record<string, unknown> = {};
        if (captureOutput) {
          data.stdout = stdout;
          data.stderr = stderr;
          data.exitCode = exitCode;
        }

        getResolve()(callbackToken, data);
      },
    );

    return 'task-initiated';
  };
}

// ============================================================================
// Script handler — spawn a script file
// ============================================================================

export interface ScriptHandlerOptions {
  /** Path to the script file */
  scriptPath: string;
  /** Runtime to use (default: auto-detected from extension) */
  runtime?: 'node' | 'python' | 'python3' | 'bash' | 'sh';
  /** Additional CLI arguments */
  args?: string[];
  /** Working directory */
  cwd?: string;
  /** Timeout in ms (default: 60000) */
  timeoutMs?: number;
  /** If true, include stdout/stderr in data payload */
  captureOutput?: boolean;
  /** Lazy getter for the resolveCallback function */
  getResolve: () => ResolveCallbackFn;
}

function detectRuntime(scriptPath: string): string {
  if (scriptPath.endsWith('.js') || scriptPath.endsWith('.mjs') || scriptPath.endsWith('.ts')) return 'node';
  if (scriptPath.endsWith('.py')) return 'python3';
  if (scriptPath.endsWith('.sh')) return 'bash';
  return 'bash';
}

/**
 * Create a TaskHandlerFn that spawns a script file.
 *
 * Auto-detects the runtime from the file extension unless overridden.
 * The task name is passed as the first argument to the script,
 * followed by any additional args.
 *
 * @example
 * ```ts
 * const handler = createScriptHandler({
 *   scriptPath: './scripts/etl.py',
 *   args: ['--verbose'],
 *   captureOutput: true,
 *   getResolve: () => graph.resolveCallback.bind(graph),
 * });
 * ```
 */
export function createScriptHandler(options: ScriptHandlerOptions): TaskHandlerFn {
  const {
    scriptPath,
    runtime,
    args = [],
    cwd,
    timeoutMs = 60_000,
    captureOutput = false,
    getResolve,
  } = options;

  const resolvedRuntime = runtime ?? detectRuntime(scriptPath);
  const command = resolvedRuntime === 'node' ? process.execPath : resolvedRuntime;

  return createProcessHandler({
    command,
    args: [scriptPath, '${taskName}', ...args],
    cwd,
    timeoutMs,
    captureOutput,
    getResolve,
  });
}

// ============================================================================
// Webhook handler — POST to a URL
// ============================================================================

export interface WebhookHandlerOptions {
  /** URL to POST to. Supports ${taskName} placeholder. */
  url: string;
  /** HTTP method (default: POST) */
  method?: 'POST' | 'PUT' | 'PATCH';
  /** Additional headers */
  headers?: Record<string, string>;
  /** Timeout in ms (default: 30000) */
  timeoutMs?: number;
  /** If true, treat non-2xx status as failure */
  failOnNon2xx?: boolean;
  /** Lazy getter for the resolveCallback function */
  getResolve: () => ResolveCallbackFn;
}

/**
 * Create a TaskHandlerFn that sends an HTTP request.
 *
 * Uses native fetch (Node 18+). The task context (nodeId, config)
 * is sent as the JSON body along with the callbackToken.
 *
 * @example
 * ```ts
 * const handler = createWebhookHandler({
 *   url: 'https://api.example.com/tasks/${taskName}/trigger',
 *   headers: { 'Authorization': 'Bearer ...' },
 *   getResolve: () => graph.resolveCallback.bind(graph),
 * });
 * ```
 */
export function createWebhookHandler(options: WebhookHandlerOptions): TaskHandlerFn {
  const {
    url: urlTemplate,
    method = 'POST',
    headers = {},
    timeoutMs = 30_000,
    failOnNon2xx = true,
    getResolve,
  } = options;

  return async (input: TaskHandlerInput): Promise<TaskHandlerReturn> => {
    const { callbackToken, nodeId, config } = input;
    const url = urlTemplate.replace(/\$\{taskName\}/g, nodeId);
    const body = JSON.stringify({
      taskName: nodeId,
      callbackToken,
      config,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    // Fire in background
    fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
      signal: controller.signal,
    })
      .then(async (response) => {
        clearTimeout(timer);
        if (failOnNon2xx && !response.ok) {
          const text = await response.text().catch(() => '');
          getResolve()(callbackToken, {}, [`HTTP ${response.status}: ${text}`]);
          return;
        }
        const data = await response.json().catch(() => ({})) as Record<string, unknown>;
        getResolve()(callbackToken, data);
      })
      .catch((err) => {
        clearTimeout(timer);
        getResolve()(callbackToken, {}, [err instanceof Error ? err.message : String(err)]);
      });

    return 'task-initiated';
  };
}

// ============================================================================
// Noop handler — always resolves immediately
// ============================================================================

/**
 * Create a handler that always resolves immediately with static data.
 * Useful for testing, placeholders, or passthrough tasks.
 *
 * @param getResolve - Lazy getter for the resolveCallback function
 * @param staticData - Optional static data to resolve with
 */
export function createNoopHandler(
  getResolve: () => ResolveCallbackFn,
  staticData?: Record<string, unknown>,
): TaskHandlerFn {
  return async (input: TaskHandlerInput): Promise<TaskHandlerReturn> => {
    getResolve()(input.callbackToken, staticData ?? {});
    return 'task-initiated';
  };
}
