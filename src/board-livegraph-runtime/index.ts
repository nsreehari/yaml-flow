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

export interface BoardLiveGraphRuntimeOptions {
  sourceAdapters?: Record<string, BrowserSourceAdapter>;
  defaultSourceAdapter?: BrowserSourceAdapter;
  reactiveOptions?: Partial<Omit<ReactiveGraphOptions, 'handlers'>>;
  graphSettings?: Partial<GraphConfig['settings']>;
  executionId?: string;
}

export interface BoardLiveGraphRuntimeUpdate {
  events: GraphEvent[];
  graph: LiveGraph;
  nodes: LiveCard[];
}

export interface BoardLiveGraphRuntime {
  getGraph(): ReactiveGraph;
  getState(): LiveGraph;
  getNodes(): LiveCard[];
  getBoard(): LiveBoard;
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
      : [{ bindTo: cardId, src: `state.${cardId}` }];
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
        if (!upstream) continue;
        requiresData[token] = Object.prototype.hasOwnProperty.call(upstream, token)
          ? upstream[token]
          : upstream;
      }

      const sourcesData: Record<string, unknown> = {};
      if (card.sources && card.sources.length > 0) {
        const adapter = sourceAdapters[cardId] ?? defaultSourceAdapter;
        if (adapter) {
          const fetched = await adapter({ card, input: inputArgs });
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
      }

      const computeNode: ComputeNode = {
        id: card.id,
        state: deepClone(card.state ?? {}),
        requires: requiresData,
        sources: card.sources,
        compute: card.compute as ComputeNode['compute'] | undefined,
      };
      computeNode._sourcesData = sourcesData;

      if (computeNode.compute && computeNode.compute.length > 0) {
        await CardCompute.run(computeNode, { sourcesData });
      }

      let resultData: Record<string, unknown>;
      if (card.provides && card.provides.length > 0) {
        resultData = {};
        for (const { bindTo, src } of card.provides) {
          resultData[bindTo] = CardCompute.resolve(computeNode, src);
        }
      } else {
        resultData = {
          ...(computeNode.state ?? {}),
          ...(computeNode.computed_values ?? {}),
          ...(computeNode._sourcesData ?? {}),
        };
      }

      resultData.__cardState = computeNode.state ?? {};
      if (computeNode.computed_values) resultData.__computed_values = computeNode.computed_values;
      if (Object.keys(sourcesData).length > 0) resultData.__sourcesData = sourcesData;

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

  function getRenderableNodes(): LiveCard[] {
    const live = graph.getState();
    const out: LiveCard[] = [];

    for (const [cardId, baseCard] of cards.entries()) {
      const node = deepClone(baseCard);
      const data = live.state.tasks[cardId]?.data as Record<string, unknown> | undefined;

      const mergedState = {
        ...(node.state ?? {}),
        ...(data && typeof data.__cardState === 'object' ? data.__cardState as Record<string, unknown> : {}),
      };
      const runtimeState = live.state.tasks[cardId];
      mergedState.status = runtimeState?.status === 'running' ? 'loading' : (runtimeState?.status ?? mergedState.status ?? 'fresh');
      mergedState.lastRun = runtimeState?.lastUpdated ?? (mergedState.lastRun as string | undefined);
      if (runtimeState?.status === 'failed' && runtimeState.error) {
        mergedState.error = runtimeState.error;
      }

      node.state = mergedState;

      if (data && typeof data.__computed_values === 'object') {
        (node as LiveCard & { computed_values?: Record<string, unknown> }).computed_values =
          data.__computed_values as Record<string, unknown>;
      }

      if (data && typeof data.__sourcesData === 'object') {
        (node as LiveCard & { source_values?: Record<string, unknown> }).source_values =
          data.__sourcesData as Record<string, unknown>;
      }

      out.push(node);
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
      card.state = { ...(card.state ?? {}), ...patch };
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
