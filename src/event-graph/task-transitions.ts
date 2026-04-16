/**
 * Event Graph — Task State Transitions
 *
 * Pure functions for applying task lifecycle events to execution state.
 * Each function: f(state, ...) → newState
 */

import type { ExecutionState, TaskState, GraphConfig } from './types.js';
import { getProvides } from './graph-helpers.js';

/**
 * Apply task start to execution state. Pure function.
 */
export function applyTaskStart(state: ExecutionState, taskName: string): ExecutionState {
  const existingTask = state.tasks[taskName] ?? createDefaultTaskState();

  const updatedTask: TaskState = {
    ...existingTask,
    status: 'running',
    startedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    progress: 0,
    error: undefined,
  };

  return {
    ...state,
    tasks: { ...state.tasks, [taskName]: updatedTask },
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Apply task completion to execution state.
 * Handles: default provides, conditional provides (on), refresh strategy, data hash tracking.
 * Pure function.
 */
export function applyTaskCompletion(
  state: ExecutionState,
  graph: GraphConfig,
  taskName: string,
  result?: string,
  dataHash?: string
): ExecutionState {
  const existingTask = state.tasks[taskName] ?? createDefaultTaskState();
  const taskConfig = graph.tasks[taskName];
  if (!taskConfig) {
    throw new Error(`Task "${taskName}" not found in graph`);
  }

  // Determine which outputs to produce
  let outputTokens: string[];
  if (result && taskConfig.on && taskConfig.on[result]) {
    // Conditional routing — use the on[result] provides
    outputTokens = taskConfig.on[result];
  } else {
    // Default provides
    outputTokens = getProvides(taskConfig);
  }

  // Build lastConsumedHashes: snapshot the data hashes of all upstream tasks
  const lastConsumedHashes: Record<string, string> = { ...existingTask.lastConsumedHashes };
  const requires = taskConfig.requires ?? [];
  for (const token of requires) {
    // Find the task that provides this token and grab its hash
    for (const [otherName, otherConfig] of Object.entries(graph.tasks)) {
      if (getProvides(otherConfig).includes(token)) {
        const otherState = state.tasks[otherName];
        if (otherState?.lastDataHash) {
          lastConsumedHashes[token] = otherState.lastDataHash;
        }
        break;
      }
    }
  }

  const updatedTask: TaskState = {
    ...existingTask,
    status: 'completed',
    completedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    executionCount: existingTask.executionCount + 1,
    lastEpoch: existingTask.executionCount + 1,
    lastDataHash: dataHash,
    lastConsumedHashes,
    error: undefined,
  };

  // Merge new outputs with existing available outputs
  const newOutputs = [...new Set([...state.availableOutputs, ...outputTokens])];

  return {
    ...state,
    tasks: { ...state.tasks, [taskName]: updatedTask },
    availableOutputs: newOutputs,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Apply task failure to execution state.
 * Handles: retry logic, on_failure token injection, circuit breaker.
 * Pure function.
 */
export function applyTaskFailure(
  state: ExecutionState,
  graph: GraphConfig,
  taskName: string,
  error: string
): ExecutionState {
  const existingTask = state.tasks[taskName] ?? createDefaultTaskState();
  const taskConfig = graph.tasks[taskName];

  // Check retry
  if (taskConfig?.retry) {
    const retryCount = existingTask.retryCount + 1;
    if (retryCount <= taskConfig.retry.max_attempts) {
      // Retry — set back to not-started with incremented retry count
      const updatedTask: TaskState = {
        ...existingTask,
        status: 'not-started',
        retryCount,
        lastUpdated: new Date().toISOString(),
        error,
      };
      return {
        ...state,
        tasks: { ...state.tasks, [taskName]: updatedTask },
        lastUpdated: new Date().toISOString(),
      };
    }
  }

  // No more retries — mark as failed
  const updatedTask: TaskState = {
    ...existingTask,
    status: 'failed',
    failedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    error,
    executionCount: existingTask.executionCount + 1,
  };

  // Inject failure tokens if configured
  let newOutputs = state.availableOutputs;
  if (taskConfig?.on_failure && taskConfig.on_failure.length > 0) {
    newOutputs = [...new Set([...state.availableOutputs, ...taskConfig.on_failure])];
  }

  // Check circuit breaker
  if (taskConfig?.circuit_breaker && updatedTask.executionCount >= taskConfig.circuit_breaker.max_executions) {
    const breakTokens = taskConfig.circuit_breaker.on_break;
    newOutputs = [...new Set([...newOutputs, ...breakTokens])];
  }

  return {
    ...state,
    tasks: { ...state.tasks, [taskName]: updatedTask },
    availableOutputs: newOutputs,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Apply task progress update. Pure function.
 */
export function applyTaskProgress(
  state: ExecutionState,
  taskName: string,
  message?: string,
  progress?: number
): ExecutionState {
  const existingTask = state.tasks[taskName] ?? createDefaultTaskState();

  const updatedTask: TaskState = {
    ...existingTask,
    progress: typeof progress === 'number' ? progress : existingTask.progress,
    messages: [
      ...(existingTask.messages ?? []),
      ...(message ? [{ message, timestamp: new Date().toISOString(), status: existingTask.status }] : []),
    ],
    lastUpdated: new Date().toISOString(),
  };

  return {
    ...state,
    tasks: { ...state.tasks, [taskName]: updatedTask },
    lastUpdated: new Date().toISOString(),
  };
}

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
