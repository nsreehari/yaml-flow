import type { GraphConfig, GraphEvent, TaskConfig } from '../event-graph/types.js';
import { CardCompute } from '../card-compute/index.js';
import type { ComputeNode } from '../card-compute/index.js';
import {
  createReactiveGraph,
  type ReactiveGraph,
  type ReactiveGraphOptions,
  type TaskHandlerFn,
  type TaskHandlerInput,
  type TaskHandlerReturn,
  type LiveGraph,
  schedule,
} from '../continuous-event-graph/index.js';
import type { LiveCard, LiveBoard } from '../continuous-event-graph/live-cards-bridge.js';

export interface BrowserSourceAdapterContext {
  card: LiveCard;
  input: TaskHandlerInput;
}

export type BrowserSourceAdapter =
  (ctx: BrowserSourceAdapterContext) => Promise<Record<string, unknown>> | Record<string, unknown>;

export interface BoardTaskExecutorContext {
  card: LiveCard;
  input: TaskHandlerInput;
}

/**
 * Opaque task executor hook.
 * Runtime does not interpret source descriptors — executor owns that contract.
 * For source cards, return a map keyed by source.bindTo.
 */
export type BoardTaskExecutor =
  (ctx: BoardTaskExecutorContext) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;

export interface BoardLiveGraphRuntimeOptions {
  /** Preferred opaque source/task executor. */
  taskExecutor?: BoardTaskExecutor;
  /** Per-card source adapters keyed by card ID. */
  sourceAdapters?: Record<string, BrowserSourceAdapter>;
  /** Default source adapter applied when no per-card adapter matches. */
  defaultSourceAdapter?: BrowserSourceAdapter;
  reactiveOptions?: Partial<Omit<ReactiveGraphOptions, 'handlers'>>;
  graphSettings?: Partial<GraphConfig['settings']>;
  executionId?: string;
}

export interface LiveCardRuntimeModel {
  id: string;
  card: LiveCard;
  card_data: Record<string, unknown>;
  fetched_sources: Record<string, unknown>;
  requires_data: Record<string, unknown>;
  computed_values: Record<string, unknown>;
  runtime_state: Record<string, unknown>;
}

export interface BoardRuntimeView {
  id?: string;
  title?: string;
  mode?: 'board' | 'canvas';
  positions?: Record<string, { x?: number; y?: number; w?: number; h?: number }>;
  settings?: Partial<GraphConfig['settings']>;
  nodes: LiveCardRuntimeModel[];
}

export interface BoardLiveGraphRuntimeUpdate {
  events: GraphEvent[];
  graph: LiveGraph;
  nodes: LiveCardRuntimeModel[];
}

export interface BoardLiveGraphRuntime {
  getGraph(): ReactiveGraph;
  getState(): LiveGraph;
  getNodes(): LiveCardRuntimeModel[];
  getBoard(): BoardRuntimeView;
  getSchedule(): ReturnType<typeof schedule>;
  subscribe(listener: (update: BoardLiveGraphRuntimeUpdate) => void): () => void;
  addCard(card: LiveCard): void;
  upsertCard(card: LiveCard): void;
  removeCard(cardId: string): void;
  patchCardState(cardId: string, patch: Record<string, unknown>): void;
  retrigger(cardId: string): void;
  retriggerAll(): void;
  push(event: GraphEvent): void;
  pushAll(events: GraphEvent[]): void;
  dispose(): void;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function toTaskConfig(card: LiveCard): TaskConfig {
  const provides = (card.provides && card.provides.length > 0)
    ? card.provides.map(p => p.bindTo)
    : [card.id];

  return {
    requires: card.requires && card.requires.length > 0 ? [...card.requires] : undefined,
    provides,
    taskHandlers: [card.id],
    description: card.meta?.title ?? card.id,
  };
}

function buildTokenProviders(cards: Map<string, LiveCard>): Map<string, string> {
  const tokenToCardId = new Map<string, string>();
  for (const [cardId, card] of cards.entries()) {
    const bindings = card.provides && card.provides.length > 0
      ? card.provides
      : [{ bindTo: cardId, src: 'card_data' }];
    for (const binding of bindings) tokenToCardId.set(binding.bindTo, cardId);
  }
  return tokenToCardId;
}

function validateRequires(cards: Map<string, LiveCard>, changedCardId: string): void {
  const tokenProviders = buildTokenProviders(cards);
  const card = cards.get(changedCardId);
  if (!card) return;

  for (const req of card.requires ?? []) {
    if (!tokenProviders.has(req)) {
      throw new Error(`Card "${changedCardId}" requires token "${req}" but no card provides it`);
    }
  }
}

/**
 * LocalStorageService — browser-side persistence layer for card artifacts
 * Mirrors CLI's file-based persistence (cards, computed artifacts, status)
 * 
 * Keys:
 * - 'yf:cards:<id>' → card definitions (mirrors tmp/cards/<id>.json)
 * - 'yf:runtime-out:cards:<id>' → computed artifacts (mirrors runtime-out/cards/<id>.computed.json)
 * - 'yf:runtime-out:status' → board status snapshot (mirrors runtime-out/board-livegraph-status.json)
 */
export const LocalStorageService = {
  // Keys
  CARD_PREFIX: 'yf:cards:',
  RUNTIME_OUT_PREFIX: 'yf:runtime-out:cards:',
  STATUS_KEY: 'yf:runtime-out:status',

  // Read/write cards (mirrors tmp/cards/<id>.json)
  writeCard(cardId: string, cardObject: Record<string, unknown>): void {
    try {
      localStorage.setItem(this.CARD_PREFIX + cardId, JSON.stringify(cardObject));
    } catch (e) {
      console.warn(`Failed to write card ${cardId} to localStorage:`, e);
    }
  },
  readCard(cardId: string): Record<string, unknown> | null {
    try {
      const raw = localStorage.getItem(this.CARD_PREFIX + cardId);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn(`Failed to read card ${cardId} from localStorage:`, e);
      return null;
    }
  },
  readAllCards(cardIds: string[]): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const id of cardIds) {
      const card = this.readCard(id);
      if (card) result[id] = card;
    }
    return result;
  },

  // Read/write computed artifacts (mirrors runtime-out/cards/<id>.computed.json)
  writeComputedArtifact(artifact: Record<string, unknown>): void {
    if (!artifact || !artifact.card_id) return;
    try {
      localStorage.setItem(
        this.RUNTIME_OUT_PREFIX + String(artifact.card_id),
        JSON.stringify(artifact)
      );
    } catch (e) {
      console.warn(`Failed to write computed artifact ${artifact.card_id}:`, e);
    }
  },
  readComputedArtifact(cardId: string): Record<string, unknown> | null {
    try {
      const raw = localStorage.getItem(this.RUNTIME_OUT_PREFIX + cardId);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn(`Failed to read computed artifact ${cardId}:`, e);
      return null;
    }
  },
  readAllComputedArtifacts(cardIds: string[]): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const id of cardIds) {
      const artifact = this.readComputedArtifact(id);
      if (artifact) result[id] = artifact;
    }
    return result;
  },

  // Read/write board status snapshot (mirrors runtime-out/board-livegraph-status.json)
  writeStatusSnapshot(snapshot: Record<string, unknown>): void {
    try {
      localStorage.setItem(this.STATUS_KEY, JSON.stringify(snapshot));
    } catch (e) {
      console.warn('Failed to write status snapshot to localStorage:', e);
    }
  },
  readStatusSnapshot(): Record<string, unknown> | null {
    try {
      const raw = localStorage.getItem(this.STATUS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.warn('Failed to read status snapshot from localStorage:', e);
      return null;
    }
  },

  // Clear all (useful for reset/demo)
  clear(): void {
    const keysToDelete: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith(this.CARD_PREFIX) || key.startsWith(this.RUNTIME_OUT_PREFIX) || key === this.STATUS_KEY)) {
        keysToDelete.push(key);
      }
    }
    for (const key of keysToDelete) {
      localStorage.removeItem(key);
    }
  }
};

export function createBoardLiveGraphRuntime(
  input: LiveCard[] | LiveBoard,
  options: BoardLiveGraphRuntimeOptions = {},
): BoardLiveGraphRuntime {
  const boardMeta: Pick<LiveBoard, 'id' | 'title' | 'mode' | 'positions' | 'settings'> = Array.isArray(input)
    ? {}
    : {
        id: input.id,
        title: input.title,
        mode: input.mode,
        positions: input.positions,
        settings: input.settings,
      };

  const initialCards = Array.isArray(input) ? input : input.nodes;
  const cards = new Map<string, LiveCard>();
  for (const card of initialCards) {
    if (cards.has(card.id)) throw new Error(`Duplicate card ID: "${card.id}"`);
    cards.set(card.id, deepClone(card));
  }

  const listeners = new Set<(update: BoardLiveGraphRuntimeUpdate) => void>();
  const taskExecutor = options.taskExecutor;
  const sourceAdapters = options.sourceAdapters ?? {};
  const defaultSourceAdapter = options.defaultSourceAdapter;

  let graphRef: ReactiveGraph | null = null;

  const notifyListeners = (events: GraphEvent[], graph: LiveGraph): void => {
    const update: BoardLiveGraphRuntimeUpdate = {
      events,
      graph,
      nodes: getRenderableNodes(),
    };
    for (const listener of listeners) listener(update);
  };

  const makeHandler = (cardId: string): TaskHandlerFn => {
    return async (inputArgs: TaskHandlerInput): Promise<TaskHandlerReturn> => {
      const card = cards.get(cardId);
      if (!card) return 'task-initiate-failure';

      const requiresData: Record<string, unknown> = {};
      for (const token of card.requires ?? []) {
        const upstream = inputArgs.state[token] as Record<string, unknown> | undefined;
        if (!upstream || typeof upstream !== 'object') continue;
        const providesData = upstream.provides_data as Record<string, unknown> | undefined;
        if (!providesData || typeof providesData !== 'object') continue;
        if (!Object.prototype.hasOwnProperty.call(providesData, token)) continue;
        requiresData[token] = providesData[token];
      }

      const sourcesData: Record<string, unknown> = {};
      if (card.sources && card.sources.length > 0) {
        const adapter = sourceAdapters[cardId] ?? defaultSourceAdapter;
        const fetched = taskExecutor
          ? await taskExecutor({ card, input: inputArgs })
          : (adapter ? await adapter({ card, input: inputArgs }) : undefined);
        if (fetched && typeof fetched === 'object') {
          for (const src of card.sources) {
            if (Object.prototype.hasOwnProperty.call(fetched, src.bindTo)) {
              sourcesData[src.bindTo] = fetched[src.bindTo];
            } else if (card.sources.length === 1) {
              sourcesData[src.bindTo] = fetched;
            }
          }
        }
      }

      const computeNode: ComputeNode = {
        id: card.id,
        card_data: deepClone(card.card_data ?? {}),
        requires: requiresData,
        sources: card.sources,
        compute: card.compute as ComputeNode['compute'] | undefined,
      };
      computeNode._sourcesData = sourcesData;

      if (computeNode.compute && computeNode.compute.length > 0) {
        await CardCompute.run(computeNode, { sourcesData });
      }

      const providesData: Record<string, unknown> = {};
      if (card.provides && card.provides.length > 0) {
        for (const { bindTo, src } of card.provides) {
          providesData[bindTo] = CardCompute.resolve(computeNode, src);
        }
      } else {
        providesData[card.id] = {
          ...(computeNode.card_data ?? {}),
          ...(computeNode.computed_values ?? {}),
          ...(computeNode._sourcesData ?? {}),
        };
      }

      const resultData: Record<string, unknown> = {
        provides_data: providesData,
        card_data: computeNode.card_data ?? {},
        computed_values: computeNode.computed_values ?? {},
        fetched_sources: sourcesData,
        requires_data: requiresData,
      };

      graphRef?.resolveCallback(inputArgs.callbackToken, resultData);
      return 'task-initiated';
    };
  };

  const tasks: Record<string, TaskConfig> = {};
  const handlers: Record<string, TaskHandlerFn> = {};
  for (const [cardId, card] of cards.entries()) {
    validateRequires(cards, cardId);
    tasks[cardId] = toTaskConfig(card);
    handlers[cardId] = makeHandler(cardId);
  }

  const config: GraphConfig = {
    id: boardMeta.id ?? `browser-board-${Date.now()}`,
    settings: {
      completion: 'manual',
      execution_mode: 'eligibility-mode',
      ...(boardMeta.settings ?? {}),
      ...(options.graphSettings ?? {}),
    },
    tasks,
  };

  const userOnDrain = options.reactiveOptions?.onDrain;
  const graph = createReactiveGraph(
    config,
    {
      ...(options.reactiveOptions ?? {}),
      handlers,
      onDrain: (events, live, scheduleResult) => {
        userOnDrain?.(events, live, scheduleResult);
        notifyListeners(events, live);
      },
    },
    options.executionId,
  );
  graphRef = graph;

  function getRenderableNodes(): LiveCardRuntimeModel[] {
    const live = graph.getState();
    const out: LiveCardRuntimeModel[] = [];

    for (const [cardId, baseCard] of cards.entries()) {
      const data = live.state.tasks[cardId]?.data as Record<string, unknown> | undefined;
      const runtimeState = live.state.tasks[cardId];

      const mergedCardData = {
        ...(baseCard.card_data ?? {}),
        ...(data && typeof data.card_data === 'object' ? data.card_data as Record<string, unknown> : {}),
      };

      const cardStatus = runtimeState?.status === 'running' ? 'loading' : runtimeState?.status;
      const cardDataForView = {
        ...mergedCardData,
        ...(cardStatus ? { status: cardStatus } : {}),
        ...(runtimeState?.lastUpdated ? { lastRun: runtimeState.lastUpdated } : {}),
        ...(runtimeState?.status === 'failed' && runtimeState.error ? { error: runtimeState.error } : {}),
      };

      out.push({
        id: cardId,
        card: deepClone(baseCard),
        card_data: cardDataForView,
        fetched_sources: data && typeof data.fetched_sources === 'object' ? deepClone(data.fetched_sources as Record<string, unknown>) : {},
        requires_data: data && typeof data.requires_data === 'object' ? deepClone(data.requires_data as Record<string, unknown>) : {},
        computed_values: data && typeof data.computed_values === 'object' ? deepClone(data.computed_values as Record<string, unknown>) : {},
        runtime_state: runtimeState ? deepClone(runtimeState as unknown as Record<string, unknown>) : {},
      });
    }

    return out;
  }

  const runtime: BoardLiveGraphRuntime = {
    getGraph: () => graph,
    getState: () => graph.getState(),
    getSchedule: () => graph.getSchedule(),
    getNodes: () => getRenderableNodes(),
    getBoard: () => ({
      ...boardMeta,
      nodes: getRenderableNodes(),
    }),
    subscribe(listener: (update: BoardLiveGraphRuntimeUpdate) => void): () => void {
      listeners.add(listener);
      listener({ events: [], graph: graph.getState(), nodes: getRenderableNodes() });
      return () => listeners.delete(listener);
    },
    addCard(card: LiveCard): void {
      if (cards.has(card.id)) throw new Error(`Card "${card.id}" already exists`);
      cards.set(card.id, deepClone(card));
      validateRequires(cards, card.id);
      graph.registerHandler(card.id, makeHandler(card.id));
      graph.addNode(card.id, toTaskConfig(card));
    },
    upsertCard(card: LiveCard): void {
      cards.set(card.id, deepClone(card));
      validateRequires(cards, card.id);
      graph.registerHandler(card.id, makeHandler(card.id));
      graph.addNode(card.id, toTaskConfig(card));
    },
    removeCard(cardId: string): void {
      cards.delete(cardId);
      graph.unregisterHandler(cardId);
      graph.removeNode(cardId);
    },
    patchCardState(cardId: string, patch: Record<string, unknown>): void {
      const card = cards.get(cardId);
      if (!card) throw new Error(`Card "${cardId}" not found`);
      card.card_data = { ...(card.card_data ?? {}), ...patch };
      graph.retrigger(cardId);
    },
    retrigger(cardId: string): void {
      graph.retrigger(cardId);
    },
    retriggerAll(): void {
      graph.retriggerAll(Array.from(cards.keys()));
    },
    push(event: GraphEvent): void {
      graph.push(event);
    },
    pushAll(events: GraphEvent[]): void {
      graph.pushAll(events);
    },
    dispose(): void {
      listeners.clear();
      graph.dispose();
    },
  };

  return runtime;
}
