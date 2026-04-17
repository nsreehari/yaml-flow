import { describe, it, expect, beforeEach } from 'vitest';
import { CardCompute } from '../../src/card-compute/index.js';
import type { ComputeNode, ComputeExpr, ComputeStep } from '../../src/card-compute/index.js';

// ============================================================================
// Helpers
// ============================================================================

function node(state: Record<string, unknown>, compute?: ComputeStep[]): ComputeNode {
  return { id: 'test', state, compute };
}

function evalExpr(expr: ComputeExpr, state: Record<string, unknown> = {}): unknown {
  return CardCompute.eval(expr, { id: 'test', state });
}

// ============================================================================
// Aggregates
// ============================================================================

describe('Aggregates', () => {
  const data = [{ v: 10 }, { v: 20 }, { v: 30 }];

  it('sum with field', () => {
    expect(evalExpr({ fn: 'sum', input: 'state.data', field: 'v' }, { data })).toBe(60);
  });

  it('sum without field (flat array)', () => {
    expect(evalExpr({ fn: 'sum', input: 'state.data' }, { data: [1, 2, 3] })).toBe(6);
  });

  it('sum on empty array', () => {
    expect(evalExpr({ fn: 'sum', input: 'state.data' }, { data: [] })).toBe(0);
  });

  it('sum on non-array returns 0', () => {
    expect(evalExpr({ fn: 'sum', input: 'state.x' }, { x: 'hello' })).toBe(0);
  });

  it('avg with field', () => {
    expect(evalExpr({ fn: 'avg', input: 'state.data', field: 'v' }, { data })).toBe(20);
  });

  it('avg without field', () => {
    expect(evalExpr({ fn: 'avg', input: 'state.data' }, { data: [10, 20] })).toBe(15);
  });

  it('avg on empty array returns 0', () => {
    expect(evalExpr({ fn: 'avg', input: 'state.data' }, { data: [] })).toBe(0);
  });

  it('min with field', () => {
    expect(evalExpr({ fn: 'min', input: 'state.data', field: 'v' }, { data })).toBe(10);
  });

  it('min without field', () => {
    expect(evalExpr({ fn: 'min', input: 'state.data' }, { data: [5, 1, 8] })).toBe(1);
  });

  it('min on empty returns 0', () => {
    expect(evalExpr({ fn: 'min', input: 'state.data' }, { data: [] })).toBe(0);
  });

  it('max with field', () => {
    expect(evalExpr({ fn: 'max', input: 'state.data', field: 'v' }, { data })).toBe(30);
  });

  it('max without field', () => {
    expect(evalExpr({ fn: 'max', input: 'state.data' }, { data: [5, 1, 8] })).toBe(8);
  });

  it('max on empty returns 0', () => {
    expect(evalExpr({ fn: 'max', input: 'state.data' }, { data: [] })).toBe(0);
  });

  it('count array', () => {
    expect(evalExpr({ fn: 'count', input: 'state.data' }, { data })).toBe(3);
  });

  it('count non-null scalar', () => {
    expect(evalExpr({ fn: 'count', input: 'state.x' }, { x: 42 })).toBe(1);
  });

  it('count null returns 0', () => {
    expect(evalExpr({ fn: 'count', input: 'state.x' }, {})).toBe(0);
  });

  it('first returns first element', () => {
    expect(evalExpr({ fn: 'first', input: 'state.data' }, { data: [10, 20, 30] })).toBe(10);
  });

  it('first on non-array returns value itself', () => {
    expect(evalExpr({ fn: 'first', input: 'state.x' }, { x: 'hello' })).toBe('hello');
  });

  it('last returns last element', () => {
    expect(evalExpr({ fn: 'last', input: 'state.data' }, { data: [10, 20, 30] })).toBe(30);
  });

  it('last on non-array returns value itself', () => {
    expect(evalExpr({ fn: 'last', input: 'state.x' }, { x: 42 })).toBe(42);
  });
});

// ============================================================================
// Math
// ============================================================================

describe('Math', () => {
  it('add sums array', () => {
    expect(evalExpr({ fn: 'add', input: [3, 4, 5] })).toBe(12);
  });

  it('add empty returns 0', () => {
    expect(evalExpr({ fn: 'add', input: [] })).toBe(0);
  });

  it('sub subtracts second from first', () => {
    expect(evalExpr({ fn: 'sub', input: [10, 3] })).toBe(7);
  });

  it('sub with < 2 elements returns 0', () => {
    expect(evalExpr({ fn: 'sub', input: [10] })).toBe(0);
  });

  it('mul multiplies array', () => {
    expect(evalExpr({ fn: 'mul', input: [2, 3, 4] })).toBe(24);
  });

  it('mul empty returns 1', () => {
    expect(evalExpr({ fn: 'mul', input: [] })).toBe(1);
  });

  it('div divides first by second', () => {
    expect(evalExpr({ fn: 'div', input: [10, 4] })).toBe(2.5);
  });

  it('div by zero returns 0', () => {
    expect(evalExpr({ fn: 'div', input: [10, 0] })).toBe(0);
  });

  it('div with < 2 elements returns 0', () => {
    expect(evalExpr({ fn: 'div', input: [10] })).toBe(0);
  });

  it('round default 0 decimals', () => {
    expect(evalExpr({ fn: 'round', input: 3.7 })).toBe(4);
  });

  it('round with decimals', () => {
    expect(evalExpr({ fn: 'round', input: 3.456, decimals: 2 })).toBe(3.46);
  });

  it('abs positive', () => {
    expect(evalExpr({ fn: 'abs', input: -42 })).toBe(42);
  });

  it('abs already positive', () => {
    expect(evalExpr({ fn: 'abs', input: 7 })).toBe(7);
  });

  it('mod', () => {
    expect(evalExpr({ fn: 'mod', input: [10, 3] })).toBe(1);
  });

  it('mod with < 2 elements', () => {
    expect(evalExpr({ fn: 'mod', input: [10] })).toBe(0);
  });
});

// ============================================================================
// Compare
// ============================================================================

describe('Compare', () => {
  it('gt true', () => expect(evalExpr({ fn: 'gt', input: [5, 3] })).toBe(true));
  it('gt false', () => expect(evalExpr({ fn: 'gt', input: [3, 5] })).toBe(false));
  it('gt equal', () => expect(evalExpr({ fn: 'gt', input: [3, 3] })).toBe(false));

  it('gte true (greater)', () => expect(evalExpr({ fn: 'gte', input: [5, 3] })).toBe(true));
  it('gte true (equal)', () => expect(evalExpr({ fn: 'gte', input: [3, 3] })).toBe(true));
  it('gte false', () => expect(evalExpr({ fn: 'gte', input: [2, 3] })).toBe(false));

  it('lt true', () => expect(evalExpr({ fn: 'lt', input: [3, 5] })).toBe(true));
  it('lt false', () => expect(evalExpr({ fn: 'lt', input: [5, 3] })).toBe(false));

  it('lte true (less)', () => expect(evalExpr({ fn: 'lte', input: [3, 5] })).toBe(true));
  it('lte true (equal)', () => expect(evalExpr({ fn: 'lte', input: [3, 3] })).toBe(true));
  it('lte false', () => expect(evalExpr({ fn: 'lte', input: [5, 3] })).toBe(false));

  it('eq true', () => expect(evalExpr({ fn: 'eq', input: ['a', 'a'] })).toBe(true));
  it('eq false', () => expect(evalExpr({ fn: 'eq', input: ['a', 'b'] })).toBe(false));
  it('eq numbers', () => expect(evalExpr({ fn: 'eq', input: [1, 1] })).toBe(true));

  it('neq true', () => expect(evalExpr({ fn: 'neq', input: ['a', 'b'] })).toBe(true));
  it('neq false', () => expect(evalExpr({ fn: 'neq', input: ['a', 'a'] })).toBe(false));

  it('compare with < 2 elements returns false', () => {
    expect(evalExpr({ fn: 'gt', input: [5] })).toBe(false);
    expect(evalExpr({ fn: 'eq', input: [] })).toBe(false);
  });
});

// ============================================================================
// Logic
// ============================================================================

describe('Logic', () => {
  it('and all true', () => expect(evalExpr({ fn: 'and', input: [true, 1, 'yes'] })).toBe(true));
  it('and has false', () => expect(evalExpr({ fn: 'and', input: [true, 0, true] })).toBe(false));
  it('and empty returns true', () => expect(evalExpr({ fn: 'and', input: [] })).toBe(true));

  it('or has true', () => expect(evalExpr({ fn: 'or', input: [false, 0, 1] })).toBe(true));
  it('or all false', () => expect(evalExpr({ fn: 'or', input: [false, 0, ''] })).toBe(false));
  it('or empty returns false', () => expect(evalExpr({ fn: 'or', input: [] })).toBe(false));

  it('not true', () => expect(evalExpr({ fn: 'not', input: true })).toBe(false));
  it('not false', () => expect(evalExpr({ fn: 'not', input: false })).toBe(true));
  it('not 0', () => expect(evalExpr({ fn: 'not', input: 0 })).toBe(true));

  it('if true branch', () => {
    expect(evalExpr({ fn: 'if', cond: { fn: 'gt', input: [10, 5] }, then: 'yes', else: 'no' })).toBe('yes');
  });

  it('if false branch', () => {
    expect(evalExpr({ fn: 'if', cond: { fn: 'lt', input: [10, 5] }, then: 'yes', else: 'no' })).toBe('no');
  });

  it('if with nested expression in then/else', () => {
    const expr: ComputeExpr = {
      fn: 'if',
      cond: { fn: 'gt', input: [3, 1] },
      then: { fn: 'add', input: [10, 20] } as unknown,
      else: 0 as unknown,
    };
    expect(evalExpr(expr)).toBe(30);
  });
});

// ============================================================================
// String
// ============================================================================

describe('String', () => {
  it('concat strings', () => {
    expect(evalExpr({ fn: 'concat', input: ['Hello', ' ', 'World'] })).toBe('Hello World');
  });

  it('concat handles null in array', () => {
    expect(evalExpr({ fn: 'concat', input: ['a', null as any, 'b'] })).toBe('ab');
  });

  it('concat non-array returns empty', () => {
    expect(evalExpr({ fn: 'concat', input: 'single' })).toBe('');
  });

  it('upper', () => {
    expect(evalExpr({ fn: 'upper', input: 'hello' })).toBe('HELLO');
  });

  it('upper on null', () => {
    expect(evalExpr({ fn: 'upper', input: '' })).toBe('');
  });

  it('lower', () => {
    expect(evalExpr({ fn: 'lower', input: 'HELLO' })).toBe('hello');
  });

  it('template with placeholders', () => {
    expect(evalExpr({ fn: 'template', input: { name: 'Alice', age: 30 }, format: '{{name}} is {{age}}' })).toBe('Alice is 30');
  });

  it('template with missing placeholder leaves it', () => {
    expect(evalExpr({ fn: 'template', input: { name: 'Bob' }, format: '{{name}} - {{role}}' })).toBe('Bob - {{role}}');
  });

  it('join default separator', () => {
    expect(evalExpr({ fn: 'join', input: ['a', 'b', 'c'] })).toBe('a, b, c');
  });

  it('join custom separator', () => {
    expect(evalExpr({ fn: 'join', input: ['a', 'b', 'c'], separator: ' | ' })).toBe('a | b | c');
  });

  it('split default comma', () => {
    expect(evalExpr({ fn: 'split', input: 'a,b, c' })).toEqual(['a', 'b', 'c']);
  });

  it('split custom separator', () => {
    expect(evalExpr({ fn: 'split', input: 'a|b|c', separator: '|' })).toEqual(['a', 'b', 'c']);
  });

  it('trim', () => {
    expect(evalExpr({ fn: 'trim', input: '  hello  ' })).toBe('hello');
  });
});

// ============================================================================
// Collection
// ============================================================================

describe('Collection', () => {
  const data = [
    { name: 'Alice', age: 30 },
    { name: 'Bob', age: 25 },
    { name: 'Charlie', age: 35 },
  ];

  it('pluck extracts field', () => {
    expect(evalExpr({ fn: 'pluck', input: 'state.data', field: 'name' }, { data })).toEqual(['Alice', 'Bob', 'Charlie']);
  });

  it('pluck on non-array returns empty', () => {
    expect(evalExpr({ fn: 'pluck', input: 'state.x', field: 'name' }, { x: 42 })).toEqual([]);
  });

  it('filter by field (truthy)', () => {
    const items = [{ x: 0 }, { x: 1 }, { x: 2 }, { x: '' }];
    expect(evalExpr({ fn: 'filter', input: 'state.data', field: 'x' }, { data: items })).toEqual([{ x: 1 }, { x: 2 }]);
  });

  it('filter with where expression', () => {
    const result = evalExpr(
      { fn: 'filter', input: 'state.data', where: { fn: 'gt', input: ['state.$.age', 28] } },
      { data },
    );
    expect(result).toEqual([
      { name: 'Alice', age: 30 },
      { name: 'Charlie', age: 35 },
    ]);
  });

  it('filter without field filters by truthiness', () => {
    expect(evalExpr({ fn: 'filter', input: 'state.data' }, { data: [0, 1, '', 'a', null] })).toEqual([1, 'a']);
  });

  it('map returns shallow copy', () => {
    const result = evalExpr({ fn: 'map', input: 'state.data' }, { data: [1, 2, 3] });
    expect(result).toEqual([1, 2, 3]);
  });

  it('map with apply expression', () => {
    const result = evalExpr(
      { fn: 'map', input: 'state.data', apply: { fn: 'mul', input: ['state.$', 2] } },
      { data: [1, 2, 3] },
    );
    expect(result).toEqual([2, 4, 6]);
  });

  it('sort by field ascending', () => {
    const result = evalExpr({ fn: 'sort', input: 'state.data', field: 'age', direction: 'asc' }, { data });
    expect((result as any[]).map(r => r.name)).toEqual(['Bob', 'Alice', 'Charlie']);
  });

  it('sort by field descending', () => {
    const result = evalExpr({ fn: 'sort', input: 'state.data', field: 'age', direction: 'desc' }, { data });
    expect((result as any[]).map(r => r.name)).toEqual(['Charlie', 'Alice', 'Bob']);
  });

  it('sort flat array', () => {
    expect(evalExpr({ fn: 'sort', input: 'state.data' }, { data: [3, 1, 2] })).toEqual([1, 2, 3]);
  });

  it('sort does not mutate original', () => {
    const original = [3, 1, 2];
    evalExpr({ fn: 'sort', input: 'state.data' }, { data: original });
    expect(original).toEqual([3, 1, 2]);
  });

  it('slice', () => {
    expect(evalExpr({ fn: 'slice', input: 'state.data', start: 1, end: 3 }, { data: [10, 20, 30, 40] })).toEqual([20, 30]);
  });

  it('slice start only', () => {
    expect(evalExpr({ fn: 'slice', input: 'state.data', start: 2 }, { data: [10, 20, 30, 40] })).toEqual([30, 40]);
  });

  it('flat nested arrays', () => {
    expect(evalExpr({ fn: 'flat', input: 'state.data' }, { data: [[1, 2], [3, 4]] })).toEqual([1, 2, 3, 4]);
  });

  it('flat with depth', () => {
    expect(evalExpr({ fn: 'flat', input: 'state.data', depth: 2 }, { data: [[[1]], [[2]]] })).toEqual([1, 2]);
  });

  it('flat on non-array wraps in array', () => {
    expect(evalExpr({ fn: 'flat', input: 'state.x' }, { x: 42 })).toEqual([42]);
  });

  it('unique primitives', () => {
    expect(evalExpr({ fn: 'unique', input: 'state.data' }, { data: [1, 2, 2, 3, 1] })).toEqual([1, 2, 3]);
  });

  it('unique objects by JSON', () => {
    const items = [{ a: 1 }, { a: 2 }, { a: 1 }];
    expect(evalExpr({ fn: 'unique', input: 'state.data' }, { data: items })).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('group by field', () => {
    const items = [{ team: 'A', v: 1 }, { team: 'B', v: 2 }, { team: 'A', v: 3 }];
    const result = evalExpr({ fn: 'group', input: 'state.data', field: 'team' }, { data: items }) as any;
    expect(result.A).toHaveLength(2);
    expect(result.B).toHaveLength(1);
  });

  it('flatten_keys', () => {
    const result = evalExpr({ fn: 'flatten_keys', input: 'state.obj' }, { obj: { x: [1, 2], y: 3 } }) as any[];
    expect(result).toEqual([{ key: 'x', value: 1 }, { key: 'x', value: 2 }, { key: 'y', value: 3 }]);
  });

  it('flatten_keys on non-object returns empty', () => {
    expect(evalExpr({ fn: 'flatten_keys', input: 'state.x' }, { x: 42 })).toEqual([]);
  });

  it('entries', () => {
    const result = evalExpr({ fn: 'entries', input: 'state.obj' }, { obj: { a: 1, b: 2 } }) as any[];
    expect(result).toEqual([{ key: 'a', value: 1 }, { key: 'b', value: 2 }]);
  });

  it('entries on non-object returns empty', () => {
    expect(evalExpr({ fn: 'entries', input: 'state.x' }, { x: [1, 2] })).toEqual([]);
  });

  it('from_entries', () => {
    const result = evalExpr({ fn: 'from_entries', input: 'state.data' }, { data: [{ key: 'a', value: 1 }, { key: 'b', value: 2 }] });
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('from_entries on non-array returns empty object', () => {
    expect(evalExpr({ fn: 'from_entries', input: 'state.x' }, { x: 42 })).toEqual({});
  });

  it('length of array', () => {
    expect(evalExpr({ fn: 'length', input: 'state.data' }, { data: [1, 2, 3] })).toBe(3);
  });

  it('length of string', () => {
    expect(evalExpr({ fn: 'length', input: 'hello' })).toBe(5);
  });

  it('length of object (key count)', () => {
    expect(evalExpr({ fn: 'length', input: 'state.obj' }, { obj: { a: 1, b: 2 } })).toBe(2);
  });

  it('length of null returns 0', () => {
    expect(evalExpr({ fn: 'length', input: 'state.x' }, {})).toBe(0);
  });
});

// ============================================================================
// Lookup
// ============================================================================

describe('Lookup', () => {
  it('get by field', () => {
    expect(evalExpr({ fn: 'get', input: 'state.obj', field: 'a.b' }, { obj: { a: { b: 42 } } })).toBe(42);
  });

  it('get by path', () => {
    expect(evalExpr({ fn: 'get', input: 'state.obj', path: 'x.y' }, { obj: { x: { y: 'ok' } } })).toBe('ok');
  });

  it('get missing returns undefined', () => {
    expect(evalExpr({ fn: 'get', input: 'state.obj', field: 'missing' }, { obj: {} })).toBeUndefined();
  });

  it('default returns value when input is present', () => {
    expect(evalExpr({ fn: 'default', input: 'state.x', value: 99 }, { x: 42 })).toBe(42);
  });

  it('default returns fallback when input is null', () => {
    expect(evalExpr({ fn: 'default', input: 'state.x', value: 99 }, {})).toBe(99);
  });

  it('coalesce returns first non-null', () => {
    expect(evalExpr({ fn: 'coalesce', input: [null as any, undefined as any, 'found', 'also'] })).toBe('found');
  });

  it('coalesce all null returns null', () => {
    expect(evalExpr({ fn: 'coalesce', input: [null as any, undefined as any] })).toBeNull();
  });
});

// ============================================================================
// Date
// ============================================================================

describe('Date', () => {
  it('now returns ISO string', () => {
    const result = evalExpr({ fn: 'now' }) as string;
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('diff_days', () => {
    const result = evalExpr({ fn: 'diff_days', input: ['2025-01-10', '2025-01-01'] });
    expect(result).toBe(9);
  });

  it('diff_days with < 2 elements returns 0', () => {
    expect(evalExpr({ fn: 'diff_days', input: ['2025-01-10'] })).toBe(0);
  });

  it('format_date iso', () => {
    const result = evalExpr({ fn: 'format_date', input: '2025-06-15T12:00:00Z', format: 'iso' }) as string;
    expect(result).toContain('2025-06-15');
  });

  it('format_date date', () => {
    const result = evalExpr({ fn: 'format_date', input: '2025-06-15', format: 'date' }) as string;
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });

  it('format_date time', () => {
    const result = evalExpr({ fn: 'format_date', input: '2025-06-15T14:30:00Z', format: 'time' }) as string;
    expect(typeof result).toBe('string');
  });

  it('parse_date valid', () => {
    const result = evalExpr({ fn: 'parse_date', input: '2025-06-15' }) as string;
    expect(result).toContain('2025-06-15');
  });

  it('parse_date invalid returns null', () => {
    expect(evalExpr({ fn: 'parse_date', input: 'not-a-date' })).toBeNull();
  });
});

// ============================================================================
// Type
// ============================================================================

describe('Type', () => {
  it('to_number from string', () => expect(evalExpr({ fn: 'to_number', input: '42' })).toBe(42));
  it('to_number from NaN', () => expect(evalExpr({ fn: 'to_number', input: 'abc' })).toBe(0));

  it('to_string from number', () => expect(evalExpr({ fn: 'to_string', input: 42 })).toBe('42'));
  it('to_string from null', () => expect(evalExpr({ fn: 'to_string', input: null })).toBe(''));

  it('to_bool truthy', () => expect(evalExpr({ fn: 'to_bool', input: 1 })).toBe(true));
  it('to_bool falsy', () => expect(evalExpr({ fn: 'to_bool', input: 0 })).toBe(false));

  it('type_of number', () => expect(evalExpr({ fn: 'type_of', input: 42 })).toBe('number'));
  it('type_of string', () => expect(evalExpr({ fn: 'type_of', input: 'hi' })).toBe('string'));
  it('type_of array', () => expect(evalExpr({ fn: 'type_of', input: [1, 2] })).toBe('array'));
  it('type_of object', () => expect(evalExpr({ fn: 'type_of', input: 'state.obj' }, { obj: {} })).toBe('object'));

  it('is_null true', () => expect(evalExpr({ fn: 'is_null', input: 'state.x' }, {})).toBe(true));
  it('is_null false', () => expect(evalExpr({ fn: 'is_null', input: 'state.x' }, { x: 0 })).toBe(false));

  it('is_empty null', () => expect(evalExpr({ fn: 'is_empty', input: 'state.x' }, {})).toBe(true));
  it('is_empty empty array', () => expect(evalExpr({ fn: 'is_empty', input: 'state.x' }, { x: [] })).toBe(true));
  it('is_empty empty string', () => expect(evalExpr({ fn: 'is_empty', input: '' })).toBe(true));
  it('is_empty empty object', () => expect(evalExpr({ fn: 'is_empty', input: 'state.x' }, { x: {} })).toBe(true));
  it('is_empty non-empty', () => expect(evalExpr({ fn: 'is_empty', input: 'state.x' }, { x: [1] })).toBe(false));
  it('is_empty number is false', () => expect(evalExpr({ fn: 'is_empty', input: 42 })).toBe(false));
});

// ============================================================================
// run — full compute cycle
// ============================================================================

describe('CardCompute.run', () => {
  it('runs all compute expressions and writes to computed_state', () => {
    const n = node(
      { data: [{ revenue: 100 }, { revenue: 200 }, { revenue: 300 }] },
      [
        { bindTo: 'total', fn: 'sum', input: 'state.data', field: 'revenue' },
        { bindTo: 'avg', fn: 'avg', input: 'state.data', field: 'revenue' },
        { bindTo: 'cnt', fn: 'count', input: 'state.data' },
      ],
    );
    CardCompute.run(n);
    expect(n.computed_state!.total).toBe(600);
    expect(n.computed_state!.avg).toBe(200);
    expect(n.computed_state!.cnt).toBe(3);
  });

  it('initialises state if missing', () => {
    const n: ComputeNode = { id: 'x', compute: [{ bindTo: 'val', fn: 'add', input: [1, 2] }] };
    CardCompute.run(n);
    expect(n.computed_state!.val).toBe(3);
  });

  it('returns node if no compute', () => {
    const n: ComputeNode = { id: 'x', state: { x: 1 } };
    expect(CardCompute.run(n)).toBe(n);
  });

  it('handles null node gracefully', () => {
    expect(CardCompute.run(null as any)).toBeNull();
  });

  it('chains compute expressions (sequential via computed_state)', () => {
    const n = node(
      { data: [10, 20, 30] },
      [
        { bindTo: 'total', fn: 'sum', input: 'state.data' },
        { bindTo: 'doubled', fn: 'mul', input: ['computed_state.total', 2] },
      ],
    );
    CardCompute.run(n);
    expect(n.computed_state!.total).toBe(60);
    expect(n.computed_state!.doubled).toBe(120);
  });

  it('writes to nested computed_state path', () => {
    const n = node({}, [
      { bindTo: 'summary.total', fn: 'add', input: [10, 20] },
    ]);
    CardCompute.run(n);
    expect((n.computed_state!.summary as any).total).toBe(30);
  });

  it('reads from requires namespace', () => {
    const n: ComputeNode = {
      id: 'test',
      state: {},
      requires: { upstream: { values: [10, 20, 30] } },
      compute: [{ bindTo: 'total', fn: 'sum', input: 'requires.upstream.values' }],
    };
    CardCompute.run(n);
    expect(n.computed_state!.total).toBe(60);
  });
});

// ============================================================================
// resolve
// ============================================================================

describe('CardCompute.resolve', () => {
  it('resolves top-level', () => {
    expect(CardCompute.resolve({ id: 'x', state: { val: 42 } }, 'state.val')).toBe(42);
  });

  it('resolves nested path', () => {
    expect(CardCompute.resolve({ id: 'x', state: { a: { b: { c: 'deep' } } } }, 'state.a.b.c')).toBe('deep');
  });

  it('returns undefined for missing path', () => {
    expect(CardCompute.resolve({ id: 'x', state: {} }, 'state.missing.path')).toBeUndefined();
  });

  it('resolves id', () => {
    expect(CardCompute.resolve({ id: 'test-node' }, 'id')).toBe('test-node');
  });
});

// ============================================================================
// Nested expression evaluation
// ============================================================================

describe('Nested expressions', () => {
  it('input as nested expression', () => {
    const result = evalExpr({
      fn: 'mul',
      input: [{ fn: 'add', input: [2, 3] }, 4],
    });
    expect(result).toBe(20); // (2+3)*4
  });

  it('deeply nested expressions', () => {
    const result = evalExpr({
      fn: 'add',
      input: [
        { fn: 'mul', input: [2, 3] },
        { fn: 'sub', input: [10, 4] },
      ],
    });
    expect(result).toBe(12); // 6 + 6
  });

  it('unknown function returns undefined with warning', () => {
    const result = evalExpr({ fn: 'nonexistent', input: 42 });
    expect(result).toBeUndefined();
  });

  it('null expr returns null', () => {
    expect(CardCompute.eval(null, { id: 'x' })).toBeNull();
  });

  it('non-object expr returns as-is', () => {
    expect(CardCompute.eval(42 as any, { id: 'x' })).toBe(42);
    expect(CardCompute.eval('hello' as any, { id: 'x' })).toBe('hello');
  });

  it('object without fn returns as-is', () => {
    expect(CardCompute.eval({ key: 'value' } as any, { id: 'x' })).toEqual({ key: 'value' });
  });
});

// ============================================================================
// registerFunction
// ============================================================================

describe('registerFunction', () => {
  it('adds a custom function', () => {
    CardCompute.registerFunction('double', (input) => Number(input) * 2);
    expect(evalExpr({ fn: 'double', input: 21 })).toBe(42);
  });

  it('custom function is accessible via run', () => {
    CardCompute.registerFunction('triple', (input) => Number(input) * 3);
    const n = node({ x: 10 }, [{ bindTo: 'y', fn: 'triple', input: 'state.x' }]);
    CardCompute.run(n);
    expect(n.computed_state!.y).toBe(30);
  });

  it('custom function appears in functions list', () => {
    CardCompute.registerFunction('my_fn', () => 0);
    expect(CardCompute.functions).toHaveProperty('my_fn');
  });

  it('custom function overrides with same name', () => {
    CardCompute.registerFunction('custom_test', () => 'v1');
    expect(evalExpr({ fn: 'custom_test' })).toBe('v1');
    CardCompute.registerFunction('custom_test', () => 'v2');
    expect(evalExpr({ fn: 'custom_test' })).toBe('v2');
  });
});

// ============================================================================
// functions list
// ============================================================================

describe('CardCompute.functions', () => {
  it('includes all 55 built-in functions', () => {
    const fns = CardCompute.functions;
    const expected = [
      'sum', 'avg', 'min', 'max', 'count', 'first', 'last',
      'add', 'sub', 'mul', 'div', 'round', 'abs', 'mod',
      'gt', 'gte', 'lt', 'lte', 'eq', 'neq',
      'and', 'or', 'not',
      'concat', 'upper', 'lower', 'template', 'join', 'split', 'trim',
      'pluck', 'filter', 'map', 'sort', 'slice', 'flat', 'unique', 'group',
      'flatten_keys', 'entries', 'from_entries', 'length',
      'get', 'default', 'coalesce',
      'now', 'diff_days', 'format_date', 'parse_date',
      'to_number', 'to_string', 'to_bool', 'type_of', 'is_null', 'is_empty',
    ];
    for (const name of expected) {
      expect(fns).toHaveProperty(name);
    }
  });
});

// ============================================================================
// validate
// ============================================================================

describe('CardCompute.validate', () => {
  describe('valid nodes', () => {
    it('valid card with view', () => {
      const result = CardCompute.validate({
        id: 'card1',
        state: { status: 'fresh' },
        view: { elements: [{ kind: 'metric', data: { bind: 'state.x' } }] },
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('valid card with sources', () => {
      const result = CardCompute.validate({
        id: 'src1',
        state: { status: 'fresh' },
        sources: [{ bindTo: 'raw', script: 'fetch.sh' }],
      });
      expect(result.ok).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('card with all optional fields', () => {
      const result = CardCompute.validate({
        id: 'full',
        meta: { title: 'Test', tags: ['a', 'b'] },
        requires: ['src1'],
        provides: ['total'],
        state: { status: 'fresh' },
        view: { elements: [{ kind: 'table' }], layout: { columns: 2 }, features: { search: true } },
        compute: [{ bindTo: 'total', fn: 'sum', input: 'state.data', field: 'v' }],
        sources: [{ bindTo: 'data', script: 'fetch.sh' }],
        optionalSources: [{ bindTo: 'news', script: 'news.sh' }],
      });
      expect(result.ok).toBe(true);
    });
  });

  describe('invalid nodes', () => {
    it('null input', () => {
      const r = CardCompute.validate(null);
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toContain('non-null object');
    });

    it('array input', () => {
      const r = CardCompute.validate([]);
      expect(r.ok).toBe(false);
    });

    it('missing id', () => {
      const r = CardCompute.validate({ state: {}, view: { elements: [{ kind: 'text' }] } });
      expect(r.ok).toBe(false);
      expect(r.errors).toContain('id: required, must be a non-empty string');
    });

    it('empty string id', () => {
      const r = CardCompute.validate({ id: '', state: {}, view: { elements: [{ kind: 'text' }] } });
      expect(r.ok).toBe(false);
      expect(r.errors[0]).toContain('id');
    });

    it('unknown top-level keys', () => {
      const r = CardCompute.validate({
        id: 'x', state: {}, view: { elements: [{ kind: 'text' }] },
        extra: true, another: 1,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('Unknown top-level key'))).toBe(true);
    });

    it('state missing', () => {
      const r = CardCompute.validate({ id: 'x', view: { elements: [{ kind: 'text' }] } });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('state: required'))).toBe(true);
    });

    it('state is array', () => {
      const r = CardCompute.validate({ id: 'x', state: [], view: { elements: [{ kind: 'text' }] } });
      expect(r.ok).toBe(false);
    });

    it('invalid status', () => {
      const r = CardCompute.validate({
        id: 'x', state: { status: 'unknown' },
        view: { elements: [{ kind: 'text' }] },
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('state.status'))).toBe(true);
    });

    it('meta.title not a string', () => {
      const r = CardCompute.validate({
        id: 'x', meta: { title: 123 }, state: {},
        view: { elements: [{ kind: 'text' }] },
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('meta.title'))).toBe(true);
    });

    it('meta.tags not an array', () => {
      const r = CardCompute.validate({
        id: 'x', meta: { tags: 'wrong' }, state: {},
        view: { elements: [{ kind: 'text' }] },
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('meta.tags'))).toBe(true);
    });

    it('requires not array', () => {
      const r = CardCompute.validate({
        id: 'x', requires: 'src1', state: {},
        view: { elements: [{ kind: 'text' }] },
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('requires'))).toBe(true);
    });

    it('provides not array', () => {
      const r = CardCompute.validate({
        id: 'x', provides: { x: 'state.x' }, state: {},
        view: { elements: [{ kind: 'text' }] },
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('provides'))).toBe(true);
    });

    it('compute step missing fn', () => {
      const r = CardCompute.validate({
        id: 'x', state: {},
        compute: [{ bindTo: 'total', input: 'state.data' }],
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('missing required "fn"'))).toBe(true);
    });

    it('compute step unknown function', () => {
      const r = CardCompute.validate({
        id: 'x', state: {},
        compute: [{ bindTo: 'total', fn: 'bogus_function' }],
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('unknown function "bogus_function"'))).toBe(true);
    });

    it('compute step missing bindTo', () => {
      const r = CardCompute.validate({
        id: 'x', state: {},
        compute: [{ fn: 'sum', input: 'state.data' }],
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('missing required "bindTo"'))).toBe(true);
    });

    it('compute not an array', () => {
      const r = CardCompute.validate({
        id: 'x', state: {},
        compute: { total: { fn: 'sum' } },
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('compute: must be an array'))).toBe(true);
    });

    it('sources entry missing bindTo', () => {
      const r = CardCompute.validate({
        id: 'x', state: {},
        sources: [{ script: 'fetch.sh' }],
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('sources[0]: missing required "bindTo"'))).toBe(true);
    });
  });

  describe('view validation', () => {
    it('view.elements empty', () => {
      const r = CardCompute.validate({
        id: 'x', state: {},
        view: { elements: [] },
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('non-empty array'))).toBe(true);
    });

    it('element missing kind', () => {
      const r = CardCompute.validate({
        id: 'x', state: {},
        view: { elements: [{ data: {} }] },
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('kind: required'))).toBe(true);
    });

    it('element unknown kind', () => {
      const r = CardCompute.validate({
        id: 'x', state: {},
        view: { elements: [{ kind: 'sparkline' }] },
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('unknown kind "sparkline"'))).toBe(true);
    });

    it('all 14 element kinds are valid', () => {
      const kinds = ['metric', 'table', 'chart', 'form', 'filter', 'list', 'notes', 'todo', 'alert', 'narrative', 'badge', 'text', 'markdown', 'custom'];
      for (const kind of kinds) {
        const r = CardCompute.validate({
          id: `k-${kind}`, state: {},
          view: { elements: [{ kind }] },
        });
        expect(r.ok).toBe(true);
      }
    });
  });

  describe('source validation', () => {
    it('sources entry missing bindTo', () => {
      const r = CardCompute.validate({
        id: 'x', state: {},
        sources: [{ script: 'fetch.sh' }],
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('sources[0]: missing required "bindTo"'))).toBe(true);
    });

    it('valid sources', () => {
      const r = CardCompute.validate({
        id: 'x', state: {},
        sources: [{ bindTo: 'raw', script: 'fetch.sh' }],
      });
      expect(r.ok).toBe(true);
    });

    it('valid optionalSources', () => {
      const r = CardCompute.validate({
        id: 'x', state: {},
        optionalSources: [{ bindTo: 'news', script: 'news.sh' }],
      });
      expect(r.ok).toBe(true);
    });
  });
});
