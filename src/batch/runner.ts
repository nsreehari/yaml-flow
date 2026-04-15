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

import type {
  BatchOptions,
  BatchResult,
  BatchItemResult,
  BatchProgress,
} from './types.js';

/**
 * Run an array of items through an async processor with concurrency control.
 *
 * - Items are started in order, up to `concurrency` at a time.
 * - Results are returned in the original item order.
 * - If a processor throws, the item is marked as failed; other items continue.
 * - An AbortSignal prevents new items from starting (in-flight items are not cancelled).
 */
export async function batch<TItem, TResult>(
  items: TItem[],
  options: BatchOptions<TItem, TResult>
): Promise<BatchResult<TItem, TResult>> {
  const {
    concurrency = 5,
    processor,
    onItemComplete,
    onItemError,
    onProgress,
    signal,
  } = options;

  const total = items.length;
  const results: BatchItemResult<TItem, TResult>[] = new Array(total);
  const batchStart = Date.now();

  let completed = 0;
  let failed = 0;
  let nextIndex = 0;

  function makeProgress(active: number): BatchProgress {
    const done = completed + failed;
    return {
      completed,
      failed,
      active,
      pending: total - done - active,
      total,
      percent: total === 0 ? 100 : Math.round((done / total) * 100),
      elapsedMs: Date.now() - batchStart,
    };
  }

  // Empty input — short-circuit
  if (total === 0) {
    return { items: [], completed: 0, failed: 0, total: 0, durationMs: 0 };
  }

  return new Promise<BatchResult<TItem, TResult>>((resolve) => {
    let active = 0;

    function tryStartNext() {
      while (active < concurrency && nextIndex < total) {
        // Respect abort signal — don't start new items
        if (signal?.aborted) {
          // Mark remaining as failed with abort error
          while (nextIndex < total) {
            const idx = nextIndex++;
            results[idx] = {
              item: items[idx],
              index: idx,
              status: 'failed',
              error: new Error('Batch aborted'),
              durationMs: 0,
            };
            failed++;
          }
          // If nothing is in-flight, resolve immediately
          if (active === 0 && completed + failed === total) {
            resolve({
              items: results,
              completed,
              failed,
              total,
              durationMs: Date.now() - batchStart,
            });
          }
          break;
        }

        const idx = nextIndex++;
        const item = items[idx];
        active++;
        const itemStart = Date.now();

        processor(item, idx)
          .then((result) => {
            results[idx] = {
              item,
              index: idx,
              status: 'completed',
              result,
              durationMs: Date.now() - itemStart,
            };
            completed++;
            onItemComplete?.(item, result, idx);
          })
          .catch((err) => {
            const error = err instanceof Error ? err : new Error(String(err));
            results[idx] = {
              item,
              index: idx,
              status: 'failed',
              error,
              durationMs: Date.now() - itemStart,
            };
            failed++;
            onItemError?.(item, error, idx);
          })
          .finally(() => {
            active--;
            onProgress?.(makeProgress(active));

            if (completed + failed === total) {
              resolve({
                items: results,
                completed,
                failed,
                total,
                durationMs: Date.now() - batchStart,
              });
            } else {
              tryStartNext();
            }
          });
      }
    }

    tryStartNext();
  });
}
