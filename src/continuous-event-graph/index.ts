/**
 * Continuous Event Graph — Public API
 *
 * A long-lived, evolving event-graph where both config and state
 * mutate over time via the single LiveGraph type.
 *
 * Core pattern: f(LiveGraph, input) → LiveGraph
 *
 * Events (shared with event-graph):
 *   applyEvent(live, event) → LiveGraph
 *
 * Graph mutations (node vocabulary):
 *   addNode / removeNode / addRequires / removeRequires / addProvides / removeProvides
 *
 * Read-only projections:
 *   schedule(live) → ScheduleResult
 *   inspect(live)  → LiveGraphHealth
 */

// Core: create + reduce + mutate
export {
  createLiveGraph,
  applyEvent,
  applyEvents,
  addNode,
  removeNode,
  addRequires,
  removeRequires,
  addProvides,
  removeProvides,
  injectTokens,
  drainTokens,
  resetNode,
  disableNode,
  enableNode,
  getNode,
  snapshot,
  restore,
} from './core.js';

// Schedule: what can run, what's blocked
export { schedule } from './schedule.js';

// Inspect: live health report + reachability
export { inspect, getUnreachableTokens, getUnreachableNodes, getUpstream, getDownstream } from './inspect.js';

// Reactive: push-based self-sustaining execution
export { createReactiveGraph } from './reactive.js';
export type {
  ReactiveGraph, ReactiveGraphOptions,
  TaskHandler, TaskHandlerContext, TaskHandlerResult,
  DispatchEntry,
} from './reactive.js';

// Journal: append-only event log
export { MemoryJournal, FileJournal } from './journal.js';
export type { Journal } from './journal.js';

// Types
export type {
  LiveGraph,
  ScheduleResult,
  PendingTask,
  UnresolvedDependency,
  BlockedTask,
  LiveGraphHealth,
  NodeInfo,
  LiveGraphSnapshot,
  UnreachableTokensResult,
  UnreachableNodesResult,
  UpstreamResult,
  DownstreamResult,
} from './types.js';

// Re-export shared types for convenience
export type {
  GraphConfig,
  GraphSettings,
  TaskConfig,
  ExecutionState,
  TaskState,
  GraphEvent,
} from './types.js';
