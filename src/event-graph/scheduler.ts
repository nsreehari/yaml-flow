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
  computeAvailableOutputs, groupTasksByProvides,
  getMaxExecutions, getRefreshStrategy,
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
 * Uses refreshStrategy to determine re-execution eligibility.
 * Pure function.
 */
export function getCandidateTasks(graph: GraphConfig, state: ExecutionState): string[] {
  const graphTasks = getAllTasks(graph);
  const computedOutputs = computeAvailableOutputs(graph, state.tasks);
  const availableOutputs = [...new Set([...computedOutputs, ...state.availableOutputs])];
  const candidates: string[] = [];

  for (const [taskName, taskConfig] of Object.entries(graphTasks)) {
    const taskState = state.tasks[taskName];
    const strategy = getRefreshStrategy(taskConfig, graph.settings);
    const rerunnable = strategy !== 'once';

    // Always skip running or inactive (failed/inactivated) tasks
    if (taskState?.status === TASK_STATUS.RUNNING || isNonActiveTask(taskState)) {
      continue;
    }

    // Max executions cap
    const maxExec = getMaxExecutions(taskConfig);
    if (maxExec !== undefined && taskState && taskState.executionCount >= maxExec) {
      continue;
    }

    // Circuit breaker check
    if (taskConfig.circuit_breaker && taskState &&
        taskState.executionCount >= taskConfig.circuit_breaker.max_executions) {
      continue;
    }

    // For once-only tasks: skip if completed
    if (!rerunnable) {
      if (taskState?.status === TASK_STATUS.COMPLETED) {
        continue;
      }
    }

    // For re-runnable tasks that already completed: check strategy
    if (rerunnable && taskState?.status === TASK_STATUS.COMPLETED) {
      const requires = getRequires(taskConfig);

      switch (strategy) {
        case 'data-changed': {
          // Re-run only if an upstream task's dataHash differs from what we last consumed
          if (requires.length > 0) {
            const hasChangedData = requires.some(req => {
              for (const [otherName, otherConfig] of Object.entries(graphTasks)) {
                if (getProvides(otherConfig).includes(req)) {
                  const otherState = state.tasks[otherName];
                  if (!otherState) continue;
                  const consumed = taskState.lastConsumedHashes?.[req];
                  // If upstream has no hash, fall back to epoch check
                  if (otherState.lastDataHash == null) {
                    return otherState.executionCount > taskState.lastEpoch;
                  }
                  return otherState.lastDataHash !== consumed;
                }
              }
              return false;
            });
            if (!hasChangedData) continue;
          } else {
            // No requires — needs external trigger
            continue;
          }
          break;
        }

        case 'epoch-changed': {
          if (requires.length > 0) {
            const hasRefreshedInputs = requires.some(req => {
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
            if (!hasRefreshedInputs) continue;
          } else {
            continue;
          }
          break;
        }

        case 'time-based': {
          const interval = taskConfig.refreshInterval ?? 0;
          if (interval <= 0) continue;
          const completedAt = taskState.completedAt;
          if (!completedAt) continue;
          const elapsedSec = (Date.now() - Date.parse(completedAt)) / 1000;
          if (elapsedSec < interval) continue;
          break;
        }

        case 'manual': {
          // Never auto-eligible once completed — needs resetNode() or inject-tokens
          continue;
        }

        default:
          continue;
      }
    }

    // Check if all requirements are met
    const requires = getRequires(taskConfig);
    if (!requires.every(req => availableOutputs.includes(req))) {
      continue;
    }

    // Redundancy check for once-only tasks: skip if all outputs already available
    if (!rerunnable) {
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
