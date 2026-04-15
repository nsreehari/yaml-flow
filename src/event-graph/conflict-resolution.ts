/**
 * Event Graph — Conflict Resolution Strategies
 *
 * Pure functions for selecting tasks when multiple candidates compete
 * for the same output.
 */

import type { TaskConfig, ExecutionState, ConflictStrategy } from './types.js';
import { getProvides, groupTasksByProvides, hasOutputConflict } from './graph-helpers.js';

/**
 * Select the best alternative from a group of competing tasks.
 * Pure function.
 */
export function selectBestAlternative(
  alternatives: string[],
  graphTasks: Record<string, TaskConfig>,
  _executionState: ExecutionState,
  strategy: ConflictStrategy
): string {
  switch (strategy) {
    case 'alphabetical':
      return selectByAlphabetical(alternatives);
    case 'priority-first':
      return selectByPriorityFirst(alternatives, graphTasks);
    case 'duration-first':
      return selectByDurationFirst(alternatives, graphTasks);
    case 'cost-optimized':
      return selectByCostOptimized(alternatives, graphTasks);
    case 'resource-aware':
      return selectByResourceAware(alternatives, graphTasks);
    case 'round-robin':
      return selectByRoundRobin(alternatives, _executionState);
    default:
      return selectByAlphabetical(alternatives);
  }
}

function selectByAlphabetical(alternatives: string[]): string {
  return [...alternatives].sort((a, b) => a.localeCompare(b))[0];
}

function selectByPriorityFirst(alternatives: string[], graphTasks: Record<string, TaskConfig>): string {
  return [...alternatives].sort((a, b) => {
    const pA = graphTasks[a]?.priority ?? 0;
    const pB = graphTasks[b]?.priority ?? 0;
    if (pA !== pB) return pB - pA; // higher priority first
    const dA = getEstimatedDuration(graphTasks[a]);
    const dB = getEstimatedDuration(graphTasks[b]);
    if (dA !== dB) return dA - dB; // shorter duration first
    return a.localeCompare(b);
  })[0];
}

function selectByDurationFirst(alternatives: string[], graphTasks: Record<string, TaskConfig>): string {
  return [...alternatives].sort((a, b) => {
    const dA = getEstimatedDuration(graphTasks[a]);
    const dB = getEstimatedDuration(graphTasks[b]);
    if (dA !== dB) return dA - dB;
    const pA = graphTasks[a]?.priority ?? 0;
    const pB = graphTasks[b]?.priority ?? 0;
    if (pA !== pB) return pB - pA;
    return a.localeCompare(b);
  })[0];
}

function selectByCostOptimized(alternatives: string[], graphTasks: Record<string, TaskConfig>): string {
  return [...alternatives].sort((a, b) => {
    const cA = graphTasks[a]?.estimatedCost ?? 0;
    const cB = graphTasks[b]?.estimatedCost ?? 0;
    if (cA !== cB) return cA - cB; // lower cost first
    const pA = graphTasks[a]?.priority ?? 0;
    const pB = graphTasks[b]?.priority ?? 0;
    if (pA !== pB) return pB - pA;
    return a.localeCompare(b);
  })[0];
}

function selectByResourceAware(alternatives: string[], graphTasks: Record<string, TaskConfig>): string {
  return [...alternatives].sort((a, b) => {
    const rA = graphTasks[a]?.estimatedResources?.cpu ?? 1;
    const rB = graphTasks[b]?.estimatedResources?.cpu ?? 1;
    if (rA !== rB) return rA - rB; // lower resource first
    const pA = graphTasks[a]?.priority ?? 0;
    const pB = graphTasks[b]?.priority ?? 0;
    if (pA !== pB) return pB - pA;
    return a.localeCompare(b);
  })[0];
}

function selectByRoundRobin(alternatives: string[], executionState: ExecutionState): string {
  // Rotate based on total execution count across tasks
  const totalExecs = Object.values(executionState.tasks)
    .reduce((sum, t) => sum + t.executionCount, 0);
  const sorted = [...alternatives].sort();
  return sorted[totalExecs % sorted.length];
}

function getEstimatedDuration(taskConfig: TaskConfig | undefined): number {
  return taskConfig?.estimatedDuration ?? Infinity;
}

/**
 * Get tasks that don't have output conflicts with any other candidate.
 */
export function getNonConflictingTasks(
  candidates: string[],
  graphTasks: Record<string, TaskConfig>
): string[] {
  return candidates.filter(taskName => {
    const provides = getProvides(graphTasks[taskName]);
    return !hasOutputConflict(taskName, provides, candidates, graphTasks);
  });
}

/**
 * Select random task from each conflict group (for A/B testing).
 */
export function selectRandomTasks(
  candidates: string[],
  graphTasks: Record<string, TaskConfig>
): string[] {
  const outputGroups = groupTasksByProvides(candidates, graphTasks);
  const selected: string[] = [];

  for (const groupTasks of Object.values(outputGroups)) {
    if (groupTasks.length === 1) {
      selected.push(...groupTasks);
    } else {
      const idx = Math.floor(Math.random() * groupTasks.length);
      selected.push(groupTasks[idx]);
    }
  }

  // Add non-conflicting tasks
  const nonConflicting = getNonConflictingTasks(candidates, graphTasks);
  nonConflicting.forEach(t => {
    if (!selected.includes(t)) selected.push(t);
  });

  return selected;
}
