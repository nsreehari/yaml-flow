import { describe, it, expect } from 'vitest';
import { createBoardLiveGraphRuntime } from '../../src/board-livegraph-runtime/index.js';
import type { LiveCard } from '../../src/continuous-event-graph/live-cards-bridge.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('createBoardLiveGraphRuntime', () => {
  it('runs source adapter + compute chain and returns updated board nodes', async () => {
    const cards: LiveCard[] = [
      {
        id: 'prices',
        card_data: {},
        sources: [{ kind: 'api', bindTo: 'raw', outputFile: 'raw.json' }],
        provides: [{ bindTo: 'prices', src: 'fetched_sources.raw' }],
      },
      {
        id: 'stats',
        card_data: {},
        requires: ['prices'],
        compute: [{ bindTo: 'sum', expr: '$sum(requires.prices)' }] as any,
        provides: [{ bindTo: 'sum', src: 'computed_values.sum' }],
      },
    ];

    const runtime = createBoardLiveGraphRuntime(cards, {
      sourceAdapters: {
        prices: () => ({ raw: [2, 3, 5] }),
      },
    });

    runtime.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });
    await sleep(250);

    const state = runtime.getState();
    expect(state.state.tasks.prices.status).toBe('completed');
    expect(state.state.tasks.stats.status).toBe('completed');
    expect((state.state.tasks.stats.data as any)?.computed_values?.sum).toBe(10);

    const stats = runtime.getNodes().find(n => n.id === 'stats');
    expect(stats?.computed_values?.sum).toBe(10);

    runtime.dispose();
  });

  it('supports dynamic add/upsert/remove card mutations', async () => {
    const runtime = createBoardLiveGraphRuntime([
      { id: 'seed', card_data: { value: 7 } },
    ]);

    runtime.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });
    await sleep(200);

    runtime.addCard({
      id: 'plus-one',
      card_data: {},
      requires: ['seed'],
      compute: [{ bindTo: 'value', expr: '$number(requires.seed.value) + 1' }] as any,
      provides: [{ bindTo: 'value', src: 'computed_values.value' }],
    });

    runtime.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });
    await sleep(200);
    expect((runtime.getState().state.tasks['plus-one']?.data as any)?.computed_values?.value).toBe(8);

    runtime.upsertCard({
      id: 'plus-one',
      card_data: {},
      requires: ['seed'],
      compute: [{ bindTo: 'value', expr: '$number(requires.seed.value) + 2' }] as any,
      provides: [{ bindTo: 'value', src: 'computed_values.value' }],
    });
    runtime.retrigger('plus-one');
    await sleep(200);
    expect((runtime.getState().state.tasks['plus-one']?.data as any)?.computed_values?.value).toBe(9);

    runtime.removeCard('plus-one');
    expect(runtime.getState().config.tasks['plus-one']).toBeUndefined();

    runtime.dispose();
  });

  it('patchCardState retriggers card and emits subscriber updates', async () => {
    const runtime = createBoardLiveGraphRuntime([
      {
        id: 'counter',
        card_data: { n: 1 },
        compute: [{ bindTo: 'value', expr: '$number(card_data.n)' }] as any,
        provides: [{ bindTo: 'value', src: 'computed_values.value' }],
      },
    ]);

    const seen: number[] = [];
    const unsubscribe = runtime.subscribe(update => {
      if (update.events.length > 0) {
        seen.push(update.events.length);
      }
    });

    runtime.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });
    await sleep(200);
    expect((runtime.getState().state.tasks.counter.data as any)?.computed_values?.value).toBe(1);

    runtime.patchCardState('counter', { n: 4 });
    await sleep(200);
    expect((runtime.getState().state.tasks.counter.data as any)?.computed_values?.value).toBe(4);
    expect(seen.length).toBeGreaterThan(0);

    unsubscribe();
    runtime.dispose();
  });

  it('keeps fetched_sources, computed_values, card_data, and requires in runtime nodes', async () => {
    const cards: LiveCard[] = [
      {
        id: 'orders-source',
        card_data: { note: 'seed' },
        sources: [{ bindTo: 'raw', outputFile: 'raw.json', kind: 'api' } as any],
        compute: [{ bindTo: 'orderCount', expr: '$count(fetched_sources.raw)' }] as any,
        provides: [{ bindTo: 'orders_count', src: 'computed_values.orderCount' }],
      },
      {
        id: 'orders-summary',
        card_data: { title: 'summary' },
        requires: ['orders_count'],
        compute: [{ bindTo: 'totalQty', expr: '$number(requires.orders_count) + 3' }] as any,
        provides: [{ bindTo: 'totalQty', src: 'computed_values.totalQty' }],
      },
    ];

    const runtime = createBoardLiveGraphRuntime(cards, {
      sourceAdapters: {
        'orders-source': () => ({
          raw: [
            { id: 'ORD-1', quantity: 2 },
            { id: 'ORD-2', quantity: 3 },
          ],
        }),
      },
    });

    runtime.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });
    await sleep(250);

    const sourceNode = runtime.getNodes().find((n) => n.id === 'orders-source');
    const summaryNode = runtime.getNodes().find((n) => n.id === 'orders-summary');

    expect(Array.isArray(sourceNode?.fetched_sources?.raw)).toBe(true);
    expect(sourceNode?.computed_values?.orderCount).toBe(2);
    expect(sourceNode?.card_data?.note).toBe('seed');

    expect(summaryNode?.requires?.orders_count).toBe(2);
    expect(summaryNode?.computed_values?.totalQty).toBe(5);
    expect(summaryNode?.card_data?.title).toBe('summary');

    runtime.dispose();
  });
});
