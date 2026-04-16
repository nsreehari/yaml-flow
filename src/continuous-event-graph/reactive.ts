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

import type { GraphConfig, TaskConfig, GraphEvent } from '../event-graph/types.js';
import type { LiveGraph, ScheduleResult } from './types.js';
import { createLiveGraph, applyEvent, applyEvents, addNode, removeNode } from './core.js';
import { schedule } from './schedule.js';
import { MemoryJournal } from './journal.js';
import type { Journal } from './journal.js';

// ============================================================================
// Types
// ============================================================================

/** Context passed to task handlers. */
export interface TaskHandlerContext {
  /** Name of the task being executed */
  taskName: string;
  /** Current snapshot of the live graph (read-only — do not mutate) */
  live: Readonly<LiveGraph>;
  /** The task's own config */
  config: TaskConfig;
}

/** A task handler function. Return value becomes the event's `data` payload. */
export type TaskHandler = (ctx: TaskHandlerContext) => Promise<TaskHandlerResult>;

export interface TaskHandlerResult {
  /** Optional result key for conditional routing (task's `on` map) */
  result?: string;
  /** Optional data payload */
  data?: Record<string, unknown>;
  /** Optional content hash for data-changed strategy */
  dataHash?: string;
}

/** Internal dispatch tracking — NOT exposed to the core engine. */
export interface DispatchEntry {
  status: 'initiated' | 'dispatch-failed' | 'timed-out' | 'retry-queued' | 'abandoned';
  dispatchedAt: number;
  dispatchAttempts: number;
  lastError?: string;
}

export interface ReactiveGraphOptions {
  /** Task handlers keyed by task name */
  handlers: Record<string, TaskHandler>;
  /** Max times to retry dispatching a handler that fails to invoke (default: 3) */
  maxDispatchRetries?: number;
  /** Default timeout in ms for handler callbacks (default: 30000). 0 = no timeout. */
  defaultTimeoutMs?: number;
  /** Journal adapter (default: MemoryJournal) */
  journal?: Journal;
  /** Called when a handler fails to dispatch */
  onDispatchFailed?: (taskName: string, error: Error, attempt: number) => void;
  /** Called when a task is abandoned after max dispatch retries */
  onAbandoned?: (taskName: string) => void;
  /** Called after each drain cycle — for observability */
  onDrain?: (events: GraphEvent[], live: LiveGraph, scheduleResult: ScheduleResult) => void;
}

export interface ReactiveGraph {
  /** Push an event into the graph. Triggers drain → schedule → dispatch cascade. */
  push(event: GraphEvent): void;
  /** Push multiple events. Single drain cycle after all are journaled. */
  pushAll(events: GraphEvent[]): void;
  /** Add a node with its handler. Triggers re-evaluation. */
  addNode(name: string, taskConfig: TaskConfig, handler: TaskHandler): void;
  /** Remove a node and its handler. */
  removeNode(name: string): void;
  /** Read-only snapshot of current LiveGraph state. */
  getState(): LiveGraph;
  /** Current schedule projection. */
  getSchedule(): ScheduleResult;
  /** Internal dispatch tracking (for observability/debugging). */
  getDispatchState(): ReadonlyMap<string, DispatchEntry>;
  /** Cancel pending timeouts and stop dispatching. */
  dispose(): void;
}

// ============================================================================
// Factory
// ============================================================================

export function createReactiveGraph(
  config: GraphConfig,
  options: ReactiveGraphOptions,
  executionId?: string,
): ReactiveGraph {
  const {
    handlers: initialHandlers,
    maxDispatchRetries = 3,
    defaultTimeoutMs = 30_000,
    journal = new MemoryJournal(),
    onDispatchFailed,
    onAbandoned,
    onDrain,
  } = options;

  let live = createLiveGraph(config, executionId);
  let disposed = false;

  // Handler registry — mutable so addNode/removeNode can update it
  const handlers = new Map<string, TaskHandler>(Object.entries(initialHandlers));

  // Dispatch tracking — reactive-layer only, never touches core types
  const dispatched = new Map<string, DispatchEntry>();

  // Timeout timers — so we can cancel them on dispose
  const timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Drain lock — prevents re-entrant drain cycles
  let draining = false;
  let drainQueued = false;

  // --------------------------------------------------------------------------
  // Core drain cycle
  // --------------------------------------------------------------------------

  function drain(): void {
    if (disposed) return;
    if (draining) {
      drainQueued = true;
      return;
    }

    draining = true;
    try {
      do {
        drainQueued = false;
        drainOnce();
      } while (drainQueued);
    } finally {
      draining = false;
    }
  }

  function drainOnce(): void {
    // 1. Sweep timeouts
    sweepTimeouts();

    // 2. Read all pending events from journal
    const events = journal.drain();

    // 3. Clear dispatch tracking for tasks that completed or failed
    for (const event of events) {
      if (event.type === 'task-completed' || event.type === 'task-failed') {
        const taskName = (event as { taskName: string }).taskName;
        dispatched.delete(taskName);
        clearTimeout(timeoutTimers.get(taskName));
        timeoutTimers.delete(taskName);
      }
    }

    // 4. Apply all events atomically
    if (events.length > 0) {
      live = applyEvents(live, events);
    }

    // 5. Schedule — what can run?
    const result = schedule(live);

    // 6. Observability callback
    if (onDrain && events.length > 0) {
      onDrain(events, live, result);
    }

    // 7. Dispatch eligible tasks not already initiated
    for (const taskName of result.eligible) {
      if (dispatched.has(taskName)) continue;
      dispatchTask(taskName);
    }

    // 8. Re-dispatch retry-queued tasks
    for (const [taskName, entry] of dispatched) {
      if (entry.status === 'retry-queued') {
        dispatchTask(taskName);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Dispatch a single task
  // --------------------------------------------------------------------------

  function dispatchTask(taskName: string): void {
    const handler = handlers.get(taskName);
    if (!handler) {
      // No handler registered — push task-failed to core
      journal.append({
        type: 'task-failed',
        taskName,
        error: `No handler registered for task "${taskName}"`,
        timestamp: new Date().toISOString(),
      });
      drainQueued = true;
      return;
    }

    const existing = dispatched.get(taskName);
    const attempt = existing ? existing.dispatchAttempts + 1 : 1;

    // Check max retries
    if (attempt > maxDispatchRetries) {
      dispatched.set(taskName, {
        status: 'abandoned',
        dispatchedAt: existing?.dispatchedAt ?? Date.now(),
        dispatchAttempts: attempt - 1,
        lastError: existing?.lastError,
      });
      onAbandoned?.(taskName);
      // Notify core engine so on_failure/circuit_breaker can fire
      journal.append({
        type: 'task-failed',
        taskName,
        error: `dispatch-abandoned: handler unreachable after ${attempt - 1} attempts${existing?.lastError ? ` (${existing.lastError})` : ''}`,
        timestamp: new Date().toISOString(),
      });
      drainQueued = true;
      return;
    }

    // Mark initiated
    dispatched.set(taskName, {
      status: 'initiated',
      dispatchedAt: Date.now(),
      dispatchAttempts: attempt,
    });

    // Push task-started to journal
    journal.append({
      type: 'task-started',
      taskName,
      timestamp: new Date().toISOString(),
    });

    // Set up timeout
    if (defaultTimeoutMs > 0) {
      const timer = setTimeout(() => {
        if (disposed) return;
        const entry = dispatched.get(taskName);
        if (entry?.status === 'initiated') {
          dispatched.set(taskName, {
            ...entry,
            status: 'timed-out',
          });
          // Queue retry or abandon on next drain
          dispatched.set(taskName, {
            ...entry,
            status: entry.dispatchAttempts >= maxDispatchRetries ? 'abandoned' : 'retry-queued',
          });
          if (entry.dispatchAttempts >= maxDispatchRetries) {
            onAbandoned?.(taskName);
            journal.append({
              type: 'task-failed',
              taskName,
              error: `dispatch-timeout: no callback after ${defaultTimeoutMs}ms (${entry.dispatchAttempts} attempts)`,
              timestamp: new Date().toISOString(),
            });
          }
          drain();
        }
      }, defaultTimeoutMs);
      timeoutTimers.set(taskName, timer);
    }

    // Fire-and-forget: invoke handler
    const ctx: TaskHandlerContext = {
      taskName,
      live: live,
      config: live.config.tasks[taskName],
    };

    try {
      const promise = handler(ctx);
      promise.then(
        (handlerResult) => {
          if (disposed) return;
          clearTimeout(timeoutTimers.get(taskName));
          timeoutTimers.delete(taskName);

          journal.append({
            type: 'task-completed',
            taskName,
            result: handlerResult.result,
            data: handlerResult.data,
            dataHash: handlerResult.dataHash,
            timestamp: new Date().toISOString(),
          });
          drain();
        },
        (error: Error) => {
          if (disposed) return;
          clearTimeout(timeoutTimers.get(taskName));
          timeoutTimers.delete(taskName);

          journal.append({
            type: 'task-failed',
            taskName,
            error: error.message ?? String(error),
            timestamp: new Date().toISOString(),
          });
          drain();
        },
      );
    } catch (syncError: unknown) {
      // Handler threw synchronously (not async)
      const err = syncError instanceof Error ? syncError : new Error(String(syncError));
      dispatched.set(taskName, {
        status: 'dispatch-failed',
        dispatchedAt: Date.now(),
        dispatchAttempts: attempt,
        lastError: err.message,
      });
      onDispatchFailed?.(taskName, err, attempt);
      dispatched.set(taskName, {
        ...dispatched.get(taskName)!,
        status: 'retry-queued',
      });
      drainQueued = true;
    }
  }

  // --------------------------------------------------------------------------
  // Timeout sweep
  // --------------------------------------------------------------------------

  function sweepTimeouts(): void {
    // Timeouts are handled via setTimeout callbacks, but we also sweep
    // on each drain cycle for any that might have slipped through.
    const now = Date.now();
    for (const [taskName, entry] of dispatched) {
      if (entry.status !== 'initiated') continue;
      if (defaultTimeoutMs <= 0) continue;
      if (now - entry.dispatchedAt >= defaultTimeoutMs) {
        dispatched.set(taskName, {
          ...entry,
          status: entry.dispatchAttempts >= maxDispatchRetries ? 'abandoned' : 'retry-queued',
        });
        if (entry.dispatchAttempts >= maxDispatchRetries) {
          onAbandoned?.(taskName);
          journal.append({
            type: 'task-failed',
            taskName,
            error: `dispatch-timeout: no callback after ${defaultTimeoutMs}ms (${entry.dispatchAttempts} attempts)`,
            timestamp: new Date().toISOString(),
          });
        }
        clearTimeout(timeoutTimers.get(taskName));
        timeoutTimers.delete(taskName);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  return {
    push(event: GraphEvent): void {
      if (disposed) return;
      // Apply immediately (not via journal — this is an external push)
      live = applyEvent(live, event);
      // Then schedule + dispatch
      drain();
    },

    pushAll(events: GraphEvent[]): void {
      if (disposed) return;
      if (events.length === 0) return;
      live = applyEvents(live, events);
      drain();
    },

    addNode(name: string, taskConfig: TaskConfig, handler: TaskHandler): void {
      if (disposed) return;
      live = addNode(live, name, taskConfig);
      handlers.set(name, handler);
      drain();
    },

    removeNode(name: string): void {
      if (disposed) return;
      live = removeNode(live, name);
      handlers.delete(name);
      dispatched.delete(name);
      clearTimeout(timeoutTimers.get(name));
      timeoutTimers.delete(name);
    },

    getState(): LiveGraph {
      return live;
    },

    getSchedule(): ScheduleResult {
      return schedule(live);
    },

    getDispatchState(): ReadonlyMap<string, DispatchEntry> {
      return dispatched;
    },

    dispose(): void {
      disposed = true;
      for (const timer of timeoutTimers.values()) {
        clearTimeout(timer);
      }
      timeoutTimers.clear();
    },
  };
}
