/**
 * Batch Runner — Types
 *
 * Generic concurrent batch processor.
 * Works with both step-machine and event-graph (or any async processor).
 */
interface BatchOptions<TItem, TResult> {
    /**
     * Max concurrent items in flight (slots).
     * @default 5
     */
    concurrency?: number;
    /**
     * The async function that processes a single item.
     * Receives the item and its 0-based index.
     */
    processor: (item: TItem, index: number) => Promise<TResult>;
    /**
     * Called when a single item completes successfully.
     */
    onItemComplete?: (item: TItem, result: TResult, index: number) => void;
    /**
     * Called when a single item fails (processor threw).
     * If not provided, the error is captured in BatchItemResult.
     */
    onItemError?: (item: TItem, error: Error, index: number) => void;
    /**
     * Called after every item settles (success or failure).
     * Receives a snapshot of progress.
     */
    onProgress?: (progress: BatchProgress) => void;
    /**
     * AbortSignal — if aborted, no new items are started.
     * Items already in-flight are NOT cancelled (your processor should check its own signal).
     */
    signal?: AbortSignal;
}
interface BatchProgress {
    /** Items completed successfully so far */
    completed: number;
    /** Items that threw an error */
    failed: number;
    /** Items currently in-flight */
    active: number;
    /** Items not yet started */
    pending: number;
    /** Total items */
    total: number;
    /** Percentage complete (0–100) */
    percent: number;
    /** Elapsed time in ms since batch started */
    elapsedMs: number;
}
interface BatchResult<TItem, TResult> {
    /** All item results in original order */
    items: BatchItemResult<TItem, TResult>[];
    /** Summary counts */
    completed: number;
    failed: number;
    total: number;
    /** Total wall-clock time in ms */
    durationMs: number;
}
interface BatchItemResult<TItem, TResult> {
    /** Original item */
    item: TItem;
    /** 0-based index in the input array */
    index: number;
    /** 'completed' or 'failed' */
    status: 'completed' | 'failed';
    /** Result if completed */
    result?: TResult;
    /** Error if failed */
    error?: Error;
    /** Per-item wall-clock time in ms */
    durationMs: number;
}

/**
 * Batch Runner — Core
 *
 * Slot-based concurrent processor. Pure control flow — no I/O opinions.
 *
 * @example Step Machine batch
 * ```ts
 * import { batch } from 'yaml-flow/batch';
 * import { createStepMachine, loadStepFlow } from 'yaml-flow/step-machine';
 *
 * const flow = await loadStepFlow('./support-ticket.yaml');
 * const results = await batch(tickets, {
 *   concurrency: 5,
 *   processor: async (ticket) => {
 *     const machine = createStepMachine(flow, handlers);
 *     return machine.run(ticket);
 *   },
 * });
 * ```
 *
 * @example Event Graph batch
 * ```ts
 * import { batch } from 'yaml-flow/batch';
 * import { next, apply, createInitialExecutionState } from 'yaml-flow/event-graph';
 *
 * const results = await batch(items, {
 *   concurrency: 3,
 *   processor: async (item, index) => {
 *     let state = createInitialExecutionState(graph, `exec-${index}`);
 *     state = apply(state, { type: 'inject-tokens', tokens: [item.token], timestamp: new Date().toISOString() }, graph);
 *     // ... drive the graph loop
 *     return state;
 *   },
 * });
 * ```
 */

/**
 * Run an array of items through an async processor with concurrency control.
 *
 * - Items are started in order, up to `concurrency` at a time.
 * - Results are returned in the original item order.
 * - If a processor throws, the item is marked as failed; other items continue.
 * - An AbortSignal prevents new items from starting (in-flight items are not cancelled).
 */
declare function batch<TItem, TResult>(items: TItem[], options: BatchOptions<TItem, TResult>): Promise<BatchResult<TItem, TResult>>;

export { type BatchItemResult, type BatchOptions, type BatchProgress, type BatchResult, batch };
