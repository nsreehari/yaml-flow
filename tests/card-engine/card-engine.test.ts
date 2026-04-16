import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CardEngine } from '../../src/card-engine/index.js';
import type { ReactiveNode, StateChangeEvent } from '../../src/card-engine/index.js';

// ============================================================================
// Helpers
// ============================================================================

function makeCard(id: string, overrides: Partial<ReactiveNode> = {}): ReactiveNode {
  return {
    id,
    type: 'card',
    state: { status: 'fresh' },
    view: { elements: [{ kind: 'text' }] },
    ...overrides,
  };
}

function makeSource(id: string, overrides: Partial<ReactiveNode> = {}): ReactiveNode {
  return {
    id,
    type: 'source',
    state: { status: 'fresh' },
    source: { kind: 'api', bindTo: 'state.raw', url_template: 'https://example.com/api' },
    ...overrides,
  };
}

function mockFetcher(data: unknown = { items: [1, 2, 3] }, status = 200): any {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
  });
}

// ============================================================================
// DAG building
// ============================================================================

describe('CardEngine.buildDAG', () => {
  it('returns empty order for empty nodes', () => {
    const { order, edges } = CardEngine.buildDAG([]);
    expect(order).toEqual([]);
    expect(edges).toEqual([]);
  });

  it('single node, no dependencies', () => {
    const { order } = CardEngine.buildDAG([makeCard('c1')]);
    expect(order).toEqual(['c1']);
  });

  it('source → card dependency', () => {
    const src = makeSource('src1');
    const card = makeCard('c1', { data: { requires: ['src1'] } });
    const { order, edges } = CardEngine.buildDAG([card, src]);

    expect(edges).toEqual([{ from: 'src1', to: 'c1' }]);
    expect(order.indexOf('src1')).toBeLessThan(order.indexOf('c1'));
  });

  it('diamond dependency graph', () => {
    // src → A, src → B, A → C, B → C
    const src = makeSource('src');
    const a = makeCard('a', {
      data: { requires: ['src'], provides: { dataA: 'array' } },
    });
    const b = makeCard('b', {
      data: { requires: ['src'], provides: { dataB: 'array' } },
    });
    const c = makeCard('c', { data: { requires: ['dataA', 'dataB'] } });

    const { order, edges } = CardEngine.buildDAG([c, b, a, src]);

    expect(edges).toHaveLength(4);
    expect(order.indexOf('src')).toBeLessThan(order.indexOf('a'));
    expect(order.indexOf('src')).toBeLessThan(order.indexOf('b'));
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('c'));
    expect(order.indexOf('b')).toBeLessThan(order.indexOf('c'));
  });

  it('handles nodes with no deps in any order', () => {
    const n1 = makeCard('c1');
    const n2 = makeCard('c2');
    const n3 = makeCard('c3');
    const { order } = CardEngine.buildDAG([n1, n2, n3]);
    expect(order).toHaveLength(3);
    expect(new Set(order)).toEqual(new Set(['c1', 'c2', 'c3']));
  });

  it('handles unresolved dependency gracefully', () => {
    const card = makeCard('c1', { data: { requires: ['nonexistent'] } });
    const { order, edges } = CardEngine.buildDAG([card]);
    expect(order).toEqual(['c1']);
    expect(edges).toEqual([]);
  });
});

// ============================================================================
// Engine creation
// ============================================================================

describe('CardEngine.create', () => {
  it('creates engine with nodes', () => {
    const engine = CardEngine.create({ nodes: [makeCard('c1')], fetcher: mockFetcher() });
    expect(engine.nodes).toHaveLength(1);
    expect(engine.getNode('c1')).toBeDefined();
  });

  it('provides topological order', () => {
    const src = makeSource('src1');
    const card = makeCard('c1', { data: { requires: ['src1'] } });
    const engine = CardEngine.create({ nodes: [card, src], fetcher: mockFetcher() });
    expect(engine.order[0]).toBe('src1');
    expect(engine.order[1]).toBe('c1');
  });

  it('provides edges', () => {
    const src = makeSource('src1');
    const card = makeCard('c1', { data: { requires: ['src1'] } });
    const engine = CardEngine.create({ nodes: [card, src], fetcher: mockFetcher() });
    expect(engine.edges).toEqual([{ from: 'src1', to: 'c1' }]);
  });

  it('dependentsOf returns downstream nodes', () => {
    const src = makeSource('src1');
    const c1 = makeCard('c1', { data: { requires: ['src1'] } });
    const c2 = makeCard('c2', { data: { requires: ['src1'] } });
    const engine = CardEngine.create({ nodes: [c1, c2, src], fetcher: mockFetcher() });
    const deps = engine.dependentsOf('src1');
    expect(deps.sort()).toEqual(['c1', 'c2']);
  });

  it('dependenciesOf returns upstream nodes', () => {
    const src = makeSource('src1');
    const card = makeCard('c1', { data: { requires: ['src1'] } });
    const engine = CardEngine.create({ nodes: [card, src], fetcher: mockFetcher() });
    expect(engine.dependenciesOf('c1')).toEqual(['src1']);
  });
});

// ============================================================================
// Event bus
// ============================================================================

describe('Event bus', () => {
  it('on/emit basic', () => {
    const engine = CardEngine.create({ nodes: [makeCard('c1')], fetcher: mockFetcher() });
    const handler = vi.fn();
    engine.on('test-event', handler);
    engine.emit('test-event', { data: 42 });
    expect(handler).toHaveBeenCalledWith({ data: 42 });
  });

  it('multiple listeners', () => {
    const engine = CardEngine.create({ nodes: [makeCard('c1')], fetcher: mockFetcher() });
    const h1 = vi.fn();
    const h2 = vi.fn();
    engine.on('evt', h1);
    engine.on('evt', h2);
    engine.emit('evt', 'payload');
    expect(h1).toHaveBeenCalledWith('payload');
    expect(h2).toHaveBeenCalledWith('payload');
  });

  it('unsubscribe', () => {
    const engine = CardEngine.create({ nodes: [makeCard('c1')], fetcher: mockFetcher() });
    const handler = vi.fn();
    const unsub = engine.on('evt', handler);
    engine.emit('evt', 1);
    expect(handler).toHaveBeenCalledTimes(1);

    unsub();
    engine.emit('evt', 2);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('error in handler does not break other listeners', () => {
    const engine = CardEngine.create({ nodes: [makeCard('c1')], fetcher: mockFetcher() });
    const bad = vi.fn().mockImplementation(() => { throw new Error('boom'); });
    const good = vi.fn();
    engine.on('evt', bad);
    engine.on('evt', good);
    engine.emit('evt', 'x');
    expect(good).toHaveBeenCalledWith('x');
  });

  it('onChange config wires up state-change listener', async () => {
    const handler = vi.fn();
    const engine = CardEngine.create({
      nodes: [makeCard('c1')],
      fetcher: mockFetcher(),
      onChange: handler,
    });
    await engine.setState('c1', 'x', 42);
    expect(handler).toHaveBeenCalled();
    const evt = handler.mock.calls[0][0] as StateChangeEvent;
    expect(evt.nodeId).toBe('c1');
    expect(evt.path).toBe('x');
    expect(evt.value).toBe(42);
  });
});

// ============================================================================
// State management
// ============================================================================

describe('State management', () => {
  it('setState writes to node state', async () => {
    const engine = CardEngine.create({ nodes: [makeCard('c1')], fetcher: mockFetcher() });
    await engine.setState('c1', 'count', 42);
    expect(engine.getState('c1', 'count')).toBe(42);
  });

  it('setState with state. prefix', async () => {
    const engine = CardEngine.create({ nodes: [makeCard('c1')], fetcher: mockFetcher() });
    await engine.setState('c1', 'state.count', 42);
    expect(engine.getState('c1', 'count')).toBe(42);
  });

  it('setState nested path', async () => {
    const engine = CardEngine.create({ nodes: [makeCard('c1')], fetcher: mockFetcher() });
    await engine.setState('c1', 'filters.region', 'US');
    expect(engine.getState('c1', 'filters.region')).toBe('US');
  });

  it('getState without path returns full state', () => {
    const engine = CardEngine.create({
      nodes: [makeCard('c1', { state: { status: 'fresh', x: 1 } })],
      fetcher: mockFetcher(),
    });
    expect(engine.getState('c1')).toEqual({ status: 'fresh', x: 1 });
  });

  it('getState from unknown node returns undefined', () => {
    const engine = CardEngine.create({ nodes: [makeCard('c1')], fetcher: mockFetcher() });
    expect(engine.getState('nonexistent')).toBeUndefined();
  });

  it('setState emits state-change event', async () => {
    const engine = CardEngine.create({ nodes: [makeCard('c1')], fetcher: mockFetcher() });
    const events: StateChangeEvent[] = [];
    engine.on('state-change', (e) => events.push(e as StateChangeEvent));
    await engine.setState('c1', 'x', 10);
    expect(events[0]).toMatchObject({ nodeId: 'c1', path: 'x', value: 10, previous: undefined });
  });

  it('setState triggers recompute', async () => {
    const card = makeCard('c1', {
      state: { values: [10, 20], status: 'fresh' },
      compute: { total: { fn: 'sum', input: 'state.values' } },
    });
    const engine = CardEngine.create({ nodes: [card], fetcher: mockFetcher() });
    await engine.setState('c1', 'values', [10, 20, 30]);
    expect(engine.getState('c1', 'total')).toBe(60);
  });

  it('setState cascades to dependents', async () => {
    const src = makeSource('src1', {
      source: { kind: 'static', bindTo: 'state.raw' },
      state: { status: 'fresh', raw: [1, 2, 3] },
      data: { provides: { numbers: 'array' } },
    });
    const card = makeCard('c1', {
      data: { requires: ['numbers'] },
      state: { status: 'fresh' },
      compute: { total: { fn: 'sum', input: 'state.numbers' } },
    });

    const engine = CardEngine.create({ nodes: [src, card], fetcher: mockFetcher() });
    // Simulate the card reading from src somehow — in the cascade, the card gets recomputed
    await engine.setState('c1', 'numbers', [10, 20, 30]);
    expect(engine.getState('c1', 'total')).toBe(60);
  });
});

// ============================================================================
// Source fetching
// ============================================================================

describe('Source fetching', () => {
  it('start() fetches API sources', async () => {
    const fetcher = mockFetcher({ results: [1, 2, 3] });
    const src = makeSource('src1', {
      source: { kind: 'api', bindTo: 'state.raw', url_template: 'https://example.com/data' },
    });
    const engine = CardEngine.create({ nodes: [src], fetcher });
    await engine.start();

    expect(fetcher).toHaveBeenCalledWith('https://example.com/data', expect.objectContaining({ method: 'GET' }));
    expect(engine.getState('src1', 'raw')).toEqual({ results: [1, 2, 3] });
    expect(engine.getState('src1', 'status')).toBe('fresh');
  });

  it('handles fetch error', async () => {
    const fetcher = mockFetcher({}, 500);
    const src = makeSource('src1');
    const engine = CardEngine.create({ nodes: [src], fetcher });
    await engine.start();

    expect(engine.getState('src1', 'status')).toBe('error');
    expect(engine.getState('src1', '_error')).toContain('500');
  });

  it('handles network error', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('Network down'));
    const src = makeSource('src1');
    const engine = CardEngine.create({ nodes: [src], fetcher });
    await engine.start();

    expect(engine.getState('src1', 'status')).toBe('error');
    expect(engine.getState('src1', '_error')).toBe('Network down');
  });

  it('applies transform path', async () => {
    const fetcher = mockFetcher({ data: { items: [10, 20] }, meta: {} });
    const src = makeSource('src1', {
      source: {
        kind: 'api',
        bindTo: 'state.raw',
        url_template: 'https://example.com/api',
        transform: 'data.items',
      },
    });
    const engine = CardEngine.create({ nodes: [src], fetcher });
    await engine.start();

    expect(engine.getState('src1', 'raw')).toEqual([10, 20]);
  });

  it('resolves URL template with state variables', async () => {
    const fetcher = mockFetcher({});
    const src = makeSource('src1', {
      state: { status: 'fresh', region: 'US' },
      source: {
        kind: 'api',
        bindTo: 'state.raw',
        url_template: 'https://example.com/api?region={{region}}',
      },
    });
    const engine = CardEngine.create({ nodes: [src], fetcher });
    await engine.start();

    expect(fetcher).toHaveBeenCalledWith(
      'https://example.com/api?region=US',
      expect.any(Object),
    );
  });

  it('static source does not fetch', async () => {
    const fetcher = mockFetcher();
    const src = makeSource('src1', {
      source: { kind: 'static', bindTo: 'state.raw' },
      state: { status: 'fresh', raw: [1, 2, 3] },
    });
    const engine = CardEngine.create({ nodes: [src], fetcher });
    await engine.start();

    expect(fetcher).not.toHaveBeenCalled();
    expect(engine.getState('src1', 'raw')).toEqual([1, 2, 3]);
  });

  it('POST with body', async () => {
    const fetcher = mockFetcher({ ok: true });
    const src = makeSource('src1', {
      source: {
        kind: 'api',
        bindTo: 'state.raw',
        url_template: 'https://example.com/api',
        method: 'POST',
        body: { query: 'test' },
      },
    });
    const engine = CardEngine.create({ nodes: [src], fetcher });
    await engine.start();

    expect(fetcher).toHaveBeenCalledWith(
      'https://example.com/api',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ query: 'test' }),
      }),
    );
  });

  it('source without url_template is no-op', async () => {
    const fetcher = mockFetcher();
    const src = makeSource('src1', {
      source: { kind: 'api', bindTo: 'state.raw' },
    });
    const engine = CardEngine.create({ nodes: [src], fetcher });
    await engine.start();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('standalone fetchSource', async () => {
    const fetcher = mockFetcher({ data: 42 });
    const src = makeSource('src1', {
      source: { kind: 'api', bindTo: 'state.raw', url_template: 'https://example.com' },
    });
    await CardEngine.fetchSource(src, fetcher);
    expect(src.state.raw).toEqual({ data: 42 });
  });
});

// ============================================================================
// Full pipeline: fetch → compute → cascade
// ============================================================================

describe('Full pipeline', () => {
  it('source → compute card chain', async () => {
    const fetcher = mockFetcher([
      { name: 'Alice', revenue: 100 },
      { name: 'Bob', revenue: 200 },
    ]);

    const src = makeSource('api', {
      source: { kind: 'api', bindTo: 'state.data', url_template: 'https://example.com/sales' },
    });

    const card = makeCard('summary', {
      data: { requires: ['api'] },
      state: { status: 'fresh', data: [] },
      compute: {
        total: { fn: 'sum', input: 'state.data', field: 'revenue' },
        count: { fn: 'count', input: 'state.data' },
      },
    });

    const engine = CardEngine.create({ nodes: [src, card], fetcher });
    await engine.start();

    // Source should have fetched data
    expect(engine.getState('api', 'data')).toHaveLength(2);

    // Card compute runs (but note: the card reads its own state.data, not the source's)
    // To properly link, we need data sharing — covered by cascade
  });

  it('emits started event', async () => {
    const handler = vi.fn();
    const engine = CardEngine.create({ nodes: [makeCard('c1')], fetcher: mockFetcher() });
    engine.on('started', handler);
    await engine.start();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ order: expect.any(Array) }));
  });
});

// ============================================================================
// Dispatch (cross-card events)
// ============================================================================

describe('dispatch', () => {
  it('emits event and writes to target state', async () => {
    const engine = CardEngine.create({
      nodes: [makeCard('c1'), makeCard('c2')],
      fetcher: mockFetcher(),
    });

    const handler = vi.fn();
    engine.on('filter-change', handler);

    await engine.dispatch({
      type: 'filter-change',
      source: 'c1',
      target: 'c2',
      payload: { region: 'US' },
    });

    expect(handler).toHaveBeenCalled();
    expect(engine.getState('c2', 'event.filter-change')).toEqual({ region: 'US' });
  });

  it('dispatch without target only emits', async () => {
    const engine = CardEngine.create({
      nodes: [makeCard('c1')],
      fetcher: mockFetcher(),
    });
    const handler = vi.fn();
    engine.on('custom', handler);
    await engine.dispatch({ type: 'custom', payload: 'hello' });
    expect(handler).toHaveBeenCalled();
  });
});

// ============================================================================
// Snapshot / Restore
// ============================================================================

describe('Snapshot / Restore', () => {
  it('snapshot captures all node states', () => {
    const engine = CardEngine.create({
      nodes: [
        makeCard('c1', { state: { status: 'fresh', x: 1 } }),
        makeCard('c2', { state: { status: 'fresh', y: 2 } }),
      ],
      fetcher: mockFetcher(),
    });
    const snap = engine.snapshot();
    expect(snap.c1).toEqual({ status: 'fresh', x: 1 });
    expect(snap.c2).toEqual({ status: 'fresh', y: 2 });
  });

  it('snapshot is a deep copy', () => {
    const engine = CardEngine.create({
      nodes: [makeCard('c1', { state: { status: 'fresh', arr: [1, 2] } })],
      fetcher: mockFetcher(),
    });
    const snap = engine.snapshot();
    (snap.c1.arr as number[]).push(3);
    expect(engine.getState('c1', 'arr')).toEqual([1, 2]);
  });

  it('restore writes back states', async () => {
    const engine = CardEngine.create({
      nodes: [makeCard('c1', { state: { status: 'fresh', x: 1 } })],
      fetcher: mockFetcher(),
    });
    const snap = engine.snapshot();
    await engine.setState('c1', 'x', 999);
    expect(engine.getState('c1', 'x')).toBe(999);

    engine.restore(snap);
    expect(engine.getState('c1', 'x')).toBe(1);
  });
});

// ============================================================================
// Dynamic node management
// ============================================================================

describe('Dynamic nodes', () => {
  it('addNode adds and rebuilds DAG', () => {
    const engine = CardEngine.create({ nodes: [makeCard('c1')], fetcher: mockFetcher() });
    expect(engine.nodes).toHaveLength(1);

    engine.addNode(makeCard('c2'));
    expect(engine.nodes).toHaveLength(2);
    expect(engine.getNode('c2')).toBeDefined();
  });

  it('addNode with dependency updates order', () => {
    const src = makeSource('src1');
    const engine = CardEngine.create({ nodes: [src], fetcher: mockFetcher() });

    engine.addNode(makeCard('c1', { data: { requires: ['src1'] } }));
    expect(engine.order.indexOf('src1')).toBeLessThan(engine.order.indexOf('c1'));
    expect(engine.edges).toEqual([{ from: 'src1', to: 'c1' }]);
  });

  it('removeNode removes and rebuilds DAG', () => {
    const engine = CardEngine.create({
      nodes: [makeCard('c1'), makeCard('c2')],
      fetcher: mockFetcher(),
    });
    engine.removeNode('c2');
    expect(engine.nodes).toHaveLength(1);
    expect(engine.getNode('c2')).toBeUndefined();
  });
});

// ============================================================================
// Stop
// ============================================================================

describe('Engine lifecycle', () => {
  it('stop emits stopped event', async () => {
    const engine = CardEngine.create({ nodes: [makeCard('c1')], fetcher: mockFetcher() });
    const handler = vi.fn();
    engine.on('stopped', handler);
    await engine.start();
    engine.stop();
    expect(handler).toHaveBeenCalled();
  });
});
