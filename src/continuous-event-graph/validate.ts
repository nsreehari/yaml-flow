/**
 * Continuous Event Graph — Validation Utilities
 *
 * Runtime state-consistency checks for LiveGraph and ReactiveGraph.
 * Unlike event-graph/validate.ts which validates static GraphConfig structure,
 * these validate the *live* runtime state against its config.
 *
 * Pure functions — config+state in, diagnostics out.
 */

import type { LiveGraph } from './types.js';
import type { ReactiveGraph } from './reactive.js';
import type { GraphIssue, GraphValidationResult } from '../event-graph/validate.js';
import { getProvides, getAllTasks } from '../event-graph/graph-helpers.js';
import { TASK_STATUS } from '../event-graph/constants.js';

// ============================================================================
// validateLiveGraph — state/config consistency
// ============================================================================

/**
 * Validate that a LiveGraph's runtime state is consistent with its config.
 *
 * Checks:
 *   - Every config task has a corresponding state entry (MISSING_STATE)
 *   - No orphan state entries exist for tasks not in config (ORPHAN_STATE)
 *   - Running tasks have a startedAt timestamp (RUNNING_WITHOUT_START)
 *   - Completed tasks have a completedAt timestamp (COMPLETED_WITHOUT_TIMESTAMP)
 *   - Failed tasks have a failedAt timestamp and error (FAILED_WITHOUT_INFO)
 *   - Available outputs match what completed tasks should have produced (PHANTOM_OUTPUT / MISSING_OUTPUT)
 *   - Execution counts are non-negative (INVALID_EXECUTION_COUNT)
 *   - No task has executionCount > maxExecutions when capped (EXCEEDED_MAX_EXECUTIONS)
 */
export function validateLiveGraph(live: LiveGraph): GraphValidationResult {
  const issues: GraphIssue[] = [];
  const { config, state } = live;
  const tasks = getAllTasks(config);
  const taskNames = Object.keys(tasks);

  // ---- 1. Missing state entries ----
  for (const name of taskNames) {
    if (!state.tasks[name]) {
      issues.push({
        severity: 'error',
        code: 'MISSING_STATE',
        message: `Task "${name}" exists in config but has no state entry`,
        tasks: [name],
      });
    }
  }

  // ---- 2. Orphan state entries ----
  for (const name of Object.keys(state.tasks)) {
    if (!tasks[name]) {
      issues.push({
        severity: 'warning',
        code: 'ORPHAN_STATE',
        message: `State entry "${name}" has no corresponding task config`,
        tasks: [name],
      });
    }
  }

  // ---- 3. Status consistency ----
  for (const name of taskNames) {
    const ts = state.tasks[name];
    if (!ts) continue;

    if (ts.status === TASK_STATUS.RUNNING && !ts.startedAt) {
      issues.push({
        severity: 'warning',
        code: 'RUNNING_WITHOUT_START',
        message: `Task "${name}" is running but has no startedAt timestamp`,
        tasks: [name],
      });
    }

    if (ts.status === TASK_STATUS.COMPLETED && !ts.completedAt) {
      issues.push({
        severity: 'warning',
        code: 'COMPLETED_WITHOUT_TIMESTAMP',
        message: `Task "${name}" is completed but has no completedAt timestamp`,
        tasks: [name],
      });
    }

    if (ts.status === TASK_STATUS.FAILED) {
      if (!ts.failedAt) {
        issues.push({
          severity: 'warning',
          code: 'FAILED_WITHOUT_INFO',
          message: `Task "${name}" is failed but has no failedAt timestamp`,
          tasks: [name],
        });
      }
      if (!ts.error) {
        issues.push({
          severity: 'info',
          code: 'FAILED_WITHOUT_INFO',
          message: `Task "${name}" is failed but has no error message`,
          tasks: [name],
        });
      }
    }
  }

  // ---- 4. Available outputs consistency ----
  // Compute what outputs SHOULD be available based on completed tasks
  const expectedOutputs = new Set<string>();
  for (const name of taskNames) {
    const ts = state.tasks[name];
    if (ts?.status === TASK_STATUS.COMPLETED) {
      for (const token of getProvides(tasks[name])) {
        expectedOutputs.add(token);
      }
    }
  }

  const actualOutputs = new Set(state.availableOutputs);

  // Phantom outputs: in state but no completed task produced them
  // (tokens injected via inject-tokens are valid, so only flag those
  //  that also aren't in ANY task's provides list — truly phantom)
  const allProducible = new Set<string>();
  for (const taskConfig of Object.values(tasks)) {
    for (const t of getProvides(taskConfig)) allProducible.add(t);
    if (taskConfig.on) {
      for (const tokens of Object.values(taskConfig.on)) {
        for (const t of tokens) allProducible.add(t);
      }
    }
    if (taskConfig.on_failure) {
      for (const t of taskConfig.on_failure) allProducible.add(t);
    }
  }

  for (const token of actualOutputs) {
    if (!expectedOutputs.has(token) && !allProducible.has(token)) {
      // Token is available but no task can produce it — likely injected, just info
      issues.push({
        severity: 'info',
        code: 'INJECTED_TOKEN',
        message: `Token "${token}" is available but no task in the graph can produce it (likely injected)`,
        tokens: [token],
      });
    }
  }

  // Missing outputs: a completed task's provides aren't in available outputs
  for (const token of expectedOutputs) {
    if (!actualOutputs.has(token)) {
      issues.push({
        severity: 'warning',
        code: 'MISSING_OUTPUT',
        message: `Token "${token}" should be available (its producer completed) but is not in availableOutputs`,
        tokens: [token],
      });
    }
  }

  // ---- 5. Execution count integrity ----
  for (const name of taskNames) {
    const ts = state.tasks[name];
    if (!ts) continue;

    if (ts.executionCount < 0) {
      issues.push({
        severity: 'error',
        code: 'INVALID_EXECUTION_COUNT',
        message: `Task "${name}" has negative execution count: ${ts.executionCount}`,
        tasks: [name],
      });
    }

    const maxExec = tasks[name].maxExecutions;
    if (maxExec !== undefined && ts.executionCount > maxExec) {
      issues.push({
        severity: 'error',
        code: 'EXCEEDED_MAX_EXECUTIONS',
        message: `Task "${name}" executed ${ts.executionCount} times, exceeding maxExecutions of ${maxExec}`,
        tasks: [name],
      });
    }
  }

  return buildResult(issues);
}

// ============================================================================
// validateReactiveGraph — reactive-layer consistency
// ============================================================================

/**
 * Input for reactive graph validation.
 * Accepts the reactive graph instance plus the original options (for handler list reference).
 */
export interface ReactiveGraphValidationInput {
  /** The reactive graph instance to validate */
  graph: ReactiveGraph;
  /** The handler registry (handler name → handler function) */
  handlers: Record<string, unknown>;
}

/**
 * Validate reactive-graph-specific consistency.
 *
 * Checks:
 *   - Every handler name referenced in taskConfig.taskHandlers exists in the registry (MISSING_HANDLER)
 *   - No handlers registered that are not referenced by any task's taskHandlers (ORPHAN_HANDLER)
 *   - Plus all validateLiveGraph checks on the underlying state
 */
export function validateReactiveGraph(input: ReactiveGraphValidationInput): GraphValidationResult {
  const { graph, handlers } = input;
  const live = graph.getState();
  const issues: GraphIssue[] = [];

  const tasks = getAllTasks(live.config);
  const taskNames = Object.keys(tasks);
  const handlerNames = new Set(Object.keys(handlers));

  // Collect all handler names referenced by any task's taskHandlers
  const referencedHandlers = new Set<string>();
  for (const name of taskNames) {
    const taskHandlers = tasks[name].taskHandlers;
    if (taskHandlers) {
      for (const h of taskHandlers) {
        referencedHandlers.add(h);
      }
    }
  }

  // ---- 1. Missing handlers — taskHandlers references a name not in registry ----
  for (const name of taskNames) {
    const taskHandlers = tasks[name].taskHandlers;
    if (!taskHandlers) continue; // externally driven — no handler needed
    for (const h of taskHandlers) {
      if (!handlers[h]) {
        issues.push({
          severity: 'error',
          code: 'MISSING_HANDLER',
          message: `Task "${name}" references handler "${h}" but it is not in the registry`,
          tasks: [name],
        });
      }
    }
  }

  // ---- 2. Orphan handlers — registered but not referenced by any task ----
  for (const name of handlerNames) {
    if (!referencedHandlers.has(name)) {
      issues.push({
        severity: 'warning',
        code: 'ORPHAN_HANDLER',
        message: `Handler "${name}" is registered but not referenced by any task's taskHandlers`,
        tasks: [name],
      });
    }
  }

  // ---- 3. Include underlying LiveGraph validation ----
  const liveResult = validateLiveGraph(live);
  issues.push(...liveResult.issues);

  return buildResult(issues);
}

// ============================================================================
// Shared
// ============================================================================

function buildResult(issues: GraphIssue[]): GraphValidationResult {
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  return {
    valid: errors.length === 0,
    issues,
    errors,
    warnings,
  };
}
