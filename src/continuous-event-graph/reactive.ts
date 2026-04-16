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

import type { GraphConfig, TaskConfig, GraphEvent, GraphEngineStore } from '../event-graph/types.js';
import type { LiveGraph, ScheduleResult } from './types.js';
import { createLiveGraph, applyEvents, addNode, removeNode } from './core.js';
import { schedule } from './schedule.js';
import { MemoryJournal } from './journal.js';
import type { Journal } from './journal.js';
import { createHash } from 'node:crypto';

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Deterministic hash of a data payload.
 * Recursively-sorted JSON → SHA-256 hex (first 16 chars for compactness).
 * Used to auto-compute dataHash when the handler doesn't provide one.
 * Exported so handler authors can pre-compute or test hashes.
 */
export function computeDataHash(data: Record<string, unknown>): string {
  const json = stableStringify(data);
  return createHash('sha256').update(json).digest('hex').slice(0, 16);
}

/** Recursively produce a JSON string with sorted keys at every level. */
function stableStringify(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/**
 * Encode a callback token for a task.
 * Opaque base64url string — can be sent to external systems.
 */
function encodeCallbackToken(taskName: string): string {
  const payload = JSON.stringify({ t: taskName, n: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) });
  return Buffer.from(payload).toString('base64url');
}

/**
 * Decode a callback token → { taskName } or null if malformed.
 */
function decodeCallbackToken(token: string): { taskName: string } | null {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64url').toString());
    if (typeof payload?.t === 'string') return { taskName: payload.t };
    return null;
  } catch { return null; }
}

// ============================================================================
// Types
// ============================================================================

/**
 * Input passed to a task handler function.
 *
 * The reactive layer resolves upstream data from `requires` into `state`,
 * and provides this task's own engine store as `taskState`.
 * Handlers push output data back via `graph.resolveCallback(callbackToken, data)`.
 */
export interface TaskHandlerInput {
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
}

/**
 * Handler return value — initiation status only.
 * - `'task-initiated'` — async work started successfully; data will arrive via resolveCallback
 * - `'task-initiate-failure'` — failed to start (bad config, connection refused, etc.)
 */
export type TaskHandlerReturn = 'task-initiated' | 'task-initiate-failure';

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
export type TaskHandlerFn = (input: TaskHandlerInput) => Promise<TaskHandlerReturn>;

export interface ReactiveGraphOptions {
  /** Named handler registry — handler name → handler function */
  handlers: Record<string, TaskHandlerFn>;
  /** Journal adapter (default: MemoryJournal) */
  journal?: Journal;
  /** Called after each drain cycle — for observability */
  onDrain?: (events: GraphEvent[], live: LiveGraph, scheduleResult: ScheduleResult) => void;
}

export interface ReactiveGraph {
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
  /** Add a node to the graph config. Journals nothing — structural mutation. */
  addNode(name: string, taskConfig: TaskConfig): void;
  /** Remove a node from the graph config. Structural mutation. */
  removeNode(name: string): void;
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
  /** Read-only snapshot of current LiveGraph state. */
  getState(): LiveGraph;
  /** Current schedule projection. */
  getSchedule(): ScheduleResult;
  /** Stop accepting events. */
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
    journal = new MemoryJournal(),
    onDrain,
  } = options;

  let live = createLiveGraph(config, executionId);
  let disposed = false;

  // Handler registry — mutable, keyed by handler name
  const handlers = new Map<string, TaskHandlerFn>(Object.entries(initialHandlers));

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
    // 1. Read all pending events from journal
    const events = journal.drain();

    // 2. Apply events atomically (if any)
    if (events.length > 0) {
      live = applyEvents(live, events);
    }

    // 3. Schedule — what can run?
    const result = schedule(live);

    // 4. Observability callback (only when there were events)
    if (events.length > 0) {
      onDrain?.(events, live, result);
    }

    // 5. Dispatch eligible tasks
    for (const taskName of result.eligible) {
      dispatchTask(taskName);
    }
  }

  // --------------------------------------------------------------------------
  // Resolve upstream state for a task's requires
  // --------------------------------------------------------------------------

  function resolveUpstreamState(taskName: string): Record<string, Record<string, unknown> | undefined> {
    const taskConfig = live.config.tasks[taskName];
    const requires = taskConfig.requires ?? [];

    const tokenToTask = new Map<string, string>();
    for (const [name, cfg] of Object.entries(live.config.tasks)) {
      for (const token of cfg.provides ?? []) {
        tokenToTask.set(token, name);
      }
    }

    const state: Record<string, Record<string, unknown> | undefined> = {};
    for (const token of requires) {
      const producerTask = tokenToTask.get(token);
      if (producerTask) {
        state[token] = live.state.tasks[producerTask]?.data;
      } else {
        state[token] = undefined;
      }
    }
    return state;
  }

  // --------------------------------------------------------------------------
  // Run the handler pipeline for a task
  // --------------------------------------------------------------------------

  async function runPipeline(taskName: string, callbackToken: string): Promise<void> {
    const taskConfig = live.config.tasks[taskName];
    const handlerNames = taskConfig.taskHandlers ?? [];
    const upstreamState = resolveUpstreamState(taskName);

    for (const handlerName of handlerNames) {
      const handler = handlers.get(handlerName);
      if (!handler) {
        throw new Error(`Handler '${handlerName}' not found in registry (task '${taskName}')`);
      }

      const input: TaskHandlerInput = {
        nodeId: taskName,
        state: upstreamState,
        taskState: live.state.tasks[taskName],
        config: taskConfig,
        callbackToken,
      };

      const status = await handler(input);

      if (status === 'task-initiate-failure') {
        throw new Error(`Handler '${handlerName}' returned task-initiate-failure (task '${taskName}')`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Dispatch a single task
  // --------------------------------------------------------------------------

  function dispatchTask(taskName: string): void {
    const taskConfig = live.config.tasks[taskName];
    const handlerNames = taskConfig?.taskHandlers;

    if (!handlerNames || handlerNames.length === 0) {
      // No taskHandlers — externally driven.
      return;
    }

    // Journal task-started
    journal.append({
      type: 'task-started',
      taskName,
      timestamp: new Date().toISOString(),
    });

    const callbackToken = encodeCallbackToken(taskName);

    // Fire-and-forget: run the handler pipeline
    runPipeline(taskName, callbackToken).catch((error: Error) => {
      if (disposed) return;
      journal.append({
        type: 'task-failed',
        taskName,
        error: error.message ?? String(error),
        timestamp: new Date().toISOString(),
      });
      drain();
    });
  }

  // --------------------------------------------------------------------------
  // Public API — every mutation goes through journal
  // --------------------------------------------------------------------------

  return {
    push(event: GraphEvent): void {
      if (disposed) return;
      if (event.type === 'task-completed' && event.data && !event.dataHash) {
        event = { ...event, dataHash: computeDataHash(event.data) };
      }
      journal.append(event);
      drain();
    },

    pushAll(events: GraphEvent[]): void {
      if (disposed) return;
      for (const event of events) {
        if (event.type === 'task-completed' && event.data && !event.dataHash) {
          journal.append({ ...event, dataHash: computeDataHash(event.data) });
        } else {
          journal.append(event);
        }
      }
      drain();
    },

    resolveCallback(callbackToken: string, data: Record<string, unknown>, errors?: string[]): void {
      if (disposed) return;

      const decoded = decodeCallbackToken(callbackToken);
      if (!decoded) return;

      const { taskName } = decoded;
      if (!live.config.tasks[taskName]) return;

      if (errors && errors.length > 0) {
        journal.append({
          type: 'task-failed',
          taskName,
          error: errors.join('; '),
          timestamp: new Date().toISOString(),
        });
      } else {
        const dataHash = data && Object.keys(data).length > 0 ? computeDataHash(data) : undefined;
        journal.append({
          type: 'task-completed',
          taskName,
          data,
          dataHash,
          timestamp: new Date().toISOString(),
        });
      }
      drain();
    },

    addNode(name: string, taskConfig: TaskConfig): void {
      if (disposed) return;
      live = addNode(live, name, taskConfig);
      drain();
    },

    removeNode(name: string): void {
      if (disposed) return;
      live = removeNode(live, name);
    },

    registerHandler(name: string, fn: TaskHandlerFn): void {
      handlers.set(name, fn);
    },

    unregisterHandler(name: string): void {
      handlers.delete(name);
    },

    retrigger(taskName: string): void {
      if (disposed) return;
      if (!live.config.tasks[taskName]) return;
      journal.append({
        type: 'task-restart',
        taskName,
        timestamp: new Date().toISOString(),
      });
      drain();
    },

    retriggerAll(taskNames: string[]): void {
      if (disposed) return;
      for (const name of taskNames) {
        if (!live.config.tasks[name]) continue;
        journal.append({
          type: 'task-restart',
          taskName: name,
          timestamp: new Date().toISOString(),
        });
      }
      drain();
    },

    getState(): LiveGraph {
      return live;
    },

    getSchedule(): ScheduleResult {
      return schedule(live);
    },

    dispose(): void {
      disposed = true;
    },
  };
}
