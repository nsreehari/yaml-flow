import { describe, it, expect } from 'vitest';
import { CardCompute } from '../../src/card-compute/index.js';
import type { ComputeNode } from '../../src/card-compute/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function node(
  card_data: Record<string, unknown>,
  compute?: ComputeNode['compute'],
  requires?: Record<string, unknown>,
): ComputeNode {
  return { id: 'test', card_data, compute, requires };
}

// ===========================================================================
// CardCompute.run — state access
// ===========================================================================

describe('CardCompute.run — state access', () => {
  it('sums an array field from state', async () => {
    const n = node(
      { data: [{ v: 10 }, { v: 20 }, { v: 30 }] },
      [{ bindTo: 'total', expr: '$sum(card_data.data.v)' }],
    );
    await CardCompute.run(n);
    expect(n.computed_values!['total']).toBe(60);
  });

  it('averages an array field from state', async () => {
    const n = node(
      { data: [{ v: 10 }, { v: 20 }, { v: 30 }] },
      [{ bindTo: 'avg', expr: '$average(card_data.data.v)' }],
    );
    await CardCompute.run(n);
    expect(n.computed_values!['avg']).toBe(20);
  });

  it('counts items in state array', async () => {
    const n = node({ items: [1, 2, 3, 4] }, [{ bindTo: 'count', expr: '$count(card_data.items)' }]);
    await CardCompute.run(n);
    expect(n.computed_values!['count']).toBe(4);
  });

  it('rounds a nested average', async () => {
    const n = node(
      { sales: [{ revenue: 10 }, { revenue: 20 }, { revenue: 7 }] },
      [{ bindTo: 'avg', expr: '$round($average(card_data.sales.revenue), 0)' }],
    );
    await CardCompute.run(n);
    expect(n.computed_values!['avg']).toBe(12);
  });

  it('reads a scalar from card_data', async () => {
    const n = node({ price: 42 }, [{ bindTo: 'price', expr: 'card_data.price' }]);
    await CardCompute.run(n);
    expect(n.computed_values!['price']).toBe(42);
  });

  it('filters array via JSONata', async () => {
    const n = node(
      { items: [{ v: 5 }, { v: 15 }, { v: 25 }] },
      [{ bindTo: 'big', expr: '$count(card_data.items[v > 10])' }],
    );
    await CardCompute.run(n);
    expect(n.computed_values!['big']).toBe(2);
  });

  it('returns node unchanged when compute array is empty', async () => {
    const n = node({ x: 1 }, []);
    const result = await CardCompute.run(n);
    expect(result).toBe(n);
    expect(n.computed_values).toBeUndefined();
  });

  it('returns node unchanged when compute is absent', async () => {
    const n = node({ x: 1 });
    const result = await CardCompute.run(n);
    expect(result).toBe(n);
  });

  it('initialises missing card_data to {} before evaluating', async () => {
    const n: ComputeNode = { id: 'no-card_data', compute: [{ bindTo: 'x', expr: '1 + 1' }] };
    await CardCompute.run(n);
    expect(n.computed_values!['x']).toBe(2);
  });

  it('arithmetic expression', async () => {
    const n = node({ x: 3, y: 4 }, [{ bindTo: 'sum', expr: 'card_data.x + card_data.y' }]);
    await CardCompute.run(n);
    expect(n.computed_values!['sum']).toBe(7);
  });

  it('string concatenation via JSONata', async () => {
    const n = node({ name: 'World' }, [{ bindTo: 'msg', expr: '"Hello " & card_data.name' }]);
    await CardCompute.run(n);
    expect(n.computed_values!['msg']).toBe('Hello World');
  });

  it('min and max of array', async () => {
    const n = node(
      { vals: [3, 1, 4, 1, 5, 9] },
      [
        { bindTo: 'lo', expr: '$min(card_data.vals)' },
        { bindTo: 'hi', expr: '$max(card_data.vals)' },
      ],
    );
    await CardCompute.run(n);
    expect(n.computed_values!['lo']).toBe(1);
    expect(n.computed_values!['hi']).toBe(9);
  });
});

// ===========================================================================
// CardCompute.run — requires access
// ===========================================================================

describe('CardCompute.run — requires access', () => {
  it('sums flat array from requires', async () => {
    const n: ComputeNode = {
      id: 'req',
      card_data: {},
      requires: { prices: { raw: [10, 20, 30] } },
      compute: [{ bindTo: 'total', expr: '$sum(requires.prices.raw)' }],
    };
    await CardCompute.run(n);
    expect(n.computed_values!['total']).toBe(60);
  });

  it('counts items from requires', async () => {
    const n: ComputeNode = {
      id: 'req',
      card_data: {},
      requires: { quotes: [1, 2, 3, 4, 5] },
      compute: [{ bindTo: 'cnt', expr: '$count(requires.quotes)' }],
    };
    await CardCompute.run(n);
    expect(n.computed_values!['cnt']).toBe(5);
  });

  it('sums field from nested requires table rows', async () => {
    const n: ComputeNode = {
      id: 'table',
      card_data: {},
      requires: { table: { rows: [{ value: 100 }, { value: 200 }, { value: 50 }] } },
      compute: [{ bindTo: 'totalValue', expr: '$sum(requires.table.rows.value)' }],
    };
    await CardCompute.run(n);
    expect(n.computed_values!['totalValue']).toBe(350);
  });

  it('handles absent requires gracefully', async () => {
    const n: ComputeNode = {
      id: 'no-req',
      card_data: {},
      compute: [{ bindTo: 'x', expr: '$count(requires.missing)' }],
    };
    await CardCompute.run(n);
    // JSONata $count on a missing path returns 0
    expect(n.computed_values!['x']).toBe(0);
  });
});

// ===========================================================================
// CardCompute.run — multi-step chaining through computed_values
// ===========================================================================

describe('CardCompute.run — multi-step chaining', () => {
  it('later steps see earlier results via computed_values', async () => {
    const n = node(
      { data: [{ v: 10 }, { v: 20 }, { v: 30 }] },
      [
        { bindTo: 'total', expr: '$sum(card_data.data.v)' },
        { bindTo: 'label', expr: '"Total: " & $string(computed_values.total)' },
      ],
    );
    await CardCompute.run(n);
    expect(n.computed_values!['total']).toBe(60);
    expect(n.computed_values!['label']).toBe('Total: 60');
  });

  it('computed_values is reset on each run() call', async () => {
    const n = node({ data: [{ v: 10 }, { v: 20 }] }, [{ bindTo: 'total', expr: '$sum(card_data.data.v)' }]);
    await CardCompute.run(n);
    expect(n.computed_values!['total']).toBe(30);

    (n.card_data as any)['data'] = [{ v: 5 }];
    await CardCompute.run(n);
    expect(n.computed_values!['total']).toBe(5);
    expect(Object.keys(n.computed_values!).length).toBe(1);
  });

  it('three chained steps: sum → avg → label', async () => {
    const n: ComputeNode = {
      id: 'chain',
      card_data: { data: [{ v: 4 }, { v: 8 }] },
      requires: {},
      compute: [
        { bindTo: 'total', expr: '$sum(card_data.data.v)' },
        { bindTo: 'avg',   expr: '$average(card_data.data.v)' },
        { bindTo: 'label', expr: '"T=" & $string(computed_values.total) & " A=" & $string(computed_values.avg)' },
      ],
    };
    await CardCompute.run(n);
    expect(n.computed_values!['total']).toBe(12);
    expect(n.computed_values!['avg']).toBe(6);
    expect(n.computed_values!['label']).toBe('T=12 A=6');
  });
});

// ===========================================================================
// CardCompute.run — error handling
// ===========================================================================

describe('CardCompute.run — error handling', () => {
  it('does not throw on a bad expression; subsequent steps still run', async () => {
    const n = node(
      { x: 5 },
      [
        { bindTo: 'bad', expr: '$$INVALID_FN_THAT_DOES_NOT_EXIST()' },
        { bindTo: 'good', expr: 'card_data.x * 2' },
      ],
    );
    await expect(CardCompute.run(n)).resolves.toBeDefined();
    expect(n.computed_values!['good']).toBe(10);
  });
});

// ===========================================================================
// CardCompute.eval — single expression
// ===========================================================================

describe('CardCompute.eval', () => {
  it('evaluates arithmetic against state', async () => {
    const result = await CardCompute.eval('card_data.x + card_data.y', { id: 't', card_data: { x: 3, y: 4 } });
    expect(result).toBe(7);
  });

  it('evaluates $sum on state array', async () => {
    const result = await CardCompute.eval('$sum(card_data.values)', { id: 't', card_data: { values: [1, 2, 3, 4] } });
    expect(result).toBe(10);
  });

  it('evaluates against requires', async () => {
    const result = await CardCompute.eval(
      '$count(requires.items)',
      { id: 't', card_data: {}, requires: { items: ['a', 'b', 'c'] } },
    );
    expect(result).toBe(3);
  });

  it('evaluates against computed_values', async () => {
    const result = await CardCompute.eval(
      'computed_values.total * 2',
      { id: 't', card_data: {}, computed_values: { total: 5 } },
    );
    expect(result).toBe(10);
  });

  it('returns undefined for missing path without throwing', async () => {
    const result = await CardCompute.eval('card_data.missing.path', { id: 't', card_data: {} });
    expect(result).toBeUndefined();
  });
});

// ===========================================================================
// CardCompute.resolve — synchronous deep-get
// ===========================================================================

describe('CardCompute.resolve', () => {
  it('resolves a top-level key', () => {
    expect(CardCompute.resolve(node({ x: 42 }), 'card_data.x')).toBe(42);
  });

  it('resolves a nested path', () => {
    expect(CardCompute.resolve({ id: 't', card_data: { a: { b: { c: 99 } } } }, 'card_data.a.b.c')).toBe(99);
  });

  it('returns undefined for missing path', () => {
    expect(CardCompute.resolve(node({ x: 1 }), 'card_data.missing')).toBeUndefined();
  });

  it('resolves computed_values after run', async () => {
    const n = node({ v: [10, 20] }, [{ bindTo: 'total', expr: '$sum(card_data.v)' }]);
    await CardCompute.run(n);
    expect(CardCompute.resolve(n, 'computed_values.total')).toBe(30);
  });

  it('resolves id', () => {
    expect(CardCompute.resolve({ id: 'my-node' }, 'id')).toBe('my-node');
  });
});

// ===========================================================================
// CardCompute.validate
// ===========================================================================

describe('CardCompute.validate', () => {
  it('accepts a minimal valid node', () => {
    expect(CardCompute.validate({ id: 'x', card_data: {} }).ok).toBe(true);
  });

  it('accepts valid compute steps with expr', () => {
    const r = CardCompute.validate({
      id: 'x',
      card_data: {},
      compute: [
        { bindTo: 'total', expr: '$sum(card_data.data.v)' },
        { bindTo: 'avg',   expr: '$average(card_data.data.v)' },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a compute step missing expr', () => {
    const r = CardCompute.validate({ id: 'x', card_data: {}, compute: [{ bindTo: 'total' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('expr'))).toBe(true);
  });

  it('rejects a compute step missing bindTo', () => {
    const r = CardCompute.validate({ id: 'x', card_data: {}, compute: [{ expr: '$sum(card_data.x)' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('bindTo'))).toBe(true);
  });

  it('rejects a compute step that is a string, not an object', () => {
    const r = CardCompute.validate({ id: 'x', card_data: {}, compute: ['$sum(card_data.x)'] });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('compute[0]');
  });

  it('rejects missing id', () => {
    const r = CardCompute.validate({ card_data: {} });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('id'))).toBe(true);
  });

  it('rejects missing card_data', () => {
    const r = CardCompute.validate({ id: 'x' });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('card_data'))).toBe(true);
  });

  it('rejects null input', () => {
    expect(CardCompute.validate(null).ok).toBe(false);
  });

  it('rejects unknown top-level keys', () => {
    const r = CardCompute.validate({ id: 'x', card_data: {}, bogus: true });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('Unknown top-level key'))).toBe(true);
  });

  it('accepts all valid view element kinds', () => {
    const kinds = ['metric','table','chart','form','filter','list','notes','todo','alert','narrative','badge','text','markdown','custom'];
    for (const kind of kinds) {
      const r = CardCompute.validate({ id: `k-${kind}`, card_data: {}, view: { elements: [{ kind }] } });
      expect(r.ok, `kind "${kind}" should be valid`).toBe(true);
    }
  });

  it('rejects unknown element kind', () => {
    const r = CardCompute.validate({ id: 'x', card_data: {}, view: { elements: [{ kind: 'sparkline' }] } });
    expect(r.ok).toBe(false);
  });

  it('rejects empty view.elements', () => {
    const r = CardCompute.validate({ id: 'x', card_data: {}, view: { elements: [] } });
    expect(r.ok).toBe(false);
  });

  it('accepts arbitrary properties in card_data', () => {
    const r = CardCompute.validate({ id: 'x', card_data: { status: 'pending', custom: true } });
    expect(r.ok).toBe(true);
  });

  it('rejects meta.title as non-string', () => {
    const r = CardCompute.validate({ id: 'x', card_data: {}, meta: { title: 123 } });
    expect(r.ok).toBe(false);
  });

  it('rejects provides with missing src', () => {
    const r = CardCompute.validate({ id: 'x', card_data: {}, provides: [{ bindTo: 'x' }] });
    expect(r.ok).toBe(false);
  });

  it('rejects sources entry missing bindTo', () => {
    const r = CardCompute.validate({ id: 'x', card_data: {}, sources: [{ script: 'fetch.sh', outputFile: 'raw.json' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('sources[0]'))).toBe(true);
  });

  it('rejects sources with duplicate bindTo', () => {
    const r = CardCompute.validate({
      id: 'x',
      card_data: {},
      sources: [
        { bindTo: 'data', outputFile: 'data1.json', kind: 'api' },
        { bindTo: 'data', outputFile: 'data2.json', kind: 'api' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('unique') || e.includes('bindTo'))).toBe(true);
  });

  it('rejects sources with duplicate outputFile', () => {
    const r = CardCompute.validate({
      id: 'x',
      card_data: {},
      sources: [
        { bindTo: 'raw1', outputFile: 'data.json', kind: 'api' },
        { bindTo: 'raw2', outputFile: 'data.json', kind: 'api' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('unique') || e.includes('outputFile'))).toBe(true);
  });

  it('rejects sources entry missing outputFile', () => {
    const r = CardCompute.validate({ id: 'x', card_data: {}, sources: [{ bindTo: 'raw', kind: 'api' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('outputFile'))).toBe(true);
  });
});
