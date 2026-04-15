/**
 * Batch Runner — Types
 *
 * Generic concurrent batch processor.
 * Works with both step-machine and event-graph (or any async processor).
 */

// ============================================================================
// Configuration
// ============================================================================

export interface BatchOptions<TItem, TResult> {
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

// ============================================================================
// Progress / Results
// ============================================================================

export interface BatchProgress {
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

export interface BatchResult<TItem, TResult> {
  /** All item results in original order */
  items: BatchItemResult<TItem, TResult>[];
  /** Summary counts */
  completed: number;
  failed: number;
  total: number;
  /** Total wall-clock time in ms */
  durationMs: number;
}

export interface BatchItemResult<TItem, TResult> {
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
