/**
 * Event Graph — Graph Helpers
 *
 * Pure functions for manipulating the requires/provides task dependency graph.
 * No I/O, no side effects.
 */

import type { GraphConfig, TaskConfig, GraphEngineStore, ExecutionState, RefreshStrategy } from './types.js';
import { TASK_STATUS } from './constants.js';

// ============================================================================
// Accessors — normalize requires/provides to always be arrays
// ============================================================================

export function getProvides(task: TaskConfig | undefined): string[] {
  if (!task) return [];
  if (Array.isArray(task.provides)) return task.provides;
  return [];
}

export function getRequires(task: TaskConfig | undefined): string[] {
  if (!task) return [];
  if (Array.isArray(task.requires)) return task.requires;
  return [];
}

export function getAllTasks(graph: GraphConfig): Record<string, TaskConfig> {
  return graph.tasks ?? {};
}

export function getTask(graph: GraphConfig, taskName: string): TaskConfig | undefined {
  return graph.tasks[taskName];
}

export function hasTask(graph: GraphConfig, taskName: string): boolean {
  return taskName in graph.tasks;
}

// ============================================================================
// Task State Predicates
// ============================================================================

export function isNonActiveTask(taskState: GraphEngineStore | undefined): boolean {
  if (!taskState) return false;
  return taskState.status === TASK_STATUS.FAILED || taskState.status === TASK_STATUS.INACTIVATED;
}

export function isTaskCompleted(taskState: GraphEngineStore | undefined): boolean {
  return taskState?.status === TASK_STATUS.COMPLETED;
}

export function isTaskRunning(taskState: GraphEngineStore | undefined): boolean {
  return taskState?.status === TASK_STATUS.RUNNING;
}

export function getRefreshStrategy(taskConfig: TaskConfig, graphSettings?: { refreshStrategy?: RefreshStrategy }): RefreshStrategy {
  return taskConfig.refreshStrategy ?? graphSettings?.refreshStrategy ?? 'data-changed';
}

export function isRerunnable(taskConfig: TaskConfig, graphSettings?: { refreshStrategy?: RefreshStrategy }): boolean {
  return getRefreshStrategy(taskConfig, graphSettings) !== 'once';
}

export function getMaxExecutions(taskConfig: TaskConfig): number | undefined {
  return taskConfig.maxExecutions;
}

// ============================================================================
// Available Outputs Computation
// ============================================================================

/**
 * Dynamically compute available outputs from all completed tasks.
 * Tasks with strategies other than 'once' may have completed and reset.
 * Pure function.
 */
export function computeAvailableOutputs(
  graph: GraphConfig,
  taskStates: Record<string, GraphEngineStore>
): string[] {
  const outputs: Set<string> = new Set();

  for (const [taskName, taskState] of Object.entries(taskStates)) {
    if (taskState.status === TASK_STATUS.COMPLETED) {
      const taskConfig = graph.tasks[taskName];
      if (taskConfig) {
        const provides = getProvides(taskConfig);
        provides.forEach(output => outputs.add(output));
      }
    }
  }

  return Array.from(outputs);
}

// ============================================================================
// Conflict Detection
// ============================================================================

/**
 * Group candidate tasks by the outputs they provide.
 * Used to detect conflicts (multiple tasks providing the same output).
 */
export function groupTasksByProvides(
  candidateTaskNames: string[],
  tasks: Record<string, TaskConfig>
): Record<string, string[]> {
  const outputGroups: Record<string, string[]> = {};

  candidateTaskNames.forEach(taskName => {
    const task = tasks[taskName];
    if (!task) return;
    const provides = getProvides(task);
    provides.forEach(output => {
      if (!outputGroups[output]) {
        outputGroups[output] = [];
      }
      outputGroups[output].push(taskName);
    });
  });

  return outputGroups;
}

/**
 * Check if a task's outputs conflict with other candidates.
 */
export function hasOutputConflict(
  taskName: string,
  taskProvides: string[],
  candidates: string[],
  tasks: Record<string, TaskConfig>
): boolean {
  for (const otherName of candidates) {
    if (otherName === taskName) continue;
    const otherProvides = getProvides(tasks[otherName]);
    const overlapping = taskProvides.some(output => otherProvides.includes(output));
    if (overlapping) return true;
  }
  return false;
}

// ============================================================================
// Immutable Graph Mutation
// ============================================================================

export function addKeyToProvides(task: TaskConfig, key: string): TaskConfig {
  const current = getProvides(task);
  if (current.includes(key)) return task;
  return { ...task, provides: [...current, key] };
}

export function removeKeyFromProvides(task: TaskConfig, key: string): TaskConfig {
  const current = getProvides(task);
  return { ...task, provides: current.filter(p => p !== key) };
}

export function addKeyToRequires(task: TaskConfig, key: string): TaskConfig {
  const current = getRequires(task);
  if (current.includes(key)) return task;
  return { ...task, requires: [...current, key] };
}

export function removeKeyFromRequires(task: TaskConfig, key: string): TaskConfig {
  const current = getRequires(task);
  return { ...task, requires: current.filter(r => r !== key) };
}

// ============================================================================
// Dynamic Task Management
// ============================================================================

/**
 * Add a new task to a graph config. Returns a new GraphConfig (immutable).
 */
export function addDynamicTask(
  graph: GraphConfig,
  taskName: string,
  taskConfig: TaskConfig
): GraphConfig {
  return {
    ...graph,
    tasks: {
      ...graph.tasks,
      [taskName]: taskConfig,
    },
  };
}

/**
 * Create default task state for a new task.
 */
export function createDefaultGraphEngineStore(): GraphEngineStore {
  return {
    status: 'not-started',
    executionCount: 0,
    retryCount: 0,
    lastEpoch: 0,
    messages: [],
    progress: null,
  };
}

/**
 * Create the initial execution state for a graph.
 */
export function createInitialExecutionState(
  graph: GraphConfig,
  executionId: string
): ExecutionState {
  const tasks: Record<string, GraphEngineStore> = {};
  for (const taskName of Object.keys(graph.tasks)) {
    tasks[taskName] = createDefaultGraphEngineStore();
  }

  return {
    status: 'running',
    tasks,
    availableOutputs: [],
    stuckDetection: { is_stuck: false, stuck_description: null, outputs_unresolvable: [], tasks_blocked: [] },
    lastUpdated: new Date().toISOString(),
    executionId,
    executionConfig: {
      executionMode: graph.settings.execution_mode ?? 'eligibility-mode',
      conflictStrategy: graph.settings.conflict_strategy ?? 'alphabetical',
      completionStrategy: graph.settings.completion,
    },
  };
}
