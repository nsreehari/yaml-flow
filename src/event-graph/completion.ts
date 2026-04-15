/**
 * Event Graph — Completion Detection
 *
 * Pure functions to determine if a graph execution is complete.
 */

import type { GraphConfig, ExecutionState } from './types.js';
import { TASK_STATUS } from './constants.js';
import { getProvides, getAllTasks, getRequires, isNonActiveTask, computeAvailableOutputs } from './graph-helpers.js';

export interface CompletionResult {
  isComplete: boolean;
  expectedCompletion: {
    taskNames: string[];
    outputs: string[];
  };
}

/**
 * Check if graph execution is complete based on the configured strategy.
 * Pure function.
 */
export function isExecutionComplete(
  graph: GraphConfig,
  state: ExecutionState
): CompletionResult {
  const strategy = state.executionConfig.completionStrategy;

  switch (strategy) {
    case 'all-tasks-done':
      return checkAllTasksDone(graph, state);
    case 'all-outputs-done':
      return checkAllOutputsDone(graph, state);
    case 'only-resolved':
      return checkOnlyResolved(graph, state);
    case 'goal-reached':
      return checkGoalReached(graph, state);
    case 'manual':
      return { isComplete: false, expectedCompletion: { taskNames: [], outputs: [] } };
    default:
      return checkAllOutputsDone(graph, state);
  }
}

function checkAllTasksDone(graph: GraphConfig, state: ExecutionState): CompletionResult {
  const graphTasks = getAllTasks(graph);
  const allTaskNames = Object.keys(graphTasks);

  if (allTaskNames.length === 0) {
    return { isComplete: true, expectedCompletion: { taskNames: [], outputs: [] } };
  }

  const allDone = allTaskNames.every(taskName => {
    const taskState = state.tasks[taskName];
    return taskState?.status === TASK_STATUS.COMPLETED || isNonActiveTask(taskState);
  });

  return {
    isComplete: allDone,
    expectedCompletion: { taskNames: allTaskNames, outputs: [] },
  };
}

function checkAllOutputsDone(graph: GraphConfig, state: ExecutionState): CompletionResult {
  const graphTasks = getAllTasks(graph);
  const allPossibleOutputs = new Set<string>();

  for (const taskConfig of Object.values(graphTasks)) {
    getProvides(taskConfig).forEach(output => allPossibleOutputs.add(output));
  }

  const availableOutputs = computeAvailableOutputs(graph, state.tasks);
  const allProduced = [...allPossibleOutputs].every(output => availableOutputs.includes(output));

  return {
    isComplete: allProduced,
    expectedCompletion: { taskNames: [], outputs: [...allPossibleOutputs] },
  };
}

function checkOnlyResolved(graph: GraphConfig, state: ExecutionState): CompletionResult {
  const graphTasks = getAllTasks(graph);
  const availableOutputs = computeAvailableOutputs(graph, state.tasks);

  // Collect all possible outputs and their producers
  const allPossibleOutputs = new Set<string>();
  const tasksByOutput: Record<string, string[]> = {};

  for (const [taskName, taskConfig] of Object.entries(graphTasks)) {
    const provides = getProvides(taskConfig);
    provides.forEach(output => {
      allPossibleOutputs.add(output);
      if (!tasksByOutput[output]) tasksByOutput[output] = [];
      tasksByOutput[output].push(taskName);
    });
  }

  // Check if all outputs are either available or unproduceable
  for (const output of allPossibleOutputs) {
    if (availableOutputs.includes(output)) continue;

    const producers = tasksByOutput[output] ?? [];
    const canStillProduce = producers.some(taskName => {
      const taskState = state.tasks[taskName];
      if (taskState?.status === TASK_STATUS.COMPLETED || isNonActiveTask(taskState)) {
        return false;
      }
      // Check if the producer's dependencies are met
      const taskConfig = graphTasks[taskName];
      const requires = getRequires(taskConfig);
      return requires.every(req => availableOutputs.includes(req));
    });

    if (canStillProduce) {
      return { isComplete: false, expectedCompletion: { taskNames: [], outputs: [] } };
    }
  }

  // Also check no eligible tasks remain
  const eligibleTasks = getEligibleCandidates(graph, state);
  if (eligibleTasks.length > 0) {
    return { isComplete: false, expectedCompletion: { taskNames: eligibleTasks, outputs: [] } };
  }

  // At least some work was done
  const completedCount = Object.values(state.tasks)
    .filter(t => t.status === TASK_STATUS.COMPLETED).length;

  return {
    isComplete: completedCount > 0 || availableOutputs.length > 0,
    expectedCompletion: { taskNames: [], outputs: [] },
  };
}

function checkGoalReached(graph: GraphConfig, state: ExecutionState): CompletionResult {
  const goal = graph.settings.goal ?? [];
  if (goal.length === 0) {
    // No goal defined, fall back to all-outputs-done
    return checkAllOutputsDone(graph, state);
  }

  const availableOutputs = computeAvailableOutputs(graph, state.tasks);
  const goalReached = goal.every(output => availableOutputs.includes(output));

  return {
    isComplete: goalReached,
    expectedCompletion: { taskNames: [], outputs: goal },
  };
}

/**
 * Quick eligibility check used by completion. Minimal version of scheduler logic.
 */
function getEligibleCandidates(graph: GraphConfig, state: ExecutionState): string[] {
  const graphTasks = getAllTasks(graph);
  const availableOutputs = computeAvailableOutputs(graph, state.tasks);
  const candidates: string[] = [];

  for (const [taskName, taskConfig] of Object.entries(graphTasks)) {
    const taskState = state.tasks[taskName];
    if (taskState?.status === TASK_STATUS.COMPLETED ||
        taskState?.status === TASK_STATUS.RUNNING ||
        isNonActiveTask(taskState)) {
      continue;
    }

    const requires = getRequires(taskConfig);
    if (requires.every(req => availableOutputs.includes(req))) {
      const provides = getProvides(taskConfig);
      const allAlreadyAvailable = provides.length > 0 &&
        provides.every(output => availableOutputs.includes(output));
      if (!allAlreadyAvailable) {
        candidates.push(taskName);
      }
    }
  }

  return candidates;
}
