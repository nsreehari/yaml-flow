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
 *   { id: 'prices', type: 'source', source: { kind: 'api', bindTo: 'state.raw', url_template: '...' }, state: {} },
 *   { id: 'dashboard', type: 'card', data: { requires: ['prices'] }, state: {}, compute: { total: { fn: 'sum', ... } }, view: { ... } },
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
 * Matches the live-cards.schema.json structure.
 */
export interface LiveCard {
  id: string;
  type: 'card' | 'source';
  requires?: string[];
  provides?: string[];
  meta?: { title?: string; tags?: string[] };
  state?: Record<string, unknown>;
  compute?: Record<string, unknown>;
  source?: {
    kind: 'api' | 'websocket' | 'static' | 'llm';
    bindTo: string;
    url_template?: string;
    method?: string;
    headers?: Record<string, unknown>;
    body_template?: Record<string, unknown>;
    poll_interval?: number;
    transform?: string;
    [key: string]: unknown;
  };
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
    for (const token of (card.provides ?? [card.id])) {
      allTokens.add(token);
      tokenToCardId.set(token, card.id);
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
      provides: card.provides ?? [card.id],
      taskHandlers: [card.id], // each card has a named handler matching its ID
      description: card.meta?.title ?? `${card.type}: ${card.id}`,
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
    if (card.type === 'source') {
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

  // Default: return current card state (for static sources or pre-populated state)
  return async (input: TaskHandlerInput): Promise<TaskHandlerReturn> => {
    const state = { ...card.state };
    sharedState.set(card.id, state);
    getResolve()(input.callbackToken, state);
    return 'task-initiated';
  };
}

function buildCardHandler(
  card: LiveCard,
  cardHandlers: Record<string, TaskHandlerFn>,
  sharedState: Map<string, Record<string, unknown>>,
  cardMap: Map<string, LiveCard>,
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

  // Default: inject upstream state → run CardCompute → return computed state
  return async (input: TaskHandlerInput): Promise<TaskHandlerReturn> => {
    // Clone the card's state to avoid mutating the original
    const computeNode: ComputeNode = {
      id: card.id,
      state: { ...card.state },
      compute: card.compute as ComputeNode['compute'],
    };

    // Inject upstream data into the card's state
    const requires = card.requires ?? [];
    for (const token of requires) {
      // Resolve token to the card that provides it
      const producerId = tokenToCardId.get(token) ?? token;
      const upstreamState = sharedState.get(producerId);
      if (upstreamState) {
        // Inject under the token name so compute expressions can reference state.<token>
        computeNode.state![token] = upstreamState[token] ?? upstreamState;
      }
    }

    // Run compute expressions
    CardCompute.run(computeNode);

    // Store the computed state for downstream cards
    const resultState = { ...computeNode.state };
    sharedState.set(card.id, resultState);

    getResolve()(input.callbackToken, resultState);
    return 'task-initiated';
  };
}

// ============================================================================
// Internal helpers
// ============================================================================

function deepGet(obj: unknown, path: string): unknown {
  if (!path || !obj) return undefined;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
