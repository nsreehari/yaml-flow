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
        sources: [{ kind: 'api', bindTo: 'raw' }],
        provides: [{ bindTo: 'prices', src: 'sources.raw' }],
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
});
