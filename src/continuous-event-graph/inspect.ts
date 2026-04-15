/**
 * Continuous Event Graph — Inspect
 *
 * Pure read-only projection: LiveGraph → LiveGraphHealth
 *
 * Live health report combining config structure + runtime state.
 */

import type { LiveGraph, LiveGraphHealth, UnreachableTokensResult, UnreachableNodesResult, UpstreamResult, DownstreamResult } from './types.js';
import { getProvides, getRequires, getAllTasks, isNonActiveTask } from '../event-graph/graph-helpers.js';
import { TASK_STATUS } from '../event-graph/constants.js';

/**
 * Compute a live health report for the graph.
 * Combines structural analysis (cycles, conflicts, open deps) with runtime state (task statuses).
 * Pure function — no side effects.
 */
export function inspect(live: LiveGraph): LiveGraphHealth {
  const { config, state } = live;
  const graphTasks = getAllTasks(config);
  const taskNames = Object.keys(graphTasks);

  // --- Task status counts ---
  let running = 0, completed = 0, failed = 0, waiting = 0, notStarted = 0, disabled = 0;

  for (const taskName of taskNames) {
    const ts = state.tasks[taskName];
    if (!ts || ts.status === TASK_STATUS.NOT_STARTED) {
      notStarted++;
    } else {
      switch (ts.status) {
        case TASK_STATUS.RUNNING: running++; break;
        case TASK_STATUS.COMPLETED: completed++; break;
        case TASK_STATUS.FAILED: failed++; break;
        case 'inactivated': disabled++; break;
        default: waiting++;
      }
    }
  }

  // --- Producer map ---
  const producerMap: Record<string, string[]> = {};
  for (const [name, taskConfig] of Object.entries(graphTasks)) {
    for (const token of getProvides(taskConfig)) {
      if (!producerMap[token]) producerMap[token] = [];
      producerMap[token].push(name);
    }
    if (taskConfig.on) {
      for (const tokens of Object.values(taskConfig.on)) {
        for (const token of tokens) {
          if (!producerMap[token]) producerMap[token] = [];
          if (!producerMap[token].includes(name)) producerMap[token].push(name);
        }
      }
    }
    if (taskConfig.on_failure) {
      for (const token of taskConfig.on_failure) {
        if (!producerMap[token]) producerMap[token] = [];
        if (!producerMap[token].includes(name)) producerMap[token].push(name);
      }
    }
  }

  // --- Open dependencies: tokens required but no producer exists ---
  const openDeps = new Set<string>();
  let unresolvedCount = 0;
  let blockedCount = 0;

  for (const [taskName, taskConfig] of Object.entries(graphTasks)) {
    const ts = state.tasks[taskName];
    // Skip already-completed or running
    if (ts?.status === TASK_STATUS.COMPLETED || ts?.status === TASK_STATUS.RUNNING) continue;

    let hasOpen = false;
    let hasBlocked = false;
    for (const token of getRequires(taskConfig)) {
      const producers = producerMap[token] || [];
      if (producers.length === 0) {
        openDeps.add(token);
        hasOpen = true;
      } else {
        const allFailed = producers.every(p => {
          const ps = state.tasks[p];
          return ps?.status === TASK_STATUS.FAILED || ps?.status === 'inactivated';
        });
        if (allFailed) hasBlocked = true;
      }
    }
    if (hasOpen) unresolvedCount++;
    if (hasBlocked && !hasOpen) blockedCount++;
  }

  // --- Conflict tokens: produced by multiple tasks ---
  const conflictTokens: string[] = [];
  for (const [token, producers] of Object.entries(producerMap)) {
    if (producers.length > 1) conflictTokens.push(token);
  }

  // --- Cycle detection (DFS) ---
  const deps = buildTaskDeps(graphTasks, producerMap);
  const cycles = detectCycles(taskNames, deps);

  return {
    totalNodes: taskNames.length,
    running, completed, failed, waiting, notStarted, disabled,
    unresolvedCount,
    blockedCount,
    openDependencies: [...openDeps],
    cycles,
    conflictTokens,
  };
}

// ============================================================================
// Cycle detection internals (pure)
// ============================================================================

function buildTaskDeps(
  tasks: Record<string, import('../event-graph/types.js').TaskConfig>,
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
    if (color[name] === WHITE) dfs(name);
  }

  return cycles;
}

// ============================================================================
// Reachability analysis (transitive)
// ============================================================================

/**
 * Build producer map: token → task names that produce it.
 */
function buildProducerMap(
  tasks: Record<string, import('../event-graph/types.js').TaskConfig>,
): Record<string, string[]> {
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
 * Get all tokens that are required but cannot be produced given the current
 * graph state. This is **transitive**: if token X is unreachable, and node A
 * is the only producer of token Y but A requires X, then Y is also unreachable.
 *
 * Takes into account:
 * - Tokens already in availableOutputs (reachable)
 * - Tokens from completed tasks (reachable)
 * - Failed/disabled producers (non-viable)
 *
 * Pure function.
 */
export function getUnreachableTokens(live: LiveGraph): UnreachableTokensResult {
  const { config, state } = live;
  const graphTasks = getAllTasks(config);
  const producerMap = buildProducerMap(graphTasks);

  // Tokens already available
  const available = new Set([...state.availableOutputs]);
  for (const [taskName, taskState] of Object.entries(state.tasks)) {
    if (taskState.status === 'completed') {
      const tc = graphTasks[taskName];
      if (tc) getProvides(tc).forEach(t => available.add(t));
    }
  }

  // Collect all required tokens
  const allRequired = new Set<string>();
  for (const taskConfig of Object.values(graphTasks)) {
    for (const token of getRequires(taskConfig)) {
      allRequired.add(token);
    }
  }

  // Iterative fixed-point: mark tokens unreachable if all their viable producers
  // are themselves unreachable (need an unreachable token).
  const unreachable = new Set<string>();
  const unreachableNodes = new Set<string>();

  // Seed: tokens with NO producer at all (and not already available)
  for (const token of allRequired) {
    if (available.has(token)) continue;
    const producers = producerMap[token] || [];
    if (producers.length === 0) {
      unreachable.add(token);
    }
  }

  // Fixed-point: propagate transitively
  let changed = true;
  while (changed) {
    changed = false;

    // Mark nodes as unreachable if any of their requires is unreachable
    // and they haven't already completed
    for (const [name, taskConfig] of Object.entries(graphTasks)) {
      if (unreachableNodes.has(name)) continue;
      const ts = state.tasks[name];
      if (ts?.status === 'completed') continue; // already done, skip

      // Check if non-active (failed/disabled) — it's a dead producer
      const isNonActive = isNonActiveTask(ts);

      const requires = getRequires(taskConfig);
      const hasUnreachableDep = requires.some(t => unreachable.has(t));

      if (isNonActive || hasUnreachableDep) {
        if (!unreachableNodes.has(name)) {
          unreachableNodes.add(name);
          changed = true;
        }
      }
    }

    // Mark tokens as unreachable if ALL their producers are unreachable/non-active
    for (const token of allRequired) {
      if (unreachable.has(token) || available.has(token)) continue;
      const producers = producerMap[token] || [];
      const allProducersUnreachable = producers.length > 0 &&
        producers.every(p => unreachableNodes.has(p) || isNonActiveTask(state.tasks[p]));
      if (producers.length === 0 || allProducersUnreachable) {
        if (!unreachable.has(token)) {
          unreachable.add(token);
          changed = true;
        }
      }
    }
  }

  // Build reason map
  const tokens: UnreachableTokensResult['tokens'] = [];
  for (const token of unreachable) {
    const producers = producerMap[token] || [];
    let reason: 'no-producer' | 'all-producers-failed' | 'transitive';
    if (producers.length === 0) {
      reason = 'no-producer';
    } else {
      const allFailed = producers.every(p => isNonActiveTask(state.tasks[p]));
      reason = allFailed ? 'all-producers-failed' : 'transitive';
    }
    tokens.push({ token, reason, producers });
  }

  return { tokens };
}

/**
 * Get all nodes that can never become eligible given the current graph state.
 * A node is unreachable if any of its required tokens is unreachable.
 *
 * This is the node-level companion to getUnreachableTokens — uses the same
 * transitive analysis.
 *
 * Pure function.
 */
export function getUnreachableNodes(live: LiveGraph): UnreachableNodesResult {
  const { config, state } = live;
  const graphTasks = getAllTasks(config);
  const { tokens: unreachableTokens } = getUnreachableTokens(live);
  const unreachableTokenSet = new Set(unreachableTokens.map(t => t.token));

  const nodes: UnreachableNodesResult['nodes'] = [];

  for (const [name, taskConfig] of Object.entries(graphTasks)) {
    const ts = state.tasks[name];
    if (ts?.status === 'completed') continue; // already done

    const requires = getRequires(taskConfig);
    const missingTokens = requires.filter(t => unreachableTokenSet.has(t));

    if (missingTokens.length > 0) {
      nodes.push({ nodeName: name, missingTokens });
    } else if (isNonActiveTask(ts)) {
      // Node itself is failed/disabled — it's unreachable too
      nodes.push({ nodeName: name, missingTokens: [] });
    }
  }

  return { nodes };
}

// ============================================================================
// Graph traversal: upstream / downstream
// ============================================================================

/**
 * Get all nodes that transitively feed into the given node.
 * "What's upstream of X?" — traces backwards through requires → provides chains.
 *
 * Returns the set of upstream nodes and the tokens connecting them.
 * Does NOT include the target node itself.
 * Pure function.
 */
export function getUpstream(live: LiveGraph, nodeName: string): UpstreamResult {
  const graphTasks = getAllTasks(live.config);
  if (!graphTasks[nodeName]) return { nodeName, nodes: [], tokens: [] };

  const producerMap = buildProducerMap(graphTasks);
  const visited = new Set<string>();
  const tokenSet = new Set<string>();
  const nodeEntries: Map<string, Set<string>> = new Map();

  function walk(current: string): void {
    const taskConfig = graphTasks[current];
    if (!taskConfig) return;

    for (const token of getRequires(taskConfig)) {
      const producers = producerMap[token] || [];
      for (const producer of producers) {
        if (producer === nodeName) continue; // don't include target
        tokenSet.add(token);

        // Track which tokens this producer contributes
        if (!nodeEntries.has(producer)) nodeEntries.set(producer, new Set());
        nodeEntries.get(producer)!.add(token);

        if (!visited.has(producer)) {
          visited.add(producer);
          walk(producer);
        }
      }
    }
  }

  walk(nodeName);

  const nodes = [...nodeEntries.entries()].map(([name, tokens]) => ({
    nodeName: name,
    providesTokens: [...tokens],
  }));

  return { nodeName, nodes, tokens: [...tokenSet] };
}

/**
 * Get all nodes that transitively depend on the given node.
 * "What breaks if I disable X?" — traces forwards through provides → requires chains.
 *
 * Returns the set of downstream nodes and the tokens connecting them.
 * Does NOT include the target node itself.
 * Pure function.
 */
export function getDownstream(live: LiveGraph, nodeName: string): DownstreamResult {
  const graphTasks = getAllTasks(live.config);
  if (!graphTasks[nodeName]) return { nodeName, nodes: [], tokens: [] };

  // Build consumer map: token → nodes that require it
  const consumerMap: Record<string, string[]> = {};
  for (const [name, config] of Object.entries(graphTasks)) {
    for (const token of getRequires(config)) {
      if (!consumerMap[token]) consumerMap[token] = [];
      consumerMap[token].push(name);
    }
  }

  const visited = new Set<string>();
  const tokenSet = new Set<string>();
  const nodeEntries: Map<string, Set<string>> = new Map();

  function walk(current: string): void {
    const taskConfig = graphTasks[current];
    if (!taskConfig) return;

    for (const token of getProvides(taskConfig)) {
      const consumers = consumerMap[token] || [];
      for (const consumer of consumers) {
        if (consumer === nodeName) continue; // don't include target
        tokenSet.add(token);

        if (!nodeEntries.has(consumer)) nodeEntries.set(consumer, new Set());
        nodeEntries.get(consumer)!.add(token);

        if (!visited.has(consumer)) {
          visited.add(consumer);
          walk(consumer);
        }
      }
    }
  }

  walk(nodeName);

  const nodes = [...nodeEntries.entries()].map(([name, tokens]) => ({
    nodeName: name,
    requiresTokens: [...tokens],
  }));

  return { nodeName, nodes, tokens: [...tokenSet] };
}
