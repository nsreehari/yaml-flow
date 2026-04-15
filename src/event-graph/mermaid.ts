/**
 * Mermaid Diagram Export
 *
 * Generate Mermaid diagram strings from GraphConfig (event-graph)
 * and StepFlowConfig (step-machine). Useful for documentation,
 * debugging, and CI reports.
 *
 * Pure functions — no I/O, no side effects.
 */

import type { GraphConfig } from './types.js';
import type { StepFlowConfig } from '../step-machine/types.js';
import { getRequires, getProvides, getAllTasks } from './graph-helpers.js';

// ============================================================================
// Event Graph → Mermaid
// ============================================================================

export interface MermaidOptions {
  /** Diagram direction: TB (top-bottom), LR (left-right), etc. Default: 'TD' */
  direction?: 'TD' | 'TB' | 'LR' | 'RL' | 'BT';
  /** Show token labels on edges. Default: true */
  showTokens?: boolean;
  /** Title comment at top. Default: graph.id or 'Event Graph' */
  title?: string;
}

/**
 * Sanitize a name for Mermaid node IDs (replace hyphens, special chars).
 */
function sanitizeId(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Generate a Mermaid dependency graph from an event-graph config.
 *
 * Tasks are nodes. Edges represent token dependencies:
 * if task B requires token X and task A provides X, then A --> B.
 *
 * @param graph - Event graph configuration
 * @param options - Diagram options
 * @returns Mermaid diagram string
 */
export function graphToMermaid(graph: GraphConfig, options: MermaidOptions = {}): string {
  const { direction = 'TD', showTokens = true, title } = options;
  const tasks = getAllTasks(graph);
  const taskNames = Object.keys(tasks);

  if (taskNames.length === 0) {
    return `graph ${direction}\n  empty[No tasks defined]`;
  }

  // Build producer map: token → tasks that provide it
  const producerMap: Record<string, string[]> = {};
  for (const [name, config] of Object.entries(tasks)) {
    for (const token of getProvides(config)) {
      if (!producerMap[token]) producerMap[token] = [];
      producerMap[token].push(name);
    }
    if (config.on) {
      for (const tokens of Object.values(config.on)) {
        for (const token of tokens) {
          if (!producerMap[token]) producerMap[token] = [];
          if (!producerMap[token].includes(name)) producerMap[token].push(name);
        }
      }
    }
  }

  const lines: string[] = [];
  const diagramTitle = title || graph.id || 'Event Graph';
  lines.push(`%% ${diagramTitle}`);
  lines.push(`graph ${direction}`);

  // Find leaf tasks: tasks whose tokens no other task requires
  const allRequired = new Set<string>();
  for (const config of Object.values(tasks)) {
    for (const token of getRequires(config)) {
      allRequired.add(token);
    }
  }
  const leafTaskSet = new Set(
    taskNames.filter((name) => {
      const prov = getProvides(tasks[name]);
      return prov.length === 0 || prov.every((token) => !allRequired.has(token));
    }),
  );

  // Declare nodes
  for (const name of taskNames) {
    const id = sanitizeId(name);
    const req = getRequires(tasks[name]);
    if (req.length === 0) {
      // Entry point — use rounded rectangle
      lines.push(`  ${id}([${name}])`);
    } else if (leafTaskSet.has(name)) {
      // Leaf node — use double bracketed
      lines.push(`  ${id}[[${name}]]`);
    } else {
      lines.push(`  ${id}[${name}]`);
    }
  }

  // Edges: for each task's requires, find producers and draw edges
  const edgeSet = new Set<string>();
  for (const [name, config] of Object.entries(tasks)) {
    const required = getRequires(config);
    for (const token of required) {
      const producers = producerMap[token] || [];
      for (const producer of producers) {
        if (producer === name) continue;
        const edgeKey = `${producer}->${name}:${token}`;
        if (edgeSet.has(edgeKey)) continue;
        edgeSet.add(edgeKey);

        const fromId = sanitizeId(producer);
        const toId = sanitizeId(name);
        if (showTokens) {
          lines.push(`  ${fromId} -->|${token}| ${toId}`);
        } else {
          lines.push(`  ${fromId} --> ${toId}`);
        }
      }
    }

    // Unreachable requires (no producer) — mark with dotted edge from a warning node
    for (const token of required) {
      if (!producerMap[token]) {
        const warnId = `warn_${sanitizeId(token)}`;
        const toId = sanitizeId(name);
        lines.push(`  ${warnId}{{⚠ ${token}}} -.->|missing| ${toId}`);
      }
    }
  }

  return lines.join('\n');
}

// ============================================================================
// Step Machine → Mermaid
// ============================================================================

/**
 * Generate a Mermaid flowchart from a step-machine config.
 *
 * Steps are nodes. Transitions are labeled edges.
 * Terminal states are shown as filled/rounded nodes.
 *
 * @param flow - Step machine flow configuration
 * @param options - Diagram options
 * @returns Mermaid diagram string
 */
export function flowToMermaid(flow: StepFlowConfig, options: MermaidOptions = {}): string {
  const { direction = 'TD', title } = options;
  const steps = flow.steps;
  const terminals = flow.terminal_states;
  const startStep = flow.settings.start_step;

  const lines: string[] = [];
  const diagramTitle = title || flow.id || 'Step Machine';
  lines.push(`%% ${diagramTitle}`);
  lines.push(`graph ${direction}`);

  // Start node
  lines.push(`  START(( ))`);
  lines.push(`  START --> ${sanitizeId(startStep)}`);

  // Step nodes
  for (const name of Object.keys(steps)) {
    const id = sanitizeId(name);
    lines.push(`  ${id}[${name}]`);
  }

  // Terminal nodes (stadium shape)
  for (const [name, config] of Object.entries(terminals)) {
    const id = sanitizeId(name);
    lines.push(`  ${id}([${name}: ${config.return_intent}])`);
  }

  // Transition edges
  for (const [stepName, stepConfig] of Object.entries(steps)) {
    const fromId = sanitizeId(stepName);
    for (const [result, target] of Object.entries(stepConfig.transitions)) {
      const toId = sanitizeId(target);
      lines.push(`  ${fromId} -->|${result}| ${toId}`);
    }
  }

  return lines.join('\n');
}
