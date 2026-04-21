import { describe, it, expect } from 'vitest';
import { liveCardsToReactiveGraph } from '../../src/continuous-event-graph/live-cards-bridge.js';
import type { LiveCard, LiveBoard } from '../../src/continuous-event-graph/live-cards-bridge.js';
import type { TaskHandlerInput } from '../../src/continuous-event-graph/reactive.js';

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeSource(id: string, overrides: Partial<LiveCard> = {}): LiveCard {
  return {
    id,
    card_data: {},
    sources: [{ kind: 'static', bindTo: 'raw' }],
    ...overrides,
  };
}

function makeCard(id: string, overrides: Partial<LiveCard> = {}): LiveCard {
  return {
    id,
    card_data: {},
    view: { elements: [{ kind: 'text' }] },
    ...overrides,
  };
}

/** Create a minimal TaskHandlerInput for isolated handler testing */
function makeHandlerInput(nodeId: string): TaskHandlerInput {
  return {
    nodeId,
    card_data: {},
    taskState: { status: 'running' as any, executionCount: 0, retryCount: 0, lastEpoch: 0 },
    config: { provides: [nodeId] },
    callbackToken: `test-token-${nodeId}`,
  };
}

// ============================================================================
// liveCardsToReactiveGraph
// ============================================================================

describe('liveCardsToReactiveGraph', () => {
  describe('config generation', () => {
    it('creates tasks for each card', () => {
      const cards: LiveCard[] = [
        makeSource('prices'),
        makeCard('dashboard', { requires: ['prices'] }),
      ];
      const { config } = liveCardsToReactiveGraph(cards);

      expect(Object.keys(config.tasks)).toEqual(['prices', 'dashboard']);
      expect(config.tasks['prices'].provides).toEqual(['prices']);
      expect(config.tasks['dashboard'].requires).toEqual(['prices']);
      expect(config.tasks['dashboard'].provides).toEqual(['dashboard']);
    });

    it('sets default graph settings', () => {
      const { config } = liveCardsToReactiveGraph([makeSource('src')]);

      expect(config.settings.completion).toBe('manual');
      expect(config.settings.execution_mode).toBe('eligibility-mode');
    });

    it('allows graphSettings overrides', () => {
      const { config } = liveCardsToReactiveGraph([makeSource('src')], {
        graphSettings: { completion: 'all-tasks-done' },
      });

      expect(config.settings.completion).toBe('all-tasks-done');
    });

    it('uses meta.title as task description', () => {
      const cards: LiveCard[] = [
        makeSource('prices', { meta: { title: 'Live Prices Feed' } }),
      ];
      const { config } = liveCardsToReactiveGraph(cards);

      expect(config.tasks['prices'].description).toBe('Live Prices Feed');
    });

    it('entry-point cards have no requires', () => {
      const { config } = liveCardsToReactiveGraph([makeSource('src')]);

      expect(config.tasks['src'].requires).toBeUndefined();
    });
  });

  describe('error handling', () => {
    it('throws on duplicate card IDs', () => {
      const cards = [makeSource('dup'), makeSource('dup')];

      expect(() => liveCardsToReactiveGraph(cards)).toThrow('Duplicate card ID: "dup"');
    });

    it('throws when requires references non-existent card', () => {
      const cards = [
        makeCard('dashboard', { requires: ['ghost'] }),
      ];

      expect(() => liveCardsToReactiveGraph(cards)).toThrow(
        'Card "dashboard" requires "ghost" but no card provides that token',
      );
    });
  });

  describe('handler wiring', () => {
    it('creates handlers for all cards', () => {
      const cards = [makeSource('src'), makeCard('card1')];
      const { handlers } = liveCardsToReactiveGraph(cards);

      expect(typeof handlers['src']).toBe('function');
      expect(typeof handlers['card1']).toBe('function');
    });

    it('source default handler completes via reactive graph', async () => {
      const cards = [
        makeSource('prices', { card_data: { raw: [1, 2, 3] } }),
      ];
      const { graph } = liveCardsToReactiveGraph(cards, {
      });

      graph.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });
      await sleep(500);

      const state = graph.getState();
      expect(state.state.tasks['prices'].status).toBe('completed');
      expect(state.state.tasks['prices'].data).toEqual({ raw: [1, 2, 3] });
      graph.dispose();
    });

    it('uses custom sourceHandlers via reactive graph', async () => {
      const cards = [makeSource('prices')];
      const { graph } = liveCardsToReactiveGraph(cards, {
        sourceHandlers: {
          prices: async ({ callbackToken }) => {
            // This runs inside the reactive graph — resolveCallback is available
            return 'task-initiated';
          },
        },
      });

      // Push custom data externally since sourceHandler doesn't resolve on its own
      graph.push({
        type: 'task-completed',
        taskName: 'prices',
        data: { quotes: [100, 200] },
        timestamp: new Date().toISOString(),
      });
      await sleep(200);

      expect(graph.getState().state.tasks['prices'].status).toBe('completed');
      graph.dispose();
    });

    it('card handler runs CardCompute.run() via reactive graph', async () => {
      const cards: LiveCard[] = [
        makeCard('calc', {
          card_data: { data: [{ v: 10 }, { v: 20 }, { v: 30 }] },
          compute: [
            { bindTo: 'total', expr: '$sum(card_data.data.v)' },
            { bindTo: 'avg', expr: '$average(card_data.data.v)' },
          ],
          provides: [
            { bindTo: 'total', src: 'computed_values.total' },
            { bindTo: 'avg', src: 'computed_values.avg' },
          ],
        }),
      ];
      const { graph } = liveCardsToReactiveGraph(cards, {
      });

      graph.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });
      await sleep(500);

      const state = graph.getState();
      expect(state.state.tasks['calc'].status).toBe('completed');
      expect(state.state.tasks['calc'].data?.total).toBe(60);
      expect(state.state.tasks['calc'].data?.avg).toBe(20);
      graph.dispose();
    });

    it('card handler uses custom cardHandlers override via reactive graph', async () => {
      const cards = [makeCard('dash')];
      let graphRef: any;
      const { graph } = liveCardsToReactiveGraph(cards, {
        cardHandlers: {
          dash: async ({ callbackToken }) => {
            graphRef.resolveCallback(callbackToken, { custom: true });
            return 'task-initiated';
          },
        },
      });
      graphRef = graph;

      graph.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });
      await sleep(500);

      expect(graph.getState().state.tasks['dash'].status).toBe('completed');
      expect(graph.getState().state.tasks['dash'].data).toEqual({ custom: true });
      graph.dispose();
    });
  });

  describe('cross-card data flow', () => {
    it('upstream state is injected into downstream card via reactive graph', async () => {
      const cards: LiveCard[] = [
        makeSource('prices', { card_data: { raw: [10, 20, 30] } }),
        makeCard('stats', {
          requires: ['prices'],
          compute: [
            { bindTo: 'total', expr: '$sum(requires.prices.raw)' },
          ],
          provides: [
            { bindTo: 'total', src: 'computed_values.total' },
          ],
        }),
      ];
      const { graph } = liveCardsToReactiveGraph(cards, {
      });

      graph.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });
      await sleep(500);

      const state = graph.getState();
      expect(state.state.tasks['prices'].status).toBe('completed');
      expect(state.state.tasks['stats'].status).toBe('completed');
      expect(state.state.tasks['stats'].data?.total).toBe(60);
      graph.dispose();
    });

    it('provides mapping injects named values via reactive graph', async () => {
      const cards: LiveCard[] = [
        makeSource('prices', {
          card_data: { quotes: [100, 200] },
          provides: [{ bindTo: 'quotes', src: 'state.quotes' }],
        }),
        makeCard('dash', {
          requires: ['quotes'],
          compute: [
            { bindTo: 'total', expr: '$sum(requires.quotes)' },
          ],
          provides: [
            { bindTo: 'total', src: 'computed_values.total' },
          ],
        }),
      ];
      const { config, graph } = liveCardsToReactiveGraph(cards, {
      });

      expect(config.tasks['prices'].provides).toEqual(['quotes']);
      expect(config.tasks['dash'].requires).toEqual(['quotes']);

      graph.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });
      await sleep(500);

      const state = graph.getState();
      expect(state.state.tasks['prices'].status).toBe('completed');
      expect(state.state.tasks['dash'].status).toBe('completed');
      expect(state.state.tasks['dash'].data?.total).toBe(300);
      graph.dispose();
    });
  });

  describe('full reactive execution', () => {
    it('drives a simple source → card pipeline to completion', async () => {
      const cards: LiveCard[] = [
        makeSource('src', { card_data: { values: [5, 10, 15] } }),
        makeCard('agg', {
          requires: ['src'],
          compute: [
            { bindTo: 'total', expr: '$sum(requires.src.values)' },
            { bindTo: 'count', expr: '$count(requires.src.values)' },
          ],
        }),
      ];

      const { graph } = liveCardsToReactiveGraph(cards, {
      });

      // Push to trigger execution
      graph.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });

      await sleep(500);

      const state = graph.getState();
      expect(state.state.tasks['src'].status).toBe('completed');
      expect(state.state.tasks['agg'].status).toBe('completed');
      expect(state.state.availableOutputs).toContain('src');
      expect(state.state.availableOutputs).toContain('agg');

      graph.dispose();
    });

    it('drives a 3-level source → transform → dashboard pipeline', async () => {
      const cards: LiveCard[] = [
        makeSource('raw_data', {
          card_data: { items: [{ price: 100 }, { price: 200 }, { price: 300 }] },
        }),
        makeCard('transform', {
          requires: ['raw_data'],
          compute: [
            { bindTo: 'total', expr: '$sum(requires.raw_data.items.price)' },
            { bindTo: 'avg', expr: '$average(requires.raw_data.items.price)' },
          ],
        }),
        makeCard('dashboard', {
          requires: ['transform'],
          compute: [
            { bindTo: 'label', expr: '"Total: " & $string(requires.transform.total) & ", Avg: " & $string(requires.transform.avg)' },
          ],
        }),
      ];

      const { graph } = liveCardsToReactiveGraph(cards, {
      });

      graph.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });

      await sleep(800);

      const state = graph.getState();
      expect(state.state.tasks['raw_data'].status).toBe('completed');
      expect(state.state.tasks['transform'].status).toBe('completed');
      expect(state.state.tasks['dashboard'].status).toBe('completed');

      graph.dispose();
    });
  });

  describe('result shape', () => {
    it('returns graph, config, handlers, and cards map', () => {
      const cards = [makeSource('src')];
      const result = liveCardsToReactiveGraph(cards);

      expect(result.graph).toBeDefined();
      expect(typeof result.graph.push).toBe('function');
      expect(result.config).toBeDefined();
      expect(result.handlers).toBeDefined();
      expect(result.cards).toBeInstanceOf(Map);
      expect(result.cards.get('src')).toBe(cards[0]);

      result.graph.dispose();
    });
  });

  describe('LiveBoard overload', () => {
    it('accepts a LiveBoard and extracts nodes', () => {
      const board: LiveBoard = {
        nodes: [makeSource('prices'), makeCard('dash', { requires: ['prices'] })],
      };
      const { config, handlers } = liveCardsToReactiveGraph(board);

      expect(Object.keys(config.tasks)).toEqual(['prices', 'dash']);
      expect(typeof handlers['prices']).toBe('function');
      expect(typeof handlers['dash']).toBe('function');
    });

    it('uses board.id as graph config ID', () => {
      const board: LiveBoard = {
        id: 'my-board',
        nodes: [makeSource('s1')],
      };
      const { config } = liveCardsToReactiveGraph(board);

      expect(config.id).toBe('my-board');
    });

    it('falls back to generated ID when board.id is absent', () => {
      const board: LiveBoard = { nodes: [makeSource('s1')] };
      const { config } = liveCardsToReactiveGraph(board);

      expect(config.id).toMatch(/^live-cards-\d+$/);
    });

    it('merges board.settings into graph config', () => {
      const board: LiveBoard = {
        nodes: [makeSource('s1')],
        settings: { completion: 'all-tasks-done' },
      };
      const { config } = liveCardsToReactiveGraph(board);

      expect(config.settings.completion).toBe('all-tasks-done');
    });

    it('graphSettings override board.settings', () => {
      const board: LiveBoard = {
        nodes: [makeSource('s1')],
        settings: { completion: 'all-tasks-done' },
      };
      const { config } = liveCardsToReactiveGraph(board, {
        graphSettings: { completion: 'manual' },
      });

      expect(config.settings.completion).toBe('manual');
    });

    it('drives a Board through full reactive execution', async () => {
      const board: LiveBoard = {
        id: 'stock-board',
        title: 'Stock Dashboard',
        mode: 'board',
        nodes: [
          makeSource('feed', { card_data: { prices: [10, 20, 30] } }),
          makeCard('totals', {
            requires: ['feed'],
            compute: [
              { bindTo: 'total', expr: '$sum(requires.feed.prices)' },
            ],
          }),
        ],
      };

      const { graph } = liveCardsToReactiveGraph(board, {
      });

      graph.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });
      await sleep(500);

      const state = graph.getState();
      expect(state.state.tasks['feed'].status).toBe('completed');
      expect(state.state.tasks['totals'].status).toBe('completed');

      graph.dispose();
    });
  });
});
