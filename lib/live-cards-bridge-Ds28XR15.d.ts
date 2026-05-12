import { L as LiveGraph, S as ScheduleResult, b as LiveGraphSnapshot } from './types-CoW0gQl3.js';
import { f as GraphEvent, T as TaskConfig, e as GraphEngineStore, G as GraphConfig } from './types-BBhqYGhE.js';

/**
 * Continuous Event Graph — Schedule
 *
 * Pure read-only projection: LiveGraph → ScheduleResult
 *
 * Classifies every non-terminal task into one of:
 *   - eligible: all requires satisfied, ready to dispatch
 *   - pending: requires not yet met, but a viable producer exists (normal waiting)
 *   - unresolved: requires not met, NO task in the graph can produce them (caller's problem)
 *   - blocked: requires not met because the producing task FAILED (caller's problem)
 */

/**
 * Compute the scheduling status of every task in the live graph.
 * Pure function — no side effects.
 */
declare function schedule(live: LiveGraph): ScheduleResult;

/**
 * Continuous Event Graph — Reactive Layer
 *
 * Push-based, self-sustaining execution wrapper.
 *
 * Pattern:
 *   1. Register handlers for tasks
 *   2. Push an event (or inject tokens)
 *   3. The graph drives itself: drain journal → applyEvents → schedule → dispatch → repeat
 *
 * No daemon, no polling. Each handler callback appends to the journal,
 * which triggers a drain cycle that may dispatch the next wave.
 *
 * Dispatch failures, retries, and timeouts are managed internally
 * without touching the core engine types.
 */

/**
 * Deterministic hash of a data payload.
 * Recursively-sorted JSON → stable 64-bit hex.
 * Used to auto-compute dataHash when the handler doesn't provide one.
 * Exported so handler authors can pre-compute or test hashes.
 */
declare function computeDataHash(data: Record<string, unknown>): string;
/**
 * Input passed to a task handler function.
 *
 * The reactive layer resolves upstream data from `requires` into `state`,
 * and provides this task's own engine store as `taskState`.
 * Handlers push output data back via `graph.resolveCallback(callbackToken, data)`.
 */
interface TaskHandlerInput {
    /** This task's node ID (task name) */
    nodeId: string;
    /**
     * Upstream dependency data, keyed by require token name.
     * Only tokens from this task's `requires` are present.
     * Value is the producing task's `data` field (or undefined if not yet available).
     */
    state: Readonly<Record<string, Record<string, unknown> | undefined>>;
    /**
     * This task's own GraphEngineStore — includes status, data, executionCount, etc.
     */
    taskState: Readonly<GraphEngineStore>;
    /** This task's config */
    config: Readonly<TaskConfig>;
    /**
     * Opaque callback token encoding this task's identity.
     * Pass this to `graph.resolveCallback(callbackToken, data)` to complete the task.
     * Can be serialized and sent to external systems (webhooks, other scripts,
     * message queues) — any process with this token can push data back.
     */
    callbackToken: string;
    /**
     * Present only on task-progress re-invocations (source delivery / failure).
     * Contains the update payload from the task-progress event.
     * e.g. { bindTo: 'prices', fetchedAt: '...', dest: 'prices.json' }
     *   or { bindTo: 'prices', failure: true, reason: 'timeout' }
     */
    update?: Record<string, unknown>;
}
/**
 * Handler return value — initiation status only.
 * - `'task-initiated'` — async work started successfully; data will arrive via resolveCallback
 * - `'task-initiate-failure'` — failed to start (bad config, connection refused, etc.)
 */
type TaskHandlerReturn = 'task-initiated' | 'task-initiate-failure';
/**
 * A named task handler function.
 * Registered in the handler registry, referenced by name in `taskConfig.taskHandlers`.
 *
 * The handler's job is to **initiate** async work, not await it.
 *
 * Flow:
 *   1. Handler receives `callbackToken` + upstream `state`
 *   2. Handler kicks off background work (internal, external script, webhook, etc.)
 *      — passes `callbackToken` to the background work
 *   3. Handler returns `'task-initiated'` immediately
 *   4. Background work runs independently — when done, it calls
 *      `graph.resolveCallback(callbackToken, data)` for success, or
 *      `graph.resolveCallback(callbackToken, {}, ['error msg'])` for failure
 *   5. resolveCallback completes the task → data-changed cascade fires
 *
 * The callbackToken is opaque — pass it to the background work so it can
 * call back. Works across processes, scripts, webhooks, message queues.
 *
 * @example
 * ```ts
 * const fetchYahoo: TaskHandlerFn = async ({ state, callbackToken }) => {
 *   const symbols = state['portfolio-form']?.holdings?.map(h => h.symbol) ?? [];
 *   // Kick off background work — do NOT await
 *   fetch(`https://api.yahoo.com/prices?s=${symbols.join(',')}`)
 *     .then(res => res.json())
 *     .then(prices => graph.resolveCallback(callbackToken, { prices }))
 *     .catch(err => graph.resolveCallback(callbackToken, {}, [err.message]));
 *   // Return immediately — background work will resolveCallback when done
 *   return 'task-initiated';
 * };
 * ```
 */
type TaskHandlerFn = (input: TaskHandlerInput) => Promise<TaskHandlerReturn>;
interface ReactiveGraphOptions {
    /** Named handler registry — handler name → handler function */
    handlers: Record<string, TaskHandlerFn>;
    /** Called after each drain cycle — for observability */
    onDrain?: (events: GraphEvent[], live: LiveGraph, scheduleResult: ScheduleResult) => void;
}
interface ReactiveGraph {
    /** Push an event into the graph via journal. Triggers drain → schedule → dispatch. */
    push(event: GraphEvent): void;
    /** Push multiple events via journal. Single drain cycle after all are journaled. */
    pushAll(events: GraphEvent[]): void;
    /**
     * Resolve a callback token — complete (or fail) a task after initiation.
     * Journals task-completed or task-failed, then drains.
     * Gracefully ignores invalid tokens or tokens for tasks no longer in the graph.
     */
    resolveCallback(callbackToken: string, data: Record<string, unknown>, errors?: string[]): void;
    /** Add a node to the graph. Journals a task-upsert event, then drains. */
    addNode(name: string, taskConfig: TaskConfig): void;
    /** Remove a node from the graph. Journals a task-removal event, then drains. */
    removeNode(name: string): void;
    /** Add required tokens to an existing node. Journals event, then drains. */
    addRequires(nodeName: string, tokens: string[]): void;
    /** Remove required tokens from an existing node. Journals event, then drains. */
    removeRequires(nodeName: string, tokens: string[]): void;
    /** Add provided tokens to an existing node. Journals event, then drains. */
    addProvides(nodeName: string, tokens: string[]): void;
    /** Remove provided tokens from an existing node. Journals event, then drains. */
    removeProvides(nodeName: string, tokens: string[]): void;
    /** Register a named handler in the registry. */
    registerHandler(name: string, fn: TaskHandlerFn): void;
    /** Unregister a named handler from the registry. */
    unregisterHandler(name: string): void;
    /**
     * Re-trigger a task: journals a task-restart event, then drains.
     * data-changed cascade handles downstream automatically.
     */
    retrigger(taskName: string): void;
    /** Re-trigger multiple tasks via journal. */
    retriggerAll(taskNames: string[]): void;
    /**
     * Serialize current state to a JSON-safe snapshot.
     * Caller is responsible for writing to disk/DB/etc.
     * Restore via: `createReactiveGraph(restore(snapshotData), options)`
     */
    snapshot(): LiveGraphSnapshot;
    /** Read-only snapshot of current LiveGraph state. */
    getState(): LiveGraph;
    /** Current schedule projection. */
    getSchedule(): ScheduleResult;
    /**
     * Await all in-flight handler promises without disposing the graph.
     * Use this when you need to wait for async handlers to finish so you
     * can inspect side-effects (e.g. a TX accumulator) and then push more
     * events into the same graph instance.
     */
    waitForHandlers(): Promise<void>;
    /**
     * Stop accepting events.
     * @param options.wait — if true, await all in-flight handler promises before marking disposed.
     */
    dispose(options?: {
        wait?: boolean;
    }): Promise<void>;
}
declare function createReactiveGraph(configOrLive: GraphConfig | LiveGraph, options: ReactiveGraphOptions, executionId?: string): ReactiveGraph;

/**
 * Live Cards → Reactive Graph
 *
 * Takes an array of live card JSONs (card / source nodes) and produces
 * a fully wired ReactiveGraph where:
 *
 *   - Each card becomes a task in the graph
 *   - card.requires → task.requires (upstream card IDs as tokens)
 *   - Each card produces a token equal to its own ID
 *   - Card-type nodes: handler runs CardCompute.run() on a clone of the card,
 *     returns the computed state as data (auto-hashed by the reactive layer)
 *   - Source-type nodes: handler uses the source definition to fetch data,
 *     or falls back to a user-provided handler / noop
 *
 * The reactive graph auto-computes dataHash on every handler result,
 * so `data-changed` refresh strategy works out of the box.
 *
 * @example
 * ```ts
 * import { liveCardsToReactiveGraph } from 'yaml-flow/continuous-event-graph';
 *
 * const cards = [
 *   { id: 'prices', source_defs: [{ kind: 'api', bindTo: 'raw' }], state: {} },
 *   { id: 'dashboard', requires: ['prices'], state: {}, compute: [{ bindTo: 'total', fn: 'sum', ... }], view: { ... } },
 * ];
 *
 * const rg = liveCardsToReactiveGraph(cards, {
 *   sourceHandlers: {
 *     prices: async () => ({ data: { raw: await fetchPrices() } }),
 *   },
 * });
 *
 * // One push → the whole board computes itself
 * rg.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });
 * ```
 */

/**
 * Minimal live card shape accepted by this utility.
 * Unified card — no type field. Behavior from sections present.
 */
/** A provides binding: maps a token name to a source path in the card's data namespace. */
interface ProvidesBinding {
    bindTo: string;
    ref: string;
}
interface LiveCard {
    id: string;
    requires?: string[];
    provides?: ProvidesBinding[];
    meta?: {
        title?: string;
        tags?: string[];
    };
    card_data?: Record<string, unknown>;
    compute?: {
        bindTo: string;
        fn: string;
        [key: string]: unknown;
    }[];
    source_defs?: {
        cli?: string;
        bindTo: string;
        outputFile: string;
        kind?: 'api' | 'websocket' | 'static' | 'llm';
        [key: string]: unknown;
    }[];
    optionalSources?: {
        cli?: string;
        bindTo: string;
        outputFile: string;
        kind?: 'api' | 'websocket' | 'static' | 'llm';
        [key: string]: unknown;
    }[];
    view?: Record<string, unknown>;
}
/**
 * A Board is a named container of live card nodes.
 * Matches the shape used by LiveCard.Board() in browser/live-cards.js:
 *   LiveCard.Board(engine, el, { nodes, positions?, mode, canvas, ... })
 *
 * The `nodes` array contains the card/source JSON objects.
 * Board-level metadata (id, title, settings) is carried through to the
 * generated GraphConfig.
 */
interface LiveBoard {
    /** Board identifier */
    id?: string;
    /** Human-readable title */
    title?: string;
    /** The card/source nodes on this board */
    nodes: LiveCard[];
    /** Board display mode (informational — not used by the reactive graph) */
    mode?: 'board' | 'canvas';
    /** Canvas positions keyed by node ID (informational — not used) */
    positions?: Record<string, {
        x?: number;
        y?: number;
        w?: number;
        h?: number;
    }>;
    /** Board-level settings forwarded to GraphConfig.settings */
    settings?: Partial<GraphConfig['settings']>;
}
interface LiveCardsToReactiveOptions {
    /** Custom handlers for source nodes (keyed by card ID). */
    sourceHandlers?: Record<string, TaskHandlerFn>;
    /**
     * Default handler factory for source nodes without an explicit handler.
     * Called once per source card during graph construction.
     * If not provided, source nodes without explicit handlers get a noop handler
     * that returns the card's current state.
     */
    defaultSourceHandler?: (card: LiveCard) => TaskHandlerFn;
    /**
     * Custom handlers for card nodes (keyed by card ID).
     * Overrides the default CardCompute.run() behavior.
     */
    cardHandlers?: Record<string, TaskHandlerFn>;
    /**
     * If provided, upstream card state is injected into downstream cards
     * before running compute. The key is the upstream card ID and the value
     * is the upstream card's latest state.
     */
    sharedState?: Map<string, Record<string, unknown>>;
    /** Override reactive graph options (journal, callbacks, etc.) */
    reactiveOptions?: Partial<Omit<ReactiveGraphOptions, 'handlers'>>;
    /** Graph-level settings overrides */
    graphSettings?: Partial<GraphConfig['settings']>;
    /** Execution ID for the reactive graph */
    executionId?: string;
}
interface LiveCardsToReactiveResult {
    /** The fully wired reactive graph — ready to push events into. */
    graph: ReactiveGraph;
    /** The generated GraphConfig (for inspection/serialization). */
    config: GraphConfig;
    /** The handler map (for use with validateReactiveGraph). */
    handlers: Record<string, TaskHandlerFn>;
    /** Card lookup by ID (original references). */
    cards: Map<string, LiveCard>;
    /**
     * Shared state map: cardId → latest computed state.
     * Updated automatically by built-in handlers after each task completes.
     * Custom cardHandlers/sourceHandlers can also read upstream data directly
     * from the engine: graph.getState().state.tasks[cardId].data
     */
    sharedState: Map<string, Record<string, unknown>>;
}
/**
 * Convert live card JSONs or a Board into a fully wired ReactiveGraph.
 *
 * Overloads:
 *   liveCardsToReactiveGraph(cards[], options?)  — from a flat array of cards
 *   liveCardsToReactiveGraph(board, options?)    — from a LiveBoard object
 */
declare function liveCardsToReactiveGraph(input: LiveCard[] | LiveBoard, options?: LiveCardsToReactiveOptions): LiveCardsToReactiveResult;

export { type LiveBoard as L, type ReactiveGraph as R, type TaskHandlerFn as T, type LiveCard as a, type LiveCardsToReactiveOptions as b, type LiveCardsToReactiveResult as c, type ReactiveGraphOptions as d, type TaskHandlerInput as e, type TaskHandlerReturn as f, createReactiveGraph as g, computeDataHash as h, liveCardsToReactiveGraph as l, schedule as s };
