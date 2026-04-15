/**
 * Event Graph — Semantic Graph Validation
 *
 * Validates the logical correctness of a static graph configuration.
 * Unlike validateGraphConfig() which checks JSON structure, this checks:
 *   - Dangling requires (tokens no task produces)
 *   - Circular dependencies
 *   - Provide conflicts (multiple tasks producing same token)
 *   - Unreachable goal tokens
 *   - Dead-end tasks (no provides)
 *   - Self-dependencies
 *   - Orphaned tasks (disconnected from the graph)
 *
 * Pure function — config in, diagnostics out.
 */

import type { GraphConfig, TaskConfig } from './types.js';
import { getRequires, getProvides, getAllTasks } from './graph-helpers.js';

// ============================================================================
// Types
// ============================================================================

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface GraphIssue {
  /** Severity: error = will break execution, warning = may cause problems, info = notable */
  severity: IssueSeverity;
  /** Machine-readable issue code */
  code: string;
  /** Human-readable description */
  message: string;
  /** Affected task names (if applicable) */
  tasks?: string[];
  /** Affected tokens (if applicable) */
  tokens?: string[];
}

export interface GraphValidationResult {
  /** true if no errors (warnings/info are allowed) */
  valid: boolean;
  /** All issues found */
  issues: GraphIssue[];
  /** Just the errors */
  errors: GraphIssue[];
  /** Just the warnings */
  warnings: GraphIssue[];
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Build a map: token → tasks that produce it (including on-conditional and on_failure).
 */
function buildProducerMap(tasks: Record<string, TaskConfig>): Record<string, string[]> {
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

/**
 * Build task-to-task dependency edges from the token graph.
 */
function buildTaskDeps(
  tasks: Record<string, TaskConfig>,
  producerMap: Record<string, string[]>,
): Record<string, Set<string>> {
  const deps: Record<string, Set<string>> = {};
  for (const [name, config] of Object.entries(tasks)) {
    deps[name] = new Set<string>();
    for (const token of getRequires(config)) {
      for (const producer of (producerMap[token] || [])) {
        if (producer !== name) deps[name].add(producer);
      }
    }
  }
  return deps;
}

/**
 * Detect cycles using DFS. Returns arrays of task names forming cycles.
 */
function detectCycles(
  taskNames: string[],
  deps: Record<string, Set<string>>,
): string[][] {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color: Record<string, number> = {};
  const parent: Record<string, string | null> = {};
  const cycles: string[][] = [];

  for (const name of taskNames) {
    color[name] = WHITE;
    parent[name] = null;
  }

  function dfs(node: string): void {
    color[node] = GRAY;
    for (const dep of deps[node] || []) {
      if (color[dep] === GRAY) {
        // Back edge — trace cycle
        const cycle: string[] = [dep];
        let cur = node;
        while (cur !== dep) {
          cycle.push(cur);
          cur = parent[cur]!;
        }
        cycle.push(dep);
        cycle.reverse();
        cycles.push(cycle);
      } else if (color[dep] === WHITE) {
        parent[dep] = node;
        dfs(dep);
      }
    }
    color[node] = BLACK;
  }

  for (const name of taskNames) {
    if (color[name] === WHITE) {
      dfs(name);
    }
  }

  return cycles;
}

/**
 * Validate the semantic correctness of a static event-graph configuration.
 *
 * Checks for logical issues that would cause execution failures, stuck states,
 * or unexpected behavior. Does NOT check JSON structure (use validateGraphConfig for that).
 *
 * @param graph - The event-graph configuration to validate
 * @returns Validation result with categorized issues
 */
export function validateGraph(graph: GraphConfig): GraphValidationResult {
  const issues: GraphIssue[] = [];
  const tasks = getAllTasks(graph);
  const taskNames = Object.keys(tasks);

  if (taskNames.length === 0) {
    issues.push({
      severity: 'error',
      code: 'EMPTY_GRAPH',
      message: 'Graph has no tasks',
    });
    return buildResult(issues);
  }

  const producerMap = buildProducerMap(tasks);
  const deps = buildTaskDeps(tasks, producerMap);

  // ---- 1. Dangling requires: tokens no task produces ----
  for (const [name, config] of Object.entries(tasks)) {
    for (const token of getRequires(config)) {
      if (!producerMap[token]) {
        issues.push({
          severity: 'error',
          code: 'DANGLING_REQUIRES',
          message: `Task "${name}" requires token "${token}" but no task produces it`,
          tasks: [name],
          tokens: [token],
        });
      }
    }
  }

  // ---- 2. Circular dependencies ----
  const cycles = detectCycles(taskNames, deps);
  for (const cycle of cycles) {
    issues.push({
      severity: 'error',
      code: 'CIRCULAR_DEPENDENCY',
      message: `Circular dependency: ${cycle.join(' → ')}`,
      tasks: cycle.filter((_t, i) => i < cycle.length - 1), // dedupe last = first
    });
  }

  // ---- 3. Self-dependency ----
  for (const [name, config] of Object.entries(tasks)) {
    const req = getRequires(config);
    const prov = getProvides(config);
    const self = req.filter((token) => prov.includes(token));
    if (self.length > 0) {
      issues.push({
        severity: 'error',
        code: 'SELF_DEPENDENCY',
        message: `Task "${name}" requires tokens it provides itself: [${self.join(', ')}]`,
        tasks: [name],
        tokens: self,
      });
    }
  }

  // ---- 4. Provide conflicts ----
  for (const [token, producers] of Object.entries(producerMap)) {
    if (producers.length > 1) {
      issues.push({
        severity: 'warning',
        code: 'PROVIDE_CONFLICT',
        message: `Token "${token}" is produced by multiple tasks: [${producers.join(', ')}]. This requires a conflict strategy.`,
        tasks: producers,
        tokens: [token],
      });
    }
  }

  // ---- 5. Goal tokens unreachable ----
  if (graph.settings.completion === 'goal-reached' && graph.settings.goal) {
    for (const goalToken of graph.settings.goal) {
      if (!producerMap[goalToken]) {
        issues.push({
          severity: 'error',
          code: 'UNREACHABLE_GOAL',
          message: `Goal token "${goalToken}" cannot be produced by any task`,
          tokens: [goalToken],
        });
      }
    }
  }

  // ---- 6. Dead-end tasks (no provides and not the only task) ----
  if (taskNames.length > 1) {
    for (const [name, config] of Object.entries(tasks)) {
      const prov = getProvides(config);
      const onProv = config.on ? Object.values(config.on).flat() : [];
      const failProv = config.on_failure || [];
      if (prov.length === 0 && onProv.length === 0 && failProv.length === 0) {
        issues.push({
          severity: 'warning',
          code: 'DEAD_END_TASK',
          message: `Task "${name}" has no provides — it cannot unblock any downstream task`,
          tasks: [name],
        });
      }
    }
  }

  // ---- 7. Orphaned tasks (no requires AND no task depends on their provides) ----
  const allRequired = new Set<string>();
  for (const config of Object.values(tasks)) {
    for (const token of getRequires(config)) {
      allRequired.add(token);
    }
  }
  for (const [name, config] of Object.entries(tasks)) {
    const req = getRequires(config);
    const prov = getProvides(config);
    const onProv = config.on ? Object.values(config.on).flat() : [];
    const allProv = [...prov, ...onProv];
    const isEntryPoint = req.length === 0;
    const hasDownstream = allProv.some((token) => allRequired.has(token));

    // If this has requires and provides and is connected — fine
    // If it's an entry point with downstream — fine
    // If it's an entry point with NO downstream and not a goal-relevant task — orphan
    if (isEntryPoint && !hasDownstream && taskNames.length > 1) {
      // Check if it produces goal tokens
      const isGoalRelevant =
        graph.settings.completion === 'goal-reached' &&
        graph.settings.goal?.some((g) => allProv.includes(g));
      if (!isGoalRelevant) {
        issues.push({
          severity: 'info',
          code: 'ISOLATED_TASK',
          message: `Task "${name}" is disconnected — it has no requires and nothing depends on its provides`,
          tasks: [name],
        });
      }
    }
  }

  // ---- 8. Completion strategy sanity ----
  if (graph.settings.completion === 'goal-reached' && !graph.settings.goal) {
    issues.push({
      severity: 'error',
      code: 'MISSING_GOAL',
      message: 'Completion strategy is "goal-reached" but no goal tokens are defined',
    });
  }

  return buildResult(issues);
}

function buildResult(issues: GraphIssue[]): GraphValidationResult {
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return {
    valid: errors.length === 0,
    issues,
    errors,
    warnings,
  };
}
