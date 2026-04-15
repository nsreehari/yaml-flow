/**
 * Batch Runner — Unit Tests
 */

import { describe, it, expect, vi } from 'vitest';
import { batch } from '../../src/batch/runner.js';
import type { BatchProgress } from '../../src/batch/types.js';

// ============================================================================
// Helpers
// ============================================================================

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// Basic functionality
// ============================================================================

describe('batch', () => {
  it('should process all items and return results in order', async () => {
    const items = [1, 2, 3, 4, 5];
    const result = await batch(items, {
      concurrency: 2,
      processor: async (n) => n * 10,
    });

    expect(result.total).toBe(5);
    expect(result.completed).toBe(5);
    expect(result.failed).toBe(0);
    expect(result.items.map((r) => r.result)).toEqual([10, 20, 30, 40, 50]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should handle empty input', async () => {
    const result = await batch([], {
      processor: async () => 'never',
    });

    expect(result.total).toBe(0);
    expect(result.completed).toBe(0);
    expect(result.items).toEqual([]);
  });

  it('should handle single item', async () => {
    const result = await batch(['hello'], {
      processor: async (s) => s.toUpperCase(),
    });

    expect(result.total).toBe(1);
    expect(result.completed).toBe(1);
    expect(result.items[0].result).toBe('HELLO');
  });

  it('should default concurrency to 5', async () => {
    let maxConcurrent = 0;
    let current = 0;

    const result = await batch(new Array(10).fill(null), {
      processor: async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await sleep(20);
        current--;
        return 'ok';
      },
    });

    expect(result.completed).toBe(10);
    expect(maxConcurrent).toBeLessThanOrEqual(5);
  });
});

// ============================================================================
// Concurrency control
// ============================================================================

describe('concurrency', () => {
  it('should respect concurrency limit', async () => {
    let maxConcurrent = 0;
    let current = 0;

    await batch(new Array(8).fill(null), {
      concurrency: 3,
      processor: async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await sleep(30);
        current--;
        return 'ok';
      },
    });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThanOrEqual(1);
  });

  it('should run all in parallel with concurrency >= items', async () => {
    let maxConcurrent = 0;
    let current = 0;

    await batch(new Array(3).fill(null), {
      concurrency: 10,
      processor: async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await sleep(20);
        current--;
        return 'ok';
      },
    });

    expect(maxConcurrent).toBe(3);
  });
});

// ============================================================================
// Error handling
// ============================================================================

describe('error handling', () => {
  it('should capture failures without stopping other items', async () => {
    const result = await batch([1, 2, 3, 4, 5], {
      concurrency: 2,
      processor: async (n) => {
        if (n === 3) throw new Error('boom');
        return n * 10;
      },
    });

    expect(result.completed).toBe(4);
    expect(result.failed).toBe(1);
    expect(result.items[0].status).toBe('completed');
    expect(result.items[2].status).toBe('failed');
    expect(result.items[2].error?.message).toBe('boom');
    expect(result.items[4].status).toBe('completed');
  });

  it('should handle all items failing', async () => {
    const result = await batch([1, 2, 3], {
      processor: async () => {
        throw new Error('fail');
      },
    });

    expect(result.completed).toBe(0);
    expect(result.failed).toBe(3);
  });

  it('should convert non-Error throws to Error objects', async () => {
    const result = await batch(['x'], {
      processor: async () => {
        throw 'string error';
      },
    });

    expect(result.items[0].error).toBeInstanceOf(Error);
    expect(result.items[0].error?.message).toBe('string error');
  });
});

// ============================================================================
// Callbacks
// ============================================================================

describe('callbacks', () => {
  it('should call onItemComplete for successful items', async () => {
    const completedItems: number[] = [];

    await batch([1, 2, 3], {
      processor: async (n) => n * 2,
      onItemComplete: (_item, _result, index) => {
        completedItems.push(index);
      },
    });

    expect(completedItems.sort()).toEqual([0, 1, 2]);
  });

  it('should call onItemError for failed items', async () => {
    const errorMessages: string[] = [];

    await batch([1, 2], {
      processor: async (n) => {
        if (n === 2) throw new Error('fail-2');
        return n;
      },
      onItemError: (_item, error) => {
        errorMessages.push(error.message);
      },
    });

    expect(errorMessages).toEqual(['fail-2']);
  });

  it('should call onProgress after each item settles', async () => {
    const progressSnapshots: BatchProgress[] = [];

    await batch([1, 2, 3], {
      concurrency: 1,
      processor: async (n) => n,
      onProgress: (p) => {
        progressSnapshots.push({ ...p });
      },
    });

    expect(progressSnapshots).toHaveLength(3);
    expect(progressSnapshots[0].completed).toBe(1);
    expect(progressSnapshots[0].percent).toBe(33);
    expect(progressSnapshots[2].completed).toBe(3);
    expect(progressSnapshots[2].percent).toBe(100);
  });
});

// ============================================================================
// AbortSignal
// ============================================================================

describe('abort', () => {
  it('should not start new items after abort', async () => {
    const controller = new AbortController();
    let started = 0;

    // Abort before starting — all items should be marked failed
    controller.abort();

    const result = await batch(new Array(5).fill(null), {
      concurrency: 2,
      signal: controller.signal,
      processor: async () => {
        started++;
        await sleep(10);
        return 'ok';
      },
    });

    expect(started).toBe(0);
    expect(result.total).toBe(5);
    expect(result.failed).toBe(5);
    expect(result.items.every((i) => i.error?.message === 'Batch aborted')).toBe(true);
  });
});

// ============================================================================
// Integration: batch with step-machine-like processor
// ============================================================================

describe('integration', () => {
  it('should work with a step-machine-like processor', async () => {
    // Simulate: each item is run through a "flow" that returns a result
    const tickets = [
      { id: 'T1', category: 'billing' },
      { id: 'T2', category: 'technical' },
      { id: 'T3', category: 'general' },
    ];

    const result = await batch(tickets, {
      concurrency: 2,
      processor: async (ticket) => {
        // Simulate a StepMachine flow
        await sleep(10);
        return {
          status: 'completed' as const,
          intent: 'resolved',
          data: { resolution: `Handled ${ticket.category} for ${ticket.id}` },
        };
      },
    });

    expect(result.completed).toBe(3);
    expect(result.items[0].result?.data.resolution).toBe('Handled billing for T1');
    expect(result.items[2].result?.data.resolution).toBe('Handled general for T3');
  });

  it('should preserve item metadata (index, duration)', async () => {
    const result = await batch(['a', 'b', 'c'], {
      concurrency: 3,
      processor: async (s) => {
        await sleep(10);
        return s.toUpperCase();
      },
    });

    for (const item of result.items) {
      expect(item.index).toBeGreaterThanOrEqual(0);
      expect(item.durationMs).toBeGreaterThanOrEqual(0);
      expect(item.status).toBe('completed');
    }
  });
});
