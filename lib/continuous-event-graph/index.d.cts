import { L as LiveGraph, N as NodeInfo, b as LiveGraphSnapshot, D as DownstreamResult, U as UnreachableNodesResult, c as UnreachableTokensResult, e as UpstreamResult, a as LiveGraphHealth } from '../types-CHSdoAAA.cjs';
export { B as BlockedTask, P as PendingTask, S as ScheduleResult, d as UnresolvedDependency } from '../types-CHSdoAAA.cjs';
import { T as TaskConfig, f as GraphEvent, G as GraphConfig } from '../types-BBhqYGhE.cjs';
export { c as ExecutionState, e as GraphEngineStore, g as GraphSettings } from '../types-BBhqYGhE.cjs';
import { R as ReactiveGraph, e as TaskHandlerInput, T as TaskHandlerFn } from '../live-cards-bridge-BXbVTsna.cjs';
export { L as LiveBoard, a as LiveCard, b as LiveCardsToReactiveOptions, c as LiveCardsToReactiveResult, d as ReactiveGraphOptions, f as TaskHandlerReturn, h as computeDataHash, g as createReactiveGraph, l as liveCardsToReactiveGraph, s as schedule } from '../live-cards-bridge-BXbVTsna.cjs';
import { a as GraphValidationResult } from '../validate-Dbu7ygys.cjs';

/**
 * Continuous Event Graph — Core
 *
 * All functions are pure: f(LiveGraph, input) → LiveGraph
 *
 * - createLiveGraph: bootstrap from a GraphConfig
 * - applyEvent: reduce an event (task-started, task-completed, etc.)
 * - addNode / removeNode: structural graph mutations
 * - addRequires / removeRequires / addProvides / removeProvides: wiring mutations
 */

/**
 * Create a LiveGraph from a GraphConfig.
 * Initialises execution state for all tasks in the config.
 */
declare function createLiveGraph(config: GraphConfig, executionId?: string): LiveGraph;
/**
 * Apply an event to the LiveGraph, producing a new LiveGraph.
 * Events are the shared vocabulary — both execution state transitions
 * (task-started, task-completed, etc.) and structural mutations
 * (task-upsert, task-removal, node-requires-add, etc.).
 *
 * Pure function: f(LiveGraph, GraphEvent) → LiveGraph
 */
declare function applyEvent(live: LiveGraph, event: GraphEvent): LiveGraph;
/**
 * Apply multiple events atomically to a LiveGraph.
 * Events are reduced sequentially, but the caller only sees the final state.
 * Use this for batch processing (e.g. draining a journal of pending events).
 */
declare function applyEvents(live: LiveGraph, events: GraphEvent[]): LiveGraph;
/**
 * Upsert a node (task) in the live graph. Updates both config and state atomically.
 * If the node already exists, replaces its config but preserves its state.
 * If new, creates fresh default state.
 */
declare function addNode(live: LiveGraph, name: string, taskConfig: TaskConfig): LiveGraph;
/**
 * Remove a node (task) from the live graph. Updates both config and state atomically.
 * If the node doesn't exist, returns the graph unchanged.
 * NOTE: Does not clean up references — other nodes' requires/provides are left intact.
 * The caller can use removeRequires() to clean up if needed.
 */
declare function removeNode(live: LiveGraph, name: string): LiveGraph;
/**
 * Add requires tokens to a node. If the node doesn't exist, returns unchanged.
 * Deduplicates — won't add tokens already in requires.
 */
declare function addRequires(live: LiveGraph, nodeName: string, tokens: string[]): LiveGraph;
/**
 * Remove requires tokens from a node. If the node doesn't exist, returns unchanged.
 */
declare function removeRequires(live: LiveGraph, nodeName: string, tokens: string[]): LiveGraph;
/**
 * Add provides tokens to a node. If the node doesn't exist, returns unchanged.
 * Deduplicates — won't add tokens already in provides.
 */
declare function addProvides(live: LiveGraph, nodeName: string, tokens: string[]): LiveGraph;
/**
 * Remove provides tokens from a node. If the node doesn't exist, returns unchanged.
 */
declare function removeProvides(live: LiveGraph, nodeName: string, tokens: string[]): LiveGraph;
/**
 * Inject tokens into the live graph's available outputs.
 * Equivalent to applyEvent(live, { type: 'inject-tokens', tokens, timestamp }).
 */
declare function injectTokens(live: LiveGraph, tokens: string[]): LiveGraph;
/**
 * Drain (remove) tokens from the live graph's available outputs.
 * Inverse of injectTokens — useful for expiring stale data or revoking signals.
 * Tokens that aren't currently available are silently ignored.
 * Pure function.
 */
declare function drainTokens(live: LiveGraph, tokens: string[]): LiveGraph;
/**
 * Reset a node's state back to not-started, clearing error, retry count, progress.
 * Config is untouched. Useful when a failed task should be retried later.
 * If the node doesn't exist, returns unchanged.
 */
declare function resetNode(live: LiveGraph, name: string): LiveGraph;
/**
 * Disable a node — sets its status to 'inactivated'.
 * The scheduler will skip inactivated tasks. Config is untouched.
 * If the node doesn't exist or is already inactivated, returns unchanged.
 */
declare function disableNode(live: LiveGraph, name: string): LiveGraph;
/**
 * Enable a previously-disabled node — sets its status back to 'not-started'.
 * Only acts on 'inactivated' nodes. If the node isn't inactivated, returns unchanged.
 */
declare function enableNode(live: LiveGraph, name: string): LiveGraph;
/**
 * Get the config and state for a single node.
 * Returns undefined if the node doesn't exist.
 */
declare function getNode(live: LiveGraph, name: string): NodeInfo | undefined;
/**
 * Serialize a LiveGraph to a plain JSON-safe object.
 * Can be persisted to disk, database, etc.
 */
declare function snapshot(live: LiveGraph): LiveGraphSnapshot;
/**
 * Restore a LiveGraph from a snapshot. Validates the shape.
 * Throws if the snapshot is invalid.
 */
declare function restore(data: unknown): LiveGraph;

/**
 * Continuous Event Graph — Inspect
 *
 * Pure read-only projection: LiveGraph → LiveGraphHealth
 *
 * Live health report combining config structure + runtime state.
 */

/**
 * Compute a live health report for the graph.
 * Combines structural analysis (cycles, conflicts, open deps) with runtime state (task statuses).
 * Pure function — no side effects.
 */
declare function inspect(live: LiveGraph): LiveGraphHealth;
/**
 * Get all tokens that are required but cannot be produced given the current
 * graph state. This is **transitive**: if token X is unreachable, and node A
 * is the only producer of token Y but A requires X, then Y is also unreachable.
 *
 * Takes into account:
 * - Tokens already in availableOutputs (reachable)
 * - Tokens from completed tasks (reachable)
 * - Failed/disabled producers (non-viable)
 *
 * Pure function.
 */
declare function getUnreachableTokens(live: LiveGraph): UnreachableTokensResult;
/**
 * Get all nodes that can never become eligible given the current graph state.
 * A node is unreachable if any of its required tokens is unreachable.
 *
 * This is the node-level companion to getUnreachableTokens — uses the same
 * transitive analysis.
 *
 * Pure function.
 */
declare function getUnreachableNodes(live: LiveGraph): UnreachableNodesResult;
/**
 * Get all nodes that transitively feed into the given node.
 * "What's upstream of X?" — traces backwards through requires → provides chains.
 *
 * Returns the set of upstream nodes and the tokens connecting them.
 * Does NOT include the target node itself.
 * Pure function.
 */
declare function getUpstream(live: LiveGraph, nodeName: string): UpstreamResult;
/**
 * Get all nodes that transitively depend on the given node.
 * "What breaks if I disable X?" — traces forwards through provides → requires chains.
 *
 * Returns the set of downstream nodes and the tokens connecting them.
 * Does NOT include the target node itself.
 * Pure function.
 */
declare function getDownstream(live: LiveGraph, nodeName: string): DownstreamResult;

/**
 * Continuous Event Graph — Validation Utilities
 *
 * Runtime state-consistency checks for LiveGraph and ReactiveGraph.
 * Unlike event-graph/validate.ts which validates static GraphConfig structure,
 * these validate the *live* runtime state against its config.
 *
 * Pure functions — config+state in, diagnostics out.
 */

/**
 * Validate that a LiveGraph's runtime state is consistent with its config.
 *
 * Checks:
 *   - Every config task has a corresponding state entry (MISSING_STATE)
 *   - No orphan state entries exist for tasks not in config (ORPHAN_STATE)
 *   - Running tasks have a startedAt timestamp (RUNNING_WITHOUT_START)
 *   - Completed tasks have a completedAt timestamp (COMPLETED_WITHOUT_TIMESTAMP)
 *   - Failed tasks have a failedAt timestamp and error (FAILED_WITHOUT_INFO)
 *   - Available outputs match what completed tasks should have produced (PHANTOM_OUTPUT / MISSING_OUTPUT)
 *   - Execution counts are non-negative (INVALID_EXECUTION_COUNT)
 *   - No task has executionCount > maxExecutions when capped (EXCEEDED_MAX_EXECUTIONS)
 */
declare function validateLiveGraph(live: LiveGraph): GraphValidationResult;
/**
 * Input for reactive graph validation.
 * Accepts the reactive graph instance plus the original options (for handler list reference).
 */
interface ReactiveGraphValidationInput {
    /** The reactive graph instance to validate */
    graph: ReactiveGraph;
    /** The handler registry (handler name → handler function) */
    handlers: Record<string, unknown>;
}
/**
 * Validate reactive-graph-specific consistency.
 *
 * Checks:
 *   - Every handler name referenced in taskConfig.taskHandlers exists in the registry (MISSING_HANDLER)
 *   - No handlers registered that are not referenced by any task's taskHandlers (ORPHAN_HANDLER)
 *   - Plus all validateLiveGraph checks on the underlying state
 */
declare function validateReactiveGraph(input: ReactiveGraphValidationInput): GraphValidationResult;

/**
 * Continuous Event Graph — mutateGraph
 *
 * A higher-level batch mutation API.
 *
 * Unlike calling addNode/removeNode/injectTokens individually, mutateGraph
 * accepts a declarative array of mutations and applies them atomically.
 * This is useful for:
 *   - Applying a set of structural changes + events in a single call
 *   - Building mutation pipelines from external configs
 *   - Reducing boilerplate when scripting graph changes
 *
 * Pattern: mutateGraph(live, mutations[]) → LiveGraph
 * Pure function — no side effects.
 */

type GraphMutation = AddNodeMutation | RemoveNodeMutation | AddRequiresMutation | RemoveRequiresMutation | AddProvidesMutation | RemoveProvidesMutation | InjectTokensMutation | DrainTokensMutation | ResetNodeMutation | DisableNodeMutation | EnableNodeMutation | ApplyEventsMutation;
interface AddNodeMutation {
    type: 'add-node';
    name: string;
    config: TaskConfig;
}
interface RemoveNodeMutation {
    type: 'remove-node';
    name: string;
}
interface AddRequiresMutation {
    type: 'add-requires';
    taskName: string;
    tokens: string[];
}
interface RemoveRequiresMutation {
    type: 'remove-requires';
    taskName: string;
    tokens: string[];
}
interface AddProvidesMutation {
    type: 'add-provides';
    taskName: string;
    tokens: string[];
}
interface RemoveProvidesMutation {
    type: 'remove-provides';
    taskName: string;
    tokens: string[];
}
interface InjectTokensMutation {
    type: 'inject-tokens';
    tokens: string[];
}
interface DrainTokensMutation {
    type: 'drain-tokens';
    tokens: string[];
}
interface ResetNodeMutation {
    type: 'reset-node';
    name: string;
}
interface DisableNodeMutation {
    type: 'disable-node';
    name: string;
}
interface EnableNodeMutation {
    type: 'enable-node';
    name: string;
}
interface ApplyEventsMutation {
    type: 'apply-events';
    events: GraphEvent[];
}
/**
 * Apply an ordered array of mutations to a LiveGraph, returning the new state.
 *
 * Mutations are applied in order. Each mutation can depend on the result of
 * the previous one (e.g., add a node, then inject tokens it requires).
 *
 * Pure function — does not modify the input.
 *
 * @param live - The current LiveGraph
 * @param mutations - Ordered array of mutations to apply
 * @returns The new LiveGraph after all mutations
 * @throws Error if a mutation references a non-existent task (for safety)
 */
declare function mutateGraph(live: LiveGraph, mutations: GraphMutation[]): LiveGraph;

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

/** Minimal resolveCallback interface — matches ReactiveGraph.resolveCallback */
interface ResolveCallbackFn {
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
interface CommandSpec {
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
declare function createCallbackHandler(fn: (input: TaskHandlerInput) => Promise<Record<string, unknown>>, getResolve: () => ResolveCallbackFn): TaskHandlerFn;
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
declare function createFireAndForgetHandler(fn: (input: TaskHandlerInput) => Promise<void> | void, getResolve: () => ResolveCallbackFn): TaskHandlerFn;
interface ShellHandlerOptions {
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
declare function createShellHandler(options: ShellHandlerOptions): TaskHandlerFn;
interface ProcessHandlerOptions extends CommandSpec {
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
declare function createProcessHandler(options: ProcessHandlerOptions): TaskHandlerFn;
interface ScriptHandlerOptions {
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
declare function createScriptHandler(options: ScriptHandlerOptions): TaskHandlerFn;
interface WebhookHandlerOptions {
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
declare function createWebhookHandler(options: WebhookHandlerOptions): TaskHandlerFn;
/**
 * Create a handler that always resolves immediately with static data.
 * Useful for testing, placeholders, or passthrough tasks.
 *
 * @param getResolve - Lazy getter for the resolveCallback function
 * @param staticData - Optional static data to resolve with
 */
declare function createNoopHandler(getResolve: () => ResolveCallbackFn, staticData?: Record<string, unknown>): TaskHandlerFn;

/**
 * Continuous Event Graph — Journal
 *
 * Append-only event log for the reactive layer.
 * Handlers append events here; drain() reads and clears atomically.
 *
 * Adapter:
 *   - MemoryJournal: in-process array (default)
 */

interface Journal {
    /** Append an event to the journal. Safe to call from concurrent callbacks. */
    append(event: GraphEvent): void;
    /** Read all pending events and clear the journal atomically. */
    drain(): GraphEvent[];
    /** Number of pending events (for observability). */
    readonly size: number;
}
declare class MemoryJournal implements Journal {
    private buffer;
    append(event: GraphEvent): void;
    drain(): GraphEvent[];
    get size(): number;
}

export { type CommandSpec, DownstreamResult, GraphConfig, GraphEvent, type GraphMutation, type Journal, LiveGraph, LiveGraphHealth, LiveGraphSnapshot, MemoryJournal, NodeInfo, type ProcessHandlerOptions, ReactiveGraph, type ReactiveGraphValidationInput, type ResolveCallbackFn, type ScriptHandlerOptions, type ShellHandlerOptions, TaskConfig, TaskHandlerFn, TaskHandlerInput, UnreachableNodesResult, UnreachableTokensResult, UpstreamResult, type WebhookHandlerOptions, addNode, addProvides, addRequires, applyEvent, applyEvents, createCallbackHandler, createFireAndForgetHandler, createLiveGraph, createNoopHandler, createProcessHandler, createScriptHandler, createShellHandler, createWebhookHandler, disableNode, drainTokens, enableNode, getDownstream, getNode, getUnreachableNodes, getUnreachableTokens, getUpstream, injectTokens, inspect, mutateGraph, removeNode, removeProvides, removeRequires, resetNode, restore, snapshot, validateLiveGraph, validateReactiveGraph };
