/**
 * Event Graph — Scheduler
 *
 * The core pure function: f(graph, state) → { eligibleTasks, isComplete, isStuck }
 * No I/O, no side effects, deterministic.
 */

import type { GraphConfig, ExecutionState, SchedulerResult, ConflictStrategy } from './types.js';
import { TASK_STATUS } from './constants.js';
import {
  getAllTasks, getRequires, getProvides, isNonActiveTask,
  computeAvailableOutputs, groupTasksByProvides, isRepeatableTask,
  getRepeatableMax,
} from './graph-helpers.js';
import { selectBestAlternative, getNonConflictingTasks, selectRandomTasks } from './conflict-resolution.js';
import { isExecutionComplete } from './completion.js';
import { detectStuckState } from './stuck-detection.js';

/**
 * Determine what tasks should be executed next.
 * Pure function — the heart of the event-graph engine.
 */
export function next(graph: GraphConfig, state: ExecutionState): SchedulerResult {
  const processingLog: string[] = [];
  const graphTasks = getAllTasks(graph);

  if (Object.keys(graphTasks).length === 0) {
    return {
      eligibleTasks: [],
      isComplete: true,
      stuckDetection: { is_stuck: false, stuck_description: null, outputs_unresolvable: [], tasks_blocked: [] },
      hasConflicts: false,
      conflicts: {},
      strategy: state.executionConfig.conflictStrategy,
      processingLog: ['No tasks defined'],
    };
  }

  const mode = state.executionConfig.executionMode;
  const conflictStrategy = state.executionConfig.conflictStrategy;

  // Step 1: Find candidate tasks
  const candidates = getCandidateTasks(graph, state);
  processingLog.push(`Found ${candidates.length} candidate tasks: ${candidates.join(', ') || 'none'}`);

  // Step 2: Apply mode-specific selection
  let eligible: string[];
  let hasConflicts = false;
  let conflicts: Record<string, string[]> = {};

  if (mode === 'dependency-mode') {
    // Execute ALL eligible tasks
    eligible = candidates;
  } else {
    // eligibility-mode: intelligent selection with conflict resolution
    const selection = selectOptimalTasks(candidates, graph, state, conflictStrategy);
    eligible = selection.eligibleTasks;
    hasConflicts = selection.hasConflicts;
    conflicts = selection.conflicts;
  }

  processingLog.push(`Eligible after conflict resolution: ${eligible.join(', ') || 'none'}`);

  // Step 3: Check completion
  const completionResult = isExecutionComplete(graph, state);
  processingLog.push(`Execution complete: ${completionResult.isComplete}`);

  // Step 4: Stuck detection
  const stuckDetection = detectStuckState({
    graph,
    state,
    eligibleTasks: eligible,
    completionResult,
  });

  if (stuckDetection.is_stuck) {
    processingLog.push(`STUCK: ${stuckDetection.stuck_description}`);
  }

  return {
    eligibleTasks: eligible,
    isComplete: completionResult.isComplete,
    stuckDetection,
    hasConflicts,
    conflicts,
    strategy: conflictStrategy,
    processingLog,
  };
}

/**
 * Get candidate tasks whose dependencies are all met.
 * Handles repeatable tasks and circuit breakers.
 * Pure function.
 */
export function getCandidateTasks(graph: GraphConfig, state: ExecutionState): string[] {
  const graphTasks = getAllTasks(graph);
  // Merge computed outputs (from completed tasks) with state's available outputs (includes injected tokens)
  const computedOutputs = computeAvailableOutputs(graph, state.tasks);
  const availableOutputs = [...new Set([...computedOutputs, ...state.availableOutputs])];
  const candidates: string[] = [];

  for (const [taskName, taskConfig] of Object.entries(graphTasks)) {
    const taskState = state.tasks[taskName];

    // For non-repeatable tasks: skip if completed, running, failed, inactivated
    if (!isRepeatableTask(taskConfig)) {
      if (taskState?.status === TASK_STATUS.COMPLETED ||
          taskState?.status === TASK_STATUS.RUNNING ||
          isNonActiveTask(taskState)) {
        continue;
      }
    } else {
      // Repeatable task: skip if running or failed/inactivated
      if (taskState?.status === TASK_STATUS.RUNNING || isNonActiveTask(taskState)) {
        continue;
      }
      // Check max executions for repeatable
      const maxExec = getRepeatableMax(taskConfig);
      if (maxExec !== undefined && taskState && taskState.executionCount >= maxExec) {
        continue;
      }
      // Circuit breaker check
      if (taskConfig.circuit_breaker) {
        if (taskState && taskState.executionCount >= taskConfig.circuit_breaker.max_executions) {
          continue;
        }
      }
      // For repeatable tasks that already completed: check if inputs have been refreshed
      // A repeatable task needs its requires to have been regenerated since its last run
      if (taskState?.status === TASK_STATUS.COMPLETED) {
        // Check if any providing task has a higher epoch than this task's last epoch
        const requires = getRequires(taskConfig);
        if (requires.length > 0) {
          const hasRefreshedInputs = requires.some(req => {
            // Find which task provides this requirement and check its epoch
            for (const [otherName, otherConfig] of Object.entries(graphTasks)) {
              if (getProvides(otherConfig).includes(req)) {
                const otherState = state.tasks[otherName];
                if (otherState && otherState.executionCount > taskState.lastEpoch) {
                  return true;
                }
              }
            }
            return false;
          });
          if (!hasRefreshedInputs) continue; // No new inputs since last execution
        } else {
          // No requires — for repeatable tasks with no deps, they need an external trigger
          // (inject-tokens event). If already completed and nothing new, skip.
          continue;
        }
      }
    }

    // Check if all requirements are met
    const requires = getRequires(taskConfig);
    if (!requires.every(req => availableOutputs.includes(req))) {
      continue;
    }

    // Redundancy check: skip if all outputs already available (non-repeatable only)
    if (!isRepeatableTask(taskConfig)) {
      const provides = getProvides(taskConfig);
      const allAlreadyAvailable = provides.length > 0 &&
        provides.every(output => availableOutputs.includes(output));
      if (allAlreadyAvailable) continue;
    }

    candidates.push(taskName);
  }

  return candidates;
}

/**
 * Select optimal tasks using conflict resolution strategies.
 * Pure function.
 */
function selectOptimalTasks(
  candidates: string[],
  graph: GraphConfig,
  state: ExecutionState,
  conflictStrategy: ConflictStrategy
): { eligibleTasks: string[]; hasConflicts: boolean; conflicts: Record<string, string[]> } {
  const result = { eligibleTasks: [] as string[], hasConflicts: false, conflicts: {} as Record<string, string[]> };

  if (candidates.length === 0) return result;

  const graphTasks = getAllTasks(graph);

  // Global strategies that apply to all candidates at once
  switch (conflictStrategy) {
    case 'parallel-all':
      result.eligibleTasks = candidates;
      return result;

    case 'user-choice': {
      result.eligibleTasks = candidates;
      if (candidates.length > 1) {
        const outputGroups = groupTasksByProvides(candidates, graphTasks);
        for (const [outputKey, groupTasks] of Object.entries(outputGroups)) {
          if (groupTasks.length > 1) {
            result.conflicts[outputKey] = groupTasks;
            result.hasConflicts = true;
          }
        }
      }
      return result;
    }

    case 'skip-conflicts':
      result.eligibleTasks = getNonConflictingTasks(candidates, graphTasks);
      return result;

    case 'random-select':
      result.eligibleTasks = selectRandomTasks(candidates, graphTasks);
      return result;
  }

  // Per-output-group strategies
  const outputGroups = groupTasksByProvides(candidates, graphTasks);

  // Filter out groups that conflict with running tasks
  const runningOutputs = new Set<string>();
  for (const [taskName, taskState] of Object.entries(state.tasks)) {
    if (taskState.status === TASK_STATUS.RUNNING) {
      const taskConfig = graph.tasks[taskName];
      if (taskConfig) {
        getProvides(taskConfig).forEach(o => runningOutputs.add(o));
      }
    }
  }

  const selectedTasks: string[] = [];
  const tasksInConflictGroups = new Set<string>();

  for (const [outputKey, groupTasks] of Object.entries(outputGroups)) {
    // Skip if this output is being produced by a running task
    if (runningOutputs.has(outputKey)) continue;

    if (groupTasks.length === 1) {
      selectedTasks.push(groupTasks[0]);
    } else {
      // Multiple alternatives — apply selection strategy
      const selected = selectBestAlternative(groupTasks, graphTasks, state, conflictStrategy);
      selectedTasks.push(selected);
    }
    groupTasks.forEach(t => tasksInConflictGroups.add(t));
  }

  // Include non-conflicting tasks
  const nonConflicting = candidates.filter(t => !tasksInConflictGroups.has(t));
  nonConflicting.forEach(t => {
    if (!selectedTasks.includes(t)) selectedTasks.push(t);
  });

  result.eligibleTasks = selectedTasks;
  return result;
}
