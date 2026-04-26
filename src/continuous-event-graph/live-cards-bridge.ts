/**
 * Live Cards → Reactive Graph
 *
 * Takes an array of live card JSONs (card / source nodes) and produces
 * a fully wired ReactiveGraph where:
 *
 *   - Each card becomes a task in the graph
 *   - card.requires → task.requires (upstream card IDs as tokens)
 *   - Each card produces a token equal to its own ID
 *   - Card-type nodes: handler runs CardCompute.run() on a clone of the card,
 *     returns the computed state as data (auto-hashed by the reactive layer)
 *   - Source-type nodes: handler uses the source definition to fetch data,
 *     or falls back to a user-provided handler / noop
 *
 * The reactive graph auto-computes dataHash on every handler result,
 * so `data-changed` refresh strategy works out of the box.
 *
 * @example
 * ```ts
 * import { liveCardsToReactiveGraph } from 'yaml-flow/continuous-event-graph';
 *
 * const cards = [
 *   { id: 'prices', source_defs: [{ kind: 'api', bindTo: 'raw' }], state: {} },
 *   { id: 'dashboard', requires: ['prices'], state: {}, compute: [{ bindTo: 'total', fn: 'sum', ... }], view: { ... } },
 * ];
 *
 * const rg = liveCardsToReactiveGraph(cards, {
 *   sourceHandlers: {
 *     prices: async () => ({ data: { raw: await fetchPrices() } }),
 *   },
 * });
 *
 * // One push → the whole board computes itself
 * rg.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });
 * ```
 */

import type { GraphConfig, TaskConfig } from '../event-graph/types.js';
import type { ReactiveGraph, ReactiveGraphOptions, TaskHandlerFn, TaskHandlerInput, TaskHandlerReturn } from './reactive.js';
import { createReactiveGraph } from './reactive.js';
import { CardCompute } from '../card-compute/index.js';
import type { ComputeNode } from '../card-compute/index.js';

// ============================================================================
// Types
// ============================================================================

/**
 * Minimal live card shape accepted by this utility.
 * Unified card — no type field. Behavior from sections present.
 */
/** A provides binding: maps a token name to a source path in the card's data namespace. */
export interface ProvidesBinding {
  bindTo: string;
  ref: string;
}

export interface LiveCard {
  id: string;
  requires?: string[];
  provides?: ProvidesBinding[];
  meta?: { title?: string; tags?: string[] };
  card_data?: Record<string, unknown>;
  compute?: { bindTo: string; fn: string; [key: string]: unknown }[];
  source_defs?: {
    cli?: string;
    bindTo: string;
    outputFile: string;
    kind?: 'api' | 'websocket' | 'static' | 'llm';
    [key: string]: unknown;
  }[];
  optionalSources?: {
    cli?: string;
    bindTo: string;
    outputFile: string;
    kind?: 'api' | 'websocket' | 'static' | 'llm';
    [key: string]: unknown;
  }[];
  /** Custom task completion rule: when true, invokes inference adapter instead of default source-delivery gating. */
  when_is_task_completed?: string;
  view?: Record<string, unknown>;
}

/**
 * A Board is a named container of live card nodes.
 * Matches the shape used by LiveCard.Board() in browser/live-cards.js:
 *   LiveCard.Board(engine, el, { nodes, positions?, mode, canvas, ... })
 *
 * The `nodes` array contains the card/source JSON objects.
 * Board-level metadata (id, title, settings) is carried through to the
 * generated GraphConfig.
 */
export interface LiveBoard {
  /** Board identifier */
  id?: string;
  /** Human-readable title */
  title?: string;
  /** The card/source nodes on this board */
  nodes: LiveCard[];
  /** Board display mode (informational — not used by the reactive graph) */
  mode?: 'board' | 'canvas';
  /** Canvas positions keyed by node ID (informational — not used) */
  positions?: Record<string, { x?: number; y?: number; w?: number; h?: number }>;
  /** Board-level settings forwarded to GraphConfig.settings */
  settings?: Partial<GraphConfig['settings']>;
}

export interface LiveCardsToReactiveOptions {
  /** Custom handlers for source nodes (keyed by card ID). */
  sourceHandlers?: Record<string, TaskHandlerFn>;
  /**
   * Default handler factory for source nodes without an explicit handler.
   * Called once per source card during graph construction.
   * If not provided, source nodes without explicit handlers get a noop handler
   * that returns the card's current state.
   */
  defaultSourceHandler?: (card: LiveCard) => TaskHandlerFn;
  /**
   * Custom handlers for card nodes (keyed by card ID).
   * Overrides the default CardCompute.run() behavior.
   */
  cardHandlers?: Record<string, TaskHandlerFn>;
  /**
   * If provided, upstream card state is injected into downstream cards
   * before running compute. The key is the upstream card ID and the value
   * is the upstream card's latest state.
   */
  sharedState?: Map<string, Record<string, unknown>>;
  /** Override reactive graph options (journal, callbacks, etc.) */
  reactiveOptions?: Partial<Omit<ReactiveGraphOptions, 'handlers'>>;
  /** Graph-level settings overrides */
  graphSettings?: Partial<GraphConfig['settings']>;
  /** Execution ID for the reactive graph */
  executionId?: string;
}

export interface LiveCardsToReactiveResult {
  /** The fully wired reactive graph — ready to push events into. */
  graph: ReactiveGraph;
  /** The generated GraphConfig (for inspection/serialization). */
  config: GraphConfig;
  /** The handler map (for use with validateReactiveGraph). */
  handlers: Record<string, TaskHandlerFn>;
  /** Card lookup by ID (original references). */
  cards: Map<string, LiveCard>;
  /**
   * Shared state map: cardId → latest computed state.
   * Updated automatically by built-in handlers after each task completes.
   * Custom cardHandlers/sourceHandlers can also read upstream data directly
   * from the engine: graph.getState().state.tasks[cardId].data
   */
  sharedState: Map<string, Record<string, unknown>>;
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * Convert live card JSONs or a Board into a fully wired ReactiveGraph.
 *
 * Overloads:
 *   liveCardsToReactiveGraph(cards[], options?)  — from a flat array of cards
 *   liveCardsToReactiveGraph(board, options?)    — from a LiveBoard object
 */
export function liveCardsToReactiveGraph(
  input: LiveCard[] | LiveBoard,
  options?: LiveCardsToReactiveOptions,
): LiveCardsToReactiveResult;
export function liveCardsToReactiveGraph(
  input: LiveCard[] | LiveBoard,
  options: LiveCardsToReactiveOptions = {},
): LiveCardsToReactiveResult {
  // Detect Board vs cards array
  let cards: LiveCard[];
  let boardSettings: Partial<GraphConfig['settings']> = {};
  let boardId: string | undefined;

  if (!Array.isArray(input) && 'nodes' in input) {
    // It's a LiveBoard
    const board = input as LiveBoard;
    cards = board.nodes;
    boardId = board.id;
    boardSettings = board.settings ?? {};
  } else {
    cards = input as LiveCard[];
  }

  const {
    sourceHandlers = {},
    defaultSourceHandler,
    cardHandlers = {},
    reactiveOptions = {},
    graphSettings = {},
    executionId,
  } = options;

  // Card lookup
  const cardMap = new Map<string, LiveCard>();
  for (const card of cards) {
    if (cardMap.has(card.id)) {
      throw new Error(`Duplicate card ID: "${card.id}"`);
    }
    cardMap.set(card.id, card);
  }

  // Shared state: stores latest computed state per card for cross-card data flow
  const sharedState = options.sharedState ?? new Map<string, Record<string, unknown>>();

  // Build GraphConfig
  const tasks: Record<string, TaskConfig> = {};

  // Collect all provided tokens for validation + build token→cardId map
  const allTokens = new Set<string>();
  const tokenToCardId = new Map<string, string>();
  for (const card of cards) {
    for (const binding of (card.provides ?? [{ bindTo: card.id, ref: 'card_data' }])) {
      allTokens.add(binding.bindTo);
      tokenToCardId.set(binding.bindTo, card.id);
    }
  }

  for (const card of cards) {
    const requires = card.requires ?? [];

    // Validate requires reference provided tokens
    for (const req of requires) {
      if (!allTokens.has(req)) {
        throw new Error(`Card "${card.id}" requires "${req}" but no card provides that token`);
      }
    }

    tasks[card.id] = {
      requires: requires.length > 0 ? requires : undefined,
      provides: (card.provides ?? [{ bindTo: card.id, ref: 'card_data' }]).map(p => p.bindTo),
      taskHandlers: [card.id],
      description: card.meta?.title ?? card.id,
    };
  }

  const config: GraphConfig = {
    id: boardId ?? `live-cards-${Date.now()}`,
    settings: {
      completion: 'manual',
      execution_mode: 'eligibility-mode',
      ...boardSettings,
      ...graphSettings,
    },
    tasks,
  };

  // Build handlers
  const handlers: Record<string, TaskHandlerFn> = {};

  // Create a lazy resolveCallback reference — graph doesn't exist yet
  let graphRef: ReactiveGraph | null = null;
  const getResolve = () => (token: string, data: Record<string, unknown>, errors?: string[]) => {
    graphRef!.resolveCallback(token, data, errors);
  };

  for (const card of cards) {
    if (card.source_defs && card.source_defs.length > 0) {
      handlers[card.id] = buildSourceHandler(card, sourceHandlers, defaultSourceHandler, sharedState, getResolve);
    } else {
      handlers[card.id] = buildCardHandler(card, cardHandlers, sharedState, cardMap, tokenToCardId, getResolve);
    }
  }

  // Create reactive graph
  const graph = createReactiveGraph(
    config,
    {
      ...reactiveOptions,
      handlers,
    },
    executionId,
  );
  graphRef = graph;

  return { graph, config, handlers, cards: cardMap, sharedState };
}

// ============================================================================
// Handler builders
// ============================================================================

function buildSourceHandler(
  card: LiveCard,
  sourceHandlers: Record<string, TaskHandlerFn>,
  defaultSourceHandler: ((card: LiveCard) => TaskHandlerFn) | undefined,
  sharedState: Map<string, Record<string, unknown>>,
  getResolve: () => (token: string, data: Record<string, unknown>, errors?: string[]) => void,
): TaskHandlerFn {
  // Explicit handler takes priority
  if (sourceHandlers[card.id]) {
    const userHandler = sourceHandlers[card.id];
    return async (input: TaskHandlerInput): Promise<TaskHandlerReturn> => {
      // Wrap: fire user handler logic in background, resolve with data
      // User handler is already a TaskHandlerFn — it calls resolveCallback itself
      return userHandler(input);
    };
  }

  // User-provided factory
  if (defaultSourceHandler) {
    const factoryHandler = defaultSourceHandler(card);
    return async (input: TaskHandlerInput): Promise<TaskHandlerReturn> => {
      return factoryHandler(input);
    };
  }

  // Default: return current card data (for static source_defs or pre-populated data)
  return async (input: TaskHandlerInput): Promise<TaskHandlerReturn> => {
    const data = { ...card.card_data };
    sharedState.set(card.id, data);
    getResolve()(input.callbackToken, data);
    return 'task-initiated';
  };
}

function buildCardHandler(
  card: LiveCard,
  cardHandlers: Record<string, TaskHandlerFn>,
  sharedState: Map<string, Record<string, unknown>>,
  _cardMap: Map<string, LiveCard>,
  tokenToCardId: Map<string, string>,
  getResolve: () => (token: string, data: Record<string, unknown>, errors?: string[]) => void,
): TaskHandlerFn {
  // Explicit handler override
  if (cardHandlers[card.id]) {
    const userHandler = cardHandlers[card.id];
    return async (input: TaskHandlerInput): Promise<TaskHandlerReturn> => {
      return userHandler(input);
    };
  }

  // Default: inject upstream data → run CardCompute → return computed values
  return async (input: TaskHandlerInput): Promise<TaskHandlerReturn> => {
    // Clone the card's data to avoid mutating the original
    const requiresData: Record<string, unknown> = {};
    const requires = card.requires ?? [];
    for (const token of requires) {
      // Resolve token to the card that provides it
      const producerId = tokenToCardId.get(token) ?? token;
      const upstreamState = sharedState.get(producerId);
      if (upstreamState) {
        requiresData[token] = upstreamState[token] ?? upstreamState;
      }
    }

    const computeNode: ComputeNode = {
      id: card.id,
      card_data: { ...card.card_data },
      requires: requiresData,
      compute: card.compute as ComputeNode['compute'],
    };

    // Run compute expressions → writes to ephemeral computed_values
    await CardCompute.run(computeNode);

    // Build result: if card has explicit provides bindings, resolve each src path.
    // Otherwise spread full card_data + computed_values as data.
    let resultData: Record<string, unknown>;
    if (card.provides && card.provides.length > 0) {
      resultData = {};
      for (const { bindTo, ref } of card.provides) {
        resultData[bindTo] = CardCompute.resolve(computeNode, ref);
      }
    } else {
      resultData = { ...computeNode.card_data, ...computeNode.computed_values };
    }

    // Also update sharedState for downstream cards that read via requiresData
    const resultState = { ...computeNode.card_data, ...computeNode.computed_values };
    sharedState.set(card.id, resultState);

    getResolve()(input.callbackToken, resultData);
    return 'task-initiated';
  };
}

// ============================================================================
// Internal helpers
// ============================================================================
