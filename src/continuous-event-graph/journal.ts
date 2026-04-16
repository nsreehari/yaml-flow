/**
 * Continuous Event Graph — Journal
 *
 * Append-only event log for the reactive layer.
 * Handlers append events here; drain() reads and clears atomically.
 *
 * Two adapters:
 *   - MemoryJournal: in-process array (default)
 *   - FileJournal:   append to a JSONL file, truncate on drain
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

// ============================================================================
// FileJournal — append to JSONL file, drain reads + truncates
// ============================================================================

import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';

export class FileJournal implements Journal {
  private pending = 0;

  constructor(private readonly path: string) {
    // Ensure file exists
    if (!existsSync(path)) {
      writeFileSync(path, '', 'utf-8');
    }
  }

  append(event: GraphEvent): void {
    appendFileSync(this.path, JSON.stringify(event) + '\n', 'utf-8');
    this.pending++;
  }

  drain(): GraphEvent[] {
    const content = readFileSync(this.path, 'utf-8').trim();
    // Truncate immediately
    writeFileSync(this.path, '', 'utf-8');
    this.pending = 0;

    if (!content) return [];

    return content.split('\n').map(line => JSON.parse(line) as GraphEvent);
  }

  get size(): number {
    // Re-count from file for accuracy (pending is a hint)
    try {
      const content = readFileSync(this.path, 'utf-8').trim();
      if (!content) return 0;
      return content.split('\n').length;
    } catch {
      return this.pending;
    }
  }
}
