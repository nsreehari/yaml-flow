/**
 * Continuous Event Graph — Journal
 *
 * Append-only event log for the reactive layer.
 * Handlers append events here; drain() reads and clears atomically.
 *
 * Adapter:
 *   - MemoryJournal: in-process array (default)
 */

import type { GraphEvent } from '../event-graph/types.js';

// ============================================================================
// Interface
// ============================================================================

export interface Journal {
  /** Append an event to the journal. Safe to call from concurrent callbacks. */
  append(event: GraphEvent): void;
  /** Read all pending events and clear the journal atomically. */
  drain(): GraphEvent[];
  /** Number of pending events (for observability). */
  readonly size: number;
}

// ============================================================================
// MemoryJournal — in-process, zero dependencies
// ============================================================================

export class MemoryJournal implements Journal {
  private buffer: GraphEvent[] = [];

  append(event: GraphEvent): void {
    this.buffer.push(event);
  }

  drain(): GraphEvent[] {
    const events = this.buffer;
    this.buffer = [];
    return events;
  }

  get size(): number {
    return this.buffer.length;
  }
}
