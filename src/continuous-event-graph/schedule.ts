/**
 * Continuous Event Graph — Schedule
 *
 * Pure read-only projection: LiveGraph → ScheduleResult
 *
 * Classifies every non-terminal task into one of:
 *   - eligible: all requires satisfied, ready to dispatch
 *   - pending: requires not yet met, but a viable producer exists (normal waiting)
 *   - unresolved: requires not met, NO task in the graph can produce them (caller's problem)
 *   - blocked: requires not met because the producing task FAILED (caller's problem)
 */

import type { LiveGraph, ScheduleResult, PendingTask, UnresolvedDependency, BlockedTask } from './types.js';
import { getProvides, getRequires, getAllTasks, isNonActiveTask, computeAvailableOutputs, getMaxExecutions, getRefreshStrategy, groupTasksByProvides } from '../event-graph/graph-helpers.js';
import { TASK_STATUS } from '../event-graph/constants.js';

/**
 * Compute the scheduling status of every task in the live graph.
 * Pure function — no side effects.
 */
export function schedule(live: LiveGraph): ScheduleResult {
  const { config, state } = live;
  const graphTasks = getAllTasks(config);
  const taskNames = Object.keys(graphTasks);

  if (taskNames.length === 0) {
    return { eligible: [], pending: [], unresolved: [], blocked: [], conflicts: {} };
  }

  // Build producer map: token → tasks that produce it (includes on/on_failure)
  const producerMap = buildProducerMap(graphTasks);

  // Available outputs: from completed tasks + injected tokens
  const computedOutputs = computeAvailableOutputs(config, state.tasks);
  const availableOutputs = new Set([...computedOutputs, ...state.availableOutputs]);

  const eligible: string[] = [];
  const pending: PendingTask[] = [];
  const unresolved: UnresolvedDependency[] = [];
  const blocked: BlockedTask[] = [];

  for (const [taskName, taskConfig] of Object.entries(graphTasks)) {
    const taskState = state.tasks[taskName];
    const strategy = getRefreshStrategy(taskConfig, config.settings);
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

    // Circuit breaker
    if (taskConfig.circuit_breaker && taskState &&
        taskState.executionCount >= taskConfig.circuit_breaker.max_executions) {
      continue;
    }

    // For once-only tasks: skip if completed
    if (!rerunnable && taskState?.status === TASK_STATUS.COMPLETED) {
      continue;
    }

    // For re-runnable tasks that already completed: check strategy
    if (rerunnable && taskState?.status === TASK_STATUS.COMPLETED) {
      const requires = getRequires(taskConfig);

      let shouldSkip = false;
      switch (strategy) {
        case 'data-changed': {
          if (requires.length > 0) {
            const hasChangedData = requires.some(req => {
              for (const [otherName, otherConfig] of Object.entries(graphTasks)) {
                if (getProvides(otherConfig).includes(req)) {
                  const otherState = state.tasks[otherName];
                  if (!otherState) continue;
                  const consumed = taskState.lastConsumedHashes?.[req];
                  if (otherState.lastDataHash == null) {
                    return otherState.executionCount > taskState.lastEpoch;
                  }
                  return otherState.lastDataHash !== consumed;
                }
              }
              return false;
            });
            if (!hasChangedData) shouldSkip = true;
          } else {
            shouldSkip = true;
          }
          break;
        }
        case 'epoch-changed': {
          if (requires.length > 0) {
            const hasRefreshed = requires.some(req => {
              for (const [otherName, otherConfig] of Object.entries(graphTasks)) {
                if (getProvides(otherConfig).includes(req)) {
                  const otherState = state.tasks[otherName];
                  if (otherState && otherState.executionCount > taskState.lastEpoch) return true;
                }
              }
              return false;
            });
            if (!hasRefreshed) shouldSkip = true;
          } else {
            shouldSkip = true;
          }
          break;
        }
        case 'time-based': {
          const interval = taskConfig.refreshInterval ?? 0;
          if (interval <= 0) { shouldSkip = true; break; }
          const completedAt = taskState.completedAt;
          if (!completedAt) { shouldSkip = true; break; }
          const elapsedSec = (Date.now() - Date.parse(completedAt)) / 1000;
          if (elapsedSec < interval) shouldSkip = true;
          break;
        }
        case 'manual':
          shouldSkip = true;
          break;
      }
      if (shouldSkip) continue;
    }

    const requires = getRequires(taskConfig);

    // No requires → eligible (entry point)
    if (requires.length === 0) {
      eligible.push(taskName);
      continue;
    }

    // Check each required token
    const missingTokens: string[] = [];
    const pendingTokens: string[] = [];
    const failedTokenInfo: { token: string; failedProducer: string }[] = [];

    for (const token of requires) {
      if (availableOutputs.has(token)) continue;

      const producers = producerMap[token] || [];

      if (producers.length === 0) {
        // No task produces this token → unresolved
        missingTokens.push(token);
      } else {
        // Check if all producers have failed
        const allFailed = producers.every(p => isNonActiveTask(state.tasks[p]));
        if (allFailed) {
          failedTokenInfo.push({ token, failedProducer: producers[0] });
        } else {
          // At least one producer is viable → pending (normal wait)
          pendingTokens.push(token);
        }
      }
    }

    if (missingTokens.length > 0) {
      unresolved.push({ taskName, missingTokens });
    } else if (failedTokenInfo.length > 0) {
      blocked.push({
        taskName,
        failedTokens: failedTokenInfo.map(f => f.token),
        failedProducers: [...new Set(failedTokenInfo.map(f => f.failedProducer))],
      });
    } else if (pendingTokens.length > 0) {
      pending.push({ taskName, waitingOn: pendingTokens });
    } else {
      // All requires satisfied
      eligible.push(taskName);
    }
  }

  // Detect conflicts among eligible tasks
  const conflicts: Record<string, string[]> = {};
  if (eligible.length > 1) {
    const outputGroups = groupTasksByProvides(eligible, graphTasks);
    for (const [outputKey, groupTasks] of Object.entries(outputGroups)) {
      if (groupTasks.length > 1) {
        conflicts[outputKey] = groupTasks;
      }
    }
  }

  return { eligible, pending, unresolved, blocked, conflicts };
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Build a map: token → tasks that produce it (via provides, on, on_failure).
 */
function buildProducerMap(tasks: Record<string, import('../event-graph/types.js').TaskConfig>): Record<string, string[]> {
  const map: Record<string, string[]> = {};

  for (const [name, config] of Object.entries(tasks)) {
    for (const token of getProvides(config)) {
      if (!map[token]) map[token] = [];
      map[token].push(name);
    }
    if (config.on) {
      for (const tokens of Object.values(config.on)) {
        for (const token of tokens) {
          if (!map[token]) map[token] = [];
          if (!map[token].includes(name)) map[token].push(name);
        }
      }
    }
    if (config.on_failure) {
      for (const token of config.on_failure) {
        if (!map[token]) map[token] = [];
        if (!map[token].includes(name)) map[token].push(name);
      }
    }
  }

  return map;
}
