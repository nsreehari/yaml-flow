/**
 * Continuous Event Graph — mutateGraph
 *
 * A higher-level batch mutation API.
 *
 * Unlike calling addNode/removeNode/injectTokens individually, mutateGraph
 * accepts a declarative array of mutations and applies them atomically.
 * This is useful for:
 *   - Applying a set of structural changes + events in a single call
 *   - Building mutation pipelines from external configs
 *   - Reducing boilerplate when scripting graph changes
 *
 * Pattern: mutateGraph(live, mutations[]) → LiveGraph
 * Pure function — no side effects.
 */

import type { TaskConfig, GraphEvent } from '../event-graph/types.js';
import type { LiveGraph } from './types.js';
import {
  addNode,
  removeNode,
  addRequires,
  removeRequires,
  addProvides,
  removeProvides,
  injectTokens,
  drainTokens,
  resetNode,
  disableNode,
  enableNode,
  applyEvents,
} from './core.js';

// ============================================================================
// Mutation types
// ============================================================================

export type GraphMutation =
  | AddNodeMutation
  | RemoveNodeMutation
  | AddRequiresMutation
  | RemoveRequiresMutation
  | AddProvidesMutation
  | RemoveProvidesMutation
  | InjectTokensMutation
  | DrainTokensMutation
  | ResetNodeMutation
  | DisableNodeMutation
  | EnableNodeMutation
  | ApplyEventsMutation;

export interface AddNodeMutation {
  type: 'add-node';
  name: string;
  config: TaskConfig;
}

export interface RemoveNodeMutation {
  type: 'remove-node';
  name: string;
}

export interface AddRequiresMutation {
  type: 'add-requires';
  taskName: string;
  tokens: string[];
}

export interface RemoveRequiresMutation {
  type: 'remove-requires';
  taskName: string;
  tokens: string[];
}

export interface AddProvidesMutation {
  type: 'add-provides';
  taskName: string;
  tokens: string[];
}

export interface RemoveProvidesMutation {
  type: 'remove-provides';
  taskName: string;
  tokens: string[];
}

export interface InjectTokensMutation {
  type: 'inject-tokens';
  tokens: string[];
}

export interface DrainTokensMutation {
  type: 'drain-tokens';
  tokens: string[];
}

export interface ResetNodeMutation {
  type: 'reset-node';
  name: string;
}

export interface DisableNodeMutation {
  type: 'disable-node';
  name: string;
}

export interface EnableNodeMutation {
  type: 'enable-node';
  name: string;
}

export interface ApplyEventsMutation {
  type: 'apply-events';
  events: GraphEvent[];
}

// ============================================================================
// mutateGraph — apply mutations atomically
// ============================================================================

/**
 * Apply an ordered array of mutations to a LiveGraph, returning the new state.
 *
 * Mutations are applied in order. Each mutation can depend on the result of
 * the previous one (e.g., add a node, then inject tokens it requires).
 *
 * Pure function — does not modify the input.
 *
 * @param live - The current LiveGraph
 * @param mutations - Ordered array of mutations to apply
 * @returns The new LiveGraph after all mutations
 * @throws Error if a mutation references a non-existent task (for safety)
 */
export function mutateGraph(live: LiveGraph, mutations: GraphMutation[]): LiveGraph {
  let current = live;

  for (const mutation of mutations) {
    current = applySingleMutation(current, mutation);
  }

  return current;
}

function applySingleMutation(live: LiveGraph, mutation: GraphMutation): LiveGraph {
  switch (mutation.type) {
    case 'add-node':
      return addNode(live, mutation.name, mutation.config);
    case 'remove-node':
      return removeNode(live, mutation.name);
    case 'add-requires':
      return addRequires(live, mutation.taskName, mutation.tokens);
    case 'remove-requires':
      return removeRequires(live, mutation.taskName, mutation.tokens);
    case 'add-provides':
      return addProvides(live, mutation.taskName, mutation.tokens);
    case 'remove-provides':
      return removeProvides(live, mutation.taskName, mutation.tokens);
    case 'inject-tokens':
      return injectTokens(live, mutation.tokens);
    case 'drain-tokens':
      return drainTokens(live, mutation.tokens);
    case 'reset-node':
      return resetNode(live, mutation.name);
    case 'disable-node':
      return disableNode(live, mutation.name);
    case 'enable-node':
      return enableNode(live, mutation.name);
    case 'apply-events':
      return applyEvents(live, mutation.events);
    default:
      throw new Error(`Unknown mutation type: ${(mutation as { type: string }).type}`);
  }
}
