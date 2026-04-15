/**
 * Event Graph — Execution Plan (Dry Run)
 *
 * Compute the full execution plan from a GraphConfig without running anything.
 * Shows phases (what runs in parallel), dependency edges, and potential issues.
 *
 * Pure function — no I/O, no side effects.
 */

import type { GraphConfig, TaskConfig } from './types.js';
import { getRequires, getProvides, getAllTasks } from './graph-helpers.js';

// ============================================================================
// Types
// ============================================================================

export interface ExecutionPlan {
  /** Ordered phases — tasks within a phase can run in parallel */
  phases: string[][];
  /** Dependency edges: taskName → tasks it depends on */
  dependencies: Record<string, string[]>;
  /** Tasks that provide conflicts (same output from multiple tasks) */
  conflicts: Record<string, string[]>;
  /** Tasks that have no requires (entry points) */
  entryPoints: string[];
  /** Tasks that nothing depends on (leaf nodes) */
  leafTasks: string[];
  /** Tokens required but not produced by any task */
  unreachableTokens: string[];
  /** Tasks blocked by unreachable tokens */
  blockedTasks: string[];
  /** Total number of phases (depth of the graph) */
  depth: number;
  /** Max parallelism (widest phase) */
  maxParallelism: number;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Build a map: token → tasks that produce it.
 */
function buildProducerMap(tasks: Record<string, TaskConfig>): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const [name, config] of Object.entries(tasks)) {
    for (const token of getProvides(config)) {
      if (!map[token]) map[token] = [];
      map[token].push(name);
    }
    // Also count `on` conditional provides
    if (config.on) {
      for (const tokens of Object.values(config.on)) {
        for (const token of tokens) {
          if (!map[token]) map[token] = [];
          if (!map[token].includes(name)) map[token].push(name);
        }
      }
    }
    // on_failure provides
    if (config.on_failure) {
      for (const token of config.on_failure) {
        if (!map[token]) map[token] = [];
        if (!map[token].includes(name)) map[token].push(name);
      }
    }
  }
  return map;
}

/**
 * Build task-to-task dependency edges from the token graph.
 */
function buildDependencies(
  tasks: Record<string, TaskConfig>,
  producerMap: Record<string, string[]>,
): Record<string, string[]> {
  const deps: Record<string, string[]> = {};
  for (const [name, config] of Object.entries(tasks)) {
    const required = getRequires(config);
    const taskDeps = new Set<string>();
    for (const token of required) {
      const producers = producerMap[token] || [];
      for (const producer of producers) {
        if (producer !== name) taskDeps.add(producer);
      }
    }
    deps[name] = [...taskDeps];
  }
  return deps;
}

/**
 * Topological sort into phases using Kahn's algorithm.
 * Tasks within the same phase have all deps satisfied and can run in parallel.
 */
function computePhases(
  taskNames: string[],
  dependencies: Record<string, string[]>,
): string[][] {
  // Build in-degree map (only counting edges to tasks in taskNames)
  const taskSet = new Set(taskNames);
  const inDegree: Record<string, number> = {};
  const dependents: Record<string, string[]> = {};

  for (const name of taskNames) {
    inDegree[name] = 0;
    dependents[name] = [];
  }

  for (const name of taskNames) {
    for (const dep of dependencies[name] || []) {
      if (taskSet.has(dep)) {
        inDegree[name]++;
        dependents[dep].push(name);
      }
    }
  }

  const phases: string[][] = [];
  const remaining = new Set(taskNames);

  while (remaining.size > 0) {
    // Find all tasks with in-degree 0
    const phase: string[] = [];
    for (const name of remaining) {
      if (inDegree[name] === 0) {
        phase.push(name);
      }
    }

    if (phase.length === 0) {
      // Remaining tasks form a cycle — add them all as a "stuck" phase
      phases.push([...remaining]);
      break;
    }

    phase.sort(); // deterministic ordering within a phase
    phases.push(phase);

    // Remove this phase and update in-degrees
    for (const name of phase) {
      remaining.delete(name);
      for (const dependent of dependents[name] || []) {
        if (remaining.has(dependent)) {
          inDegree[dependent]--;
        }
      }
    }
  }

  return phases;
}

/**
 * Compute a full execution plan from a graph config.
 *
 * Shows the order tasks would execute, what can run in parallel,
 * where conflicts exist, and what's unreachable — all without
 * actually running anything.
 *
 * @param graph - The event-graph configuration
 * @returns ExecutionPlan with phases, dependencies, conflicts, and diagnostics
 */
export function planExecution(graph: GraphConfig): ExecutionPlan {
  const tasks = getAllTasks(graph);
  const taskNames = Object.keys(tasks);

  if (taskNames.length === 0) {
    return {
      phases: [],
      dependencies: {},
      conflicts: {},
      entryPoints: [],
      leafTasks: [],
      unreachableTokens: [],
      blockedTasks: [],
      depth: 0,
      maxParallelism: 0,
    };
  }

  const producerMap = buildProducerMap(tasks);
  const dependencies = buildDependencies(tasks, producerMap);

  // Find conflicts: tokens provided by more than one task
  const conflicts: Record<string, string[]> = {};
  for (const [token, producers] of Object.entries(producerMap)) {
    if (producers.length > 1) {
      conflicts[token] = producers;
    }
  }

  // Entry points: tasks with no requires
  const entryPoints = taskNames.filter((name) => getRequires(tasks[name]).length === 0);

  // Leaf tasks: tasks that no other task depends on
  const dependedOn = new Set<string>();
  for (const deps of Object.values(dependencies)) {
    for (const dep of deps) dependedOn.add(dep);
  }
  const leafTasks = taskNames.filter((name) => !dependedOn.has(name));

  // Unreachable tokens: required by some task but produced by none
  const allRequired = new Set<string>();
  for (const config of Object.values(tasks)) {
    for (const token of getRequires(config)) {
      allRequired.add(token);
    }
  }
  const unreachableTokens = [...allRequired].filter((token) => !producerMap[token]);

  // Blocked tasks: tasks that require unreachable tokens
  const unreachableSet = new Set(unreachableTokens);
  const blockedTasks = taskNames.filter((name) =>
    getRequires(tasks[name]).some((token) => unreachableSet.has(token)),
  );

  // Compute phases
  const phases = computePhases(taskNames, dependencies);

  return {
    phases,
    dependencies,
    conflicts,
    entryPoints,
    leafTasks: leafTasks.sort(),
    unreachableTokens: unreachableTokens.sort(),
    blockedTasks: blockedTasks.sort(),
    depth: phases.length,
    maxParallelism: Math.max(0, ...phases.map((p) => p.length)),
  };
}
