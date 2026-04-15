/**
 * Event Graph — Stuck Detection
 *
 * Pure function to detect when a graph execution cannot make progress.
 */

import type { GraphConfig, ExecutionState, StuckDetection } from './types.js';
import { TASK_STATUS } from './constants.js';
import { getAllTasks, getProvides, getRequires, isNonActiveTask, computeAvailableOutputs } from './graph-helpers.js';
import type { CompletionResult } from './completion.js';

/**
 * Detect if the graph execution is stuck.
 * Stuck = no eligible tasks AND execution is not complete.
 * Pure function.
 */
export function detectStuckState(params: {
  graph: GraphConfig;
  state: ExecutionState;
  eligibleTasks: string[];
  completionResult?: CompletionResult;
}): StuckDetection {
  const { graph, state, eligibleTasks, completionResult } = params;
  const tasks = state.tasks;
  const graphTasks = getAllTasks(graph);
  const availableOutputs = computeAvailableOutputs(graph, tasks);

  // If there are eligible tasks, we're not stuck
  if (eligibleTasks.length > 0) {
    return { is_stuck: false, stuck_description: null, outputs_unresolvable: [], tasks_blocked: [] };
  }

  // If any tasks are currently running, we're not stuck yet
  const hasRunningTasks = Object.values(tasks).some(t => t.status === TASK_STATUS.RUNNING);
  if (hasRunningTasks) {
    return { is_stuck: false, stuck_description: null, outputs_unresolvable: [], tasks_blocked: [] };
  }

  // Use completion diagnostic info if available
  if (completionResult?.expectedCompletion) {
    const { taskNames = [], outputs = [] } = completionResult.expectedCompletion;

    // If completion expects specific tasks but all are failed
    if (taskNames.length > 0) {
      const expectedFailed = taskNames.filter(tn => isNonActiveTask(tasks[tn]));
      if (expectedFailed.length > 0 && expectedFailed.length === taskNames.length) {
        return {
          is_stuck: true,
          stuck_description: `Completion expects tasks ${taskNames.join(', ')} but all are failed`,
          tasks_blocked: expectedFailed,
          outputs_unresolvable: outputs,
        };
      }
    }

    // If completion expects outputs that no viable task can produce
    if (outputs.length > 0 && state.executionConfig.completionStrategy !== 'only-resolved') {
      const missingOutputs = outputs.filter(o => !availableOutputs.includes(o));
      if (missingOutputs.length > 0) {
        const unprovidable: string[] = [];
        for (const output of missingOutputs) {
          const providers = Object.entries(graphTasks)
            .filter(([, config]) => getProvides(config).includes(output))
            .map(([name]) => name);
          const viable = providers.filter(p => !isNonActiveTask(tasks[p]));
          if (viable.length === 0) {
            unprovidable.push(output);
          }
        }
        if (unprovidable.length > 0) {
          return {
            is_stuck: true,
            stuck_description: `Completion expects outputs '${unprovidable.join("', '")}' but no viable tasks can provide them`,
            tasks_blocked: [],
            outputs_unresolvable: unprovidable,
          };
        }
      }
    }
  }

  // General stuck check: find tasks that are not-started and have unmet dependencies
  const blockedTasks: string[] = [];
  const missingOutputs = new Set<string>();

  for (const [taskName, taskConfig] of Object.entries(graphTasks)) {
    const taskState = tasks[taskName];
    if (taskState?.status === TASK_STATUS.COMPLETED || isNonActiveTask(taskState) || taskState?.status === TASK_STATUS.RUNNING) {
      continue;
    }

    const requires = getRequires(taskConfig);
    const unmet = requires.filter(req => !availableOutputs.includes(req));
    if (unmet.length > 0) {
      // Check if unmet dependencies can ever be provided
      const canBeProvided = unmet.every(req => {
        const providers = Object.entries(graphTasks)
          .filter(([, config]) => getProvides(config).includes(req))
          .map(([name]) => name);
        return providers.some(p => !isNonActiveTask(tasks[p]) && tasks[p]?.status !== TASK_STATUS.COMPLETED);
      });

      if (!canBeProvided) {
        blockedTasks.push(taskName);
        unmet.forEach(u => missingOutputs.add(u));
      }
    }
  }

  if (blockedTasks.length > 0) {
    return {
      is_stuck: true,
      stuck_description: `Tasks [${blockedTasks.join(', ')}] blocked by unresolvable dependencies: ${[...missingOutputs].join(', ')}`,
      tasks_blocked: blockedTasks,
      outputs_unresolvable: [...missingOutputs],
    };
  }

  return { is_stuck: false, stuck_description: null, outputs_unresolvable: [], tasks_blocked: [] };
}
