/**
 * Continuous Event Graph — Core
 *
 * All functions are pure: f(LiveGraph, input) → LiveGraph
 *
 * - createLiveGraph: bootstrap from a GraphConfig
 * - applyEvent: reduce an event (task-started, task-completed, etc.)
 * - addNode / removeNode: structural graph mutations
 * - addRequires / removeRequires / addProvides / removeProvides: wiring mutations
 */

import type { GraphConfig, TaskConfig, GraphEvent, LiveGraph, NodeInfo, LiveGraphSnapshot } from './types.js';
import type { ExecutionState, TaskState } from '../event-graph/types.js';
import { getProvides, getRequires } from '../event-graph/graph-helpers.js';
import {
  applyTaskStart,
  applyTaskCompletion,
  applyTaskFailure,
  applyTaskProgress,
} from '../event-graph/task-transitions.js';

// ============================================================================
// Create
// ============================================================================

/**
 * Create a LiveGraph from a GraphConfig.
 * Initialises execution state for all tasks in the config.
 */
export function createLiveGraph(config: GraphConfig, executionId?: string): LiveGraph {
  const id = executionId ?? `live-${Date.now()}`;
  const tasks: Record<string, TaskState> = {};

  for (const taskName of Object.keys(config.tasks)) {
    tasks[taskName] = createDefaultTaskState();
  }

  const state: ExecutionState = {
    status: 'running',
    tasks,
    availableOutputs: [],
    stuckDetection: { is_stuck: false, stuck_description: null, outputs_unresolvable: [], tasks_blocked: [] },
    lastUpdated: new Date().toISOString(),
    executionId: id,
    executionConfig: {
      executionMode: config.settings.execution_mode ?? 'eligibility-mode',
      conflictStrategy: config.settings.conflict_strategy ?? 'alphabetical',
      completionStrategy: config.settings.completion,
    },
  };

  return { config, state };
}

// ============================================================================
// Event Reducer
// ============================================================================

/**
 * Apply an execution event to the LiveGraph, producing a new LiveGraph.
 * Events are the shared vocabulary: task-started, task-completed, task-failed,
 * task-progress, inject-tokens, agent-action.
 *
 * Config is NOT mutated by events — only state changes.
 */
export function applyEvent(live: LiveGraph, event: GraphEvent): LiveGraph {
  const { config, state } = live;

  // Ghost event filtering
  if ('executionId' in event && event.executionId && event.executionId !== state.executionId) {
    return live;
  }

  let newState: ExecutionState;

  switch (event.type) {
    case 'task-started':
      newState = applyTaskStart(state, event.taskName);
      break;

    case 'task-completed':
      newState = applyTaskCompletion(state, config, event.taskName, event.result, event.dataHash);
      break;

    case 'task-failed':
      newState = applyTaskFailure(state, config, event.taskName, event.error);
      break;

    case 'task-progress':
      newState = applyTaskProgress(state, event.taskName, event.message, event.progress);
      break;

    case 'inject-tokens':
      newState = {
        ...state,
        availableOutputs: [...new Set([...state.availableOutputs, ...event.tokens])],
        lastUpdated: new Date().toISOString(),
      };
      break;

    case 'agent-action':
      newState = applyAgentAction(state, event.action);
      break;

    default:
      return live;
  }

  return { config, state: newState };
}

/**
 * Apply multiple events atomically to a LiveGraph.
 * Events are reduced sequentially, but the caller only sees the final state.
 * Use this for batch processing (e.g. draining a journal of pending events).
 */
export function applyEvents(live: LiveGraph, events: GraphEvent[]): LiveGraph {
  return events.reduce((current, event) => applyEvent(current, event), live);
}

// ============================================================================
// Graph Mutations — node-level
// ============================================================================

/**
 * Add a node (task) to the live graph. Updates both config and state atomically.
 * If the node already exists, returns the graph unchanged.
 */
export function addNode(live: LiveGraph, name: string, taskConfig: TaskConfig): LiveGraph {
  if (live.config.tasks[name]) return live;

  return {
    config: {
      ...live.config,
      tasks: { ...live.config.tasks, [name]: taskConfig },
    },
    state: {
      ...live.state,
      tasks: { ...live.state.tasks, [name]: createDefaultTaskState() },
      lastUpdated: new Date().toISOString(),
    },
  };
}

/**
 * Remove a node (task) from the live graph. Updates both config and state atomically.
 * If the node doesn't exist, returns the graph unchanged.
 * NOTE: Does not clean up references — other nodes' requires/provides are left intact.
 * The caller can use removeRequires() to clean up if needed.
 */
export function removeNode(live: LiveGraph, name: string): LiveGraph {
  if (!live.config.tasks[name]) return live;

  const { [name]: _removedConfig, ...remainingTasks } = live.config.tasks;
  const { [name]: _removedState, ...remainingStates } = live.state.tasks;

  return {
    config: {
      ...live.config,
      tasks: remainingTasks,
    },
    state: {
      ...live.state,
      tasks: remainingStates,
      lastUpdated: new Date().toISOString(),
    },
  };
}

// ============================================================================
// Graph Mutations — wiring
// ============================================================================

/**
 * Add requires tokens to a node. If the node doesn't exist, returns unchanged.
 * Deduplicates — won't add tokens already in requires.
 */
export function addRequires(live: LiveGraph, nodeName: string, tokens: string[]): LiveGraph {
  const task = live.config.tasks[nodeName];
  if (!task) return live;

  const current = getRequires(task);
  const toAdd = tokens.filter(t => !current.includes(t));
  if (toAdd.length === 0) return live;

  return {
    config: {
      ...live.config,
      tasks: {
        ...live.config.tasks,
        [nodeName]: { ...task, requires: [...current, ...toAdd] },
      },
    },
    state: live.state,
  };
}

/**
 * Remove requires tokens from a node. If the node doesn't exist, returns unchanged.
 */
export function removeRequires(live: LiveGraph, nodeName: string, tokens: string[]): LiveGraph {
  const task = live.config.tasks[nodeName];
  if (!task) return live;

  const current = getRequires(task);
  const remaining = current.filter(t => !tokens.includes(t));
  if (remaining.length === current.length) return live;

  return {
    config: {
      ...live.config,
      tasks: {
        ...live.config.tasks,
        [nodeName]: { ...task, requires: remaining },
      },
    },
    state: live.state,
  };
}

/**
 * Add provides tokens to a node. If the node doesn't exist, returns unchanged.
 * Deduplicates — won't add tokens already in provides.
 */
export function addProvides(live: LiveGraph, nodeName: string, tokens: string[]): LiveGraph {
  const task = live.config.tasks[nodeName];
  if (!task) return live;

  const current = getProvides(task);
  const toAdd = tokens.filter(t => !current.includes(t));
  if (toAdd.length === 0) return live;

  return {
    config: {
      ...live.config,
      tasks: {
        ...live.config.tasks,
        [nodeName]: { ...task, provides: [...current, ...toAdd] },
      },
    },
    state: live.state,
  };
}

/**
 * Remove provides tokens from a node. If the node doesn't exist, returns unchanged.
 */
export function removeProvides(live: LiveGraph, nodeName: string, tokens: string[]): LiveGraph {
  const task = live.config.tasks[nodeName];
  if (!task) return live;

  const current = getProvides(task);
  const remaining = current.filter(t => !tokens.includes(t));
  if (remaining.length === current.length) return live;

  return {
    config: {
      ...live.config,
      tasks: {
        ...live.config.tasks,
        [nodeName]: { ...task, provides: remaining },
      },
    },
    state: live.state,
  };
}

// ============================================================================
// Convenience — inject tokens via mutation (sugar over applyEvent)
// ============================================================================

/**
 * Inject tokens into the live graph's available outputs.
 * Equivalent to applyEvent(live, { type: 'inject-tokens', tokens, timestamp }).
 */
export function injectTokens(live: LiveGraph, tokens: string[]): LiveGraph {
  return applyEvent(live, {
    type: 'inject-tokens',
    tokens,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Drain (remove) tokens from the live graph's available outputs.
 * Inverse of injectTokens — useful for expiring stale data or revoking signals.
 * Tokens that aren't currently available are silently ignored.
 * Pure function.
 */
export function drainTokens(live: LiveGraph, tokens: string[]): LiveGraph {
  const toRemove = new Set(tokens);
  const remaining = live.state.availableOutputs.filter(t => !toRemove.has(t));

  if (remaining.length === live.state.availableOutputs.length) return live;

  return {
    config: live.config,
    state: {
      ...live.state,
      availableOutputs: remaining,
      lastUpdated: new Date().toISOString(),
    },
  };
}

// ============================================================================
// Node lifecycle
// ============================================================================

/**
 * Reset a node's state back to not-started, clearing error, retry count, progress.
 * Config is untouched. Useful when a failed task should be retried later.
 * If the node doesn't exist, returns unchanged.
 */
export function resetNode(live: LiveGraph, name: string): LiveGraph {
  if (!live.config.tasks[name] || !live.state.tasks[name]) return live;

  return {
    config: live.config,
    state: {
      ...live.state,
      tasks: {
        ...live.state.tasks,
        [name]: createDefaultTaskState(),
      },
      lastUpdated: new Date().toISOString(),
    },
  };
}

/**
 * Disable a node — sets its status to 'inactivated'.
 * The scheduler will skip inactivated tasks. Config is untouched.
 * If the node doesn't exist or is already inactivated, returns unchanged.
 */
export function disableNode(live: LiveGraph, name: string): LiveGraph {
  const taskState = live.state.tasks[name];
  if (!taskState || taskState.status === 'inactivated') return live;

  return {
    config: live.config,
    state: {
      ...live.state,
      tasks: {
        ...live.state.tasks,
        [name]: { ...taskState, status: 'inactivated', lastUpdated: new Date().toISOString() },
      },
      lastUpdated: new Date().toISOString(),
    },
  };
}

/**
 * Enable a previously-disabled node — sets its status back to 'not-started'.
 * Only acts on 'inactivated' nodes. If the node isn't inactivated, returns unchanged.
 */
export function enableNode(live: LiveGraph, name: string): LiveGraph {
  const taskState = live.state.tasks[name];
  if (!taskState || taskState.status !== 'inactivated') return live;

  return {
    config: live.config,
    state: {
      ...live.state,
      tasks: {
        ...live.state.tasks,
        [name]: { ...taskState, status: 'not-started', lastUpdated: new Date().toISOString() },
      },
      lastUpdated: new Date().toISOString(),
    },
  };
}

// ============================================================================
// Read: getNode
// ============================================================================

/**
 * Get the config and state for a single node.
 * Returns undefined if the node doesn't exist.
 */
export function getNode(live: LiveGraph, name: string): NodeInfo | undefined {
  const config = live.config.tasks[name];
  if (!config) return undefined;
  const state = live.state.tasks[name] ?? createDefaultTaskState();
  return { name, config, state };
}

// ============================================================================
// Persistence: snapshot / restore
// ============================================================================

/**
 * Serialize a LiveGraph to a plain JSON-safe object.
 * Can be persisted to disk, database, etc.
 */
export function snapshot(live: LiveGraph): LiveGraphSnapshot {
  return {
    version: 1,
    config: live.config,
    state: live.state,
    snapshotAt: new Date().toISOString(),
  };
}

/**
 * Restore a LiveGraph from a snapshot. Validates the shape.
 * Throws if the snapshot is invalid.
 */
export function restore(data: unknown): LiveGraph {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid snapshot: expected an object');
  }

  const snap = data as Record<string, unknown>;

  if (!snap.config || typeof snap.config !== 'object') {
    throw new Error('Invalid snapshot: missing or invalid "config"');
  }
  if (!snap.state || typeof snap.state !== 'object') {
    throw new Error('Invalid snapshot: missing or invalid "state"');
  }

  const config = snap.config as GraphConfig;
  const state = snap.state as ExecutionState;

  if (!config.settings || typeof config.settings !== 'object') {
    throw new Error('Invalid snapshot: config.settings missing');
  }
  if (!config.tasks || typeof config.tasks !== 'object') {
    throw new Error('Invalid snapshot: config.tasks missing');
  }
  if (!state.tasks || typeof state.tasks !== 'object') {
    throw new Error('Invalid snapshot: state.tasks missing');
  }
  if (!Array.isArray(state.availableOutputs)) {
    throw new Error('Invalid snapshot: state.availableOutputs must be an array');
  }

  return { config, state };
}

// ============================================================================
// Internals
// ============================================================================

function createDefaultTaskState(): TaskState {
  return {
    status: 'not-started',
    executionCount: 0,
    retryCount: 0,
    lastEpoch: 0,
    messages: [],
    progress: null,
  };
}

function applyAgentAction(
  state: ExecutionState,
  action: 'start' | 'stop' | 'pause' | 'resume',
): ExecutionState {
  const now = new Date().toISOString();
  switch (action) {
    case 'stop':
      return { ...state, status: 'stopped', lastUpdated: now };
    case 'pause':
      return { ...state, status: 'paused', lastUpdated: now };
    case 'resume':
      return { ...state, status: 'running', lastUpdated: now };
    default:
      return state;
  }
}
