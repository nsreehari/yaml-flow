/**
 * Event Graph — Reducer
 *
 * The core state transition function: f(state, event, graph) → newState
 * No I/O, no side effects, deterministic.
 */

import type {
  GraphConfig,
  ExecutionState,
  GraphEvent,
  TaskConfig,
} from './types.js';
import {
  applyTaskStart,
  applyTaskCompletion,
  applyTaskFailure,
  applyTaskProgress,
} from './task-transitions.js';
import { createDefaultTaskState, createInitialExecutionState } from './graph-helpers.js';

/**
 * Apply an event to the current execution state, producing a new state.
 * Pure function — the heart of the event-graph reducer.
 *
 * @param state - Current execution state
 * @param event - Event to apply
 * @param graph - Graph configuration (needed for task definitions)
 * @returns New execution state
 */
export function apply(
  state: ExecutionState,
  event: GraphEvent,
  graph: GraphConfig
): ExecutionState {
  // Ghost event filtering: skip events from a different execution
  if ('executionId' in event && event.executionId && event.executionId !== state.executionId) {
    return state;
  }

  switch (event.type) {
    case 'task-started':
      return applyTaskStart(state, event.taskName);

    case 'task-completed':
      return applyTaskCompletion(state, graph, event.taskName, event.result, event.dataHash);

    case 'task-failed':
      return applyTaskFailure(state, graph, event.taskName, event.error);

    case 'task-progress':
      return applyTaskProgress(state, event.taskName, event.message, event.progress);

    case 'inject-tokens':
      return applyInjectTokens(state, event.tokens);

    case 'agent-action':
      return applyAgentAction(state, event.action, graph, event.config);

    case 'task-creation':
      return applyTaskCreation(state, event.taskName, event.taskConfig);

    default:
      return state;
  }
}

/**
 * Apply multiple events sequentially. Pure function.
 */
export function applyAll(
  state: ExecutionState,
  events: GraphEvent[],
  graph: GraphConfig
): ExecutionState {
  return events.reduce((s, e) => apply(s, e, graph), state);
}

// ============================================================================
// Internal reducers
// ============================================================================

function applyInjectTokens(state: ExecutionState, tokens: string[]): ExecutionState {
  return {
    ...state,
    availableOutputs: [...new Set([...state.availableOutputs, ...tokens])],
    lastUpdated: new Date().toISOString(),
  };
}

function applyAgentAction(
  state: ExecutionState,
  action: 'start' | 'stop' | 'pause' | 'resume',
  graph: GraphConfig,
  config?: Partial<{ executionMode: string; conflictStrategy: string; completionStrategy: string }>
): ExecutionState {
  const now = new Date().toISOString();

  switch (action) {
    case 'start': {
      const executionId = `exec-${Date.now()}`;
      const fresh = createInitialExecutionState(graph, executionId);
      // Apply any config overrides
      if (config) {
        if (config.executionMode) {
          fresh.executionConfig.executionMode = config.executionMode as ExecutionState['executionConfig']['executionMode'];
        }
        if (config.conflictStrategy) {
          fresh.executionConfig.conflictStrategy = config.conflictStrategy as ExecutionState['executionConfig']['conflictStrategy'];
        }
        if (config.completionStrategy) {
          fresh.executionConfig.completionStrategy = config.completionStrategy as ExecutionState['executionConfig']['completionStrategy'];
        }
      }
      return fresh;
    }

    case 'stop':
      return {
        ...state,
        status: 'stopped',
        executionId: null,
        lastUpdated: now,
      };

    case 'pause':
      return {
        ...state,
        status: 'paused',
        lastUpdated: now,
      };

    case 'resume':
      return {
        ...state,
        status: 'running',
        lastUpdated: now,
      };

    default:
      return state;
  }
}

function applyTaskCreation(
  state: ExecutionState,
  taskName: string,
  taskConfig: TaskConfig
): ExecutionState {
  // Validate
  if (!taskName || !taskConfig || !Array.isArray(taskConfig.provides)) {
    return state;
  }

  return {
    ...state,
    tasks: {
      ...state.tasks,
      [taskName]: createDefaultTaskState(),
    },
    lastUpdated: new Date().toISOString(),
  };
}
