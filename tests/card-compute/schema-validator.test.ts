import { describe, it, expect } from 'vitest';
import {
  validateLiveCard,
  validateLiveCardSchema,
  validateLiveCardRuntimeExpressions,
  validateLiveCardDefinition,
} from '../../src/card-compute/schema-validator.js';

// ============================================================================
// validateLiveCardSchema — full JSON Schema validation via AJV
// ============================================================================

describe('validateLiveCardSchema', () => {

  // ---------- valid nodes ----------

  describe('valid nodes', () => {
    it('minimal valid card (just id)', () => {
      const r = validateLiveCardSchema({ id: 'card1' });
      expect(r.ok).toBe(true);
      expect(r.errors).toHaveLength(0);
    });

    it('card with view', () => {
      const r = validateLiveCardSchema({
        id: 'card1',
        card_data: { status: 'fresh' },
        view: { elements: [{ kind: 'metric' }] },
      });
      expect(r.ok).toBe(true);
    });

    it('card with source_defs', () => {
      const r = validateLiveCardSchema({
        id: 'src1',
        card_data: { status: 'fresh' },
        source_defs: [{ bindTo: 'raw', outputFile: 'raw.json', kind: 'api' }],
      });
      expect(r.ok).toBe(true);
    });

    it('card with all optional sections', () => {
      const r = validateLiveCardSchema({
        id: 'full-card',
        meta: { title: 'Dashboard', tags: ['finance'] },
        requires: ['src1'],
        provides: [{ bindTo: 'total', src: 'card_data.total' }],
        card_data: { status: 'fresh' },
        view: {
          elements: [
            { kind: 'metric', data: { bind: 'card_data.total' } },
            { kind: 'table', data: { bind: 'card_data.rows', columns: ['a', 'b'] } },
          ],
          layout: { board: { col: 6, order: 1 } },
          features: { chat: true, refresh: true },
        },
        compute: [
          { bindTo: 'total', expr: '$sum(card_data.data.revenue)' },
        ],
        source_defs: [{ bindTo: 'data', outputFile: 'data.json', kind: 'api' }, { bindTo: 'news', outputFile: 'news.json', optionalForCompletionGating: true }],
      });
      expect(r.ok).toBe(true);
    });

    it('source with full source_def fields', () => {
      const r = validateLiveCardSchema({
        id: 'src-full',
        card_data: {},
        source_defs: [{
          kind: 'api',
          bindTo: 'quotes',
          outputFile: 'quotes.json',
          method: 'POST',
          url_template: 'https://api.example.com/{{symbol}}',
          headers: { Authorization: 'Bearer abc' },
          body_template: { query: '{{q}}' },
          template_vars: { symbol: 'MSFT' },
          poll_interval: 30,
          transform: 'data.items',
        }],
      });
      expect(r.ok).toBe(true);
    });

    it('all element kinds accepted', () => {
      const kinds = [
        'metric', 'table', 'chart', 'form', 'filter', 'list',
        'notes', 'todo', 'alert', 'narrative', 'badge', 'text',
        'markdown', 'custom', 'actions',
      ];
      for (const kind of kinds) {
        const r = validateLiveCardSchema({
          id: `k-${kind}`, card_data: {},
          view: { elements: [{ kind }] },
        });
        expect(r.ok, `kind "${kind}" should be valid`).toBe(true);
      }
    });

    it('all source kinds accepted in source_defs array', () => {
      for (const kind of ['api', 'websocket', 'static', 'llm']) {
        const r = validateLiveCardSchema({
          id: `s-${kind}`, card_data: {},
          source_defs: [{ kind, bindTo: 'x', outputFile: 'output.json' }],
        });
        expect(r.ok, `source kind "${kind}" should be valid`).toBe(true);
      }
    });

    it('all status values accepted', () => {
      for (const status of ['fresh', 'stale', 'loading', 'error']) {
        const r = validateLiveCardSchema({
          id: 'x', card_data: { status },
        });
        expect(r.ok, `status "${status}" should be valid`).toBe(true);
      }
    });
  });

  // ---------- invalid nodes ----------

  describe('invalid nodes', () => {
    it('null input', () => {
      const r = validateLiveCardSchema(null);
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
    });

    it('array input', () => {
      const r = validateLiveCardSchema([]);
      expect(r.ok).toBe(false);
    });

    it('missing id', () => {
      const r = validateLiveCardSchema({ card_data: {} });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('id'))).toBe(true);
    });

    it('card with unknown top-level key', () => {
      const r = validateLiveCardSchema({
        id: 'x', card_data: {},
        extra: true,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('additional'))).toBe(true);
    });

    it('view.elements empty', () => {
      const r = validateLiveCardSchema({
        id: 'x', card_data: {},
        view: { elements: [] },
      });
      expect(r.ok).toBe(false);
    });

    it('invalid element kind', () => {
      const r = validateLiveCardSchema({
        id: 'x', card_data: {},
        view: { elements: [{ kind: 'sparkline' }] },
      });
      expect(r.ok).toBe(false);
    });

    it('allows arbitrary card_data.status values at schema level', () => {
      const r = validateLiveCardSchema({
        id: 'x', card_data: { status: 'bogus' },
      });
      expect(r.ok).toBe(true);
    });

    it('compute step missing expr', () => {
      const r = validateLiveCardSchema({
        id: 'x', card_data: {},
        compute: [{ bindTo: 'total' }],
      });
      expect(r.ok).toBe(false);
    });

    it('compute step missing bindTo', () => {
      const r = validateLiveCardSchema({
        id: 'x', card_data: {},
        compute: [{ expr: '$sum(card_data.data)' }],
      });
      expect(r.ok).toBe(false);
    });

    it('compute as object instead of array', () => {
      const r = validateLiveCardSchema({
        id: 'x', card_data: {},
        compute: { total: { fn: 'sum' } },
      });
      expect(r.ok).toBe(false);
    });

    it('source_defs entry missing bindTo', () => {
      const r = validateLiveCardSchema({
        id: 'x', card_data: {},
        source_defs: [{ kind: 'api', outputFile: 'data.json' }],
      });
      expect(r.ok).toBe(false);
    });

    it('source_defs entry missing outputFile', () => {
      const r = validateLiveCardSchema({
        id: 'x', card_data: {},
        source_defs: [{ kind: 'api', bindTo: 'raw' }],
      });
      expect(r.ok).toBe(false);
    });

    it('source_defs with duplicate bindTo', () => {
      const r = validateLiveCardSchema({
        id: 'x', card_data: {},
        source_defs: [
          { bindTo: 'data', outputFile: 'data1.json', kind: 'api' },
          { bindTo: 'data', outputFile: 'data2.json', kind: 'api' },
        ],
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('bindTo'))).toBe(true);
    });

    it('source_defs with duplicate outputFile', () => {
      const r = validateLiveCardSchema({
        id: 'x', card_data: {},
        source_defs: [
          { bindTo: 'raw1', outputFile: 'data.json', kind: 'api' },
          { bindTo: 'raw2', outputFile: 'data.json', kind: 'api' },
        ],
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('outputFile'))).toBe(true);
    });

    it('meta.title wrong type', () => {
      const r = validateLiveCardSchema({
        id: 'x', card_data: {},
        meta: { title: 123 },
      });
      expect(r.ok).toBe(false);
    });

    it('meta.tags wrong type', () => {
      const r = validateLiveCardSchema({
        id: 'x', card_data: {},
        meta: { tags: 'not-array' },
      });
      expect(r.ok).toBe(false);
    });
  });

  // ---------- error message quality ----------

  describe('error messages', () => {
    it('includes instance path in errors', () => {
      const r = validateLiveCardSchema({
        id: 'x', card_data: {},
        compute: [{ bindTo: 'x' }],
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('/compute/0') || e.includes('compute'))).toBe(true);
    });

    it('reports multiple errors with allErrors', () => {
      const r = validateLiveCardSchema({
        // missing id
      });
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThan(0);
    });
  });
});

describe('validateLiveCardRuntimeExpressions', () => {
  it('accepts parser-compatible expressions', () => {
    const r = validateLiveCardRuntimeExpressions({
      id: 'ok',
      card_data: {},
      compute: [{ bindTo: 'x', expr: 'requires.orders^(>amount)#$i[$i<=5]' }],
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('rejects parser-incompatible expressions', () => {
    const r = validateLiveCardRuntimeExpressions({
      id: 'bad',
      card_data: {},
      compute: [{ bindTo: 'x', expr: '$sort(requires.orders, function($a, $b){ $b.amount - $a.amount })[0..4]' }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('/compute/0/expr'))).toBe(true);
  });

  it('rejects compute expressions that use legacy source_defs namespace', () => {
    const r = validateLiveCardRuntimeExpressions({
      id: 'bad-compute-ns',
      card_data: {},
      compute: [{ bindTo: 'x', expr: '$count(source_defs.raw)' }],
    });

    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('/compute/0/expr') && e.includes('disallowed namespace "source_defs"'))).toBe(true);
  });

  it('accepts view references to fetched_sources/requires/card_data/computed_values', () => {
    const r = validateLiveCardRuntimeExpressions({
      id: 'ok-view-refs',
      card_data: {},
      view: {
        elements: [
          { kind: 'metric', visible: 'requires.orders', data: { bind: 'computed_values.total', writeTo: 'card_data.note' } },
          { kind: 'table', data: { bind: 'fetched_sources.raw' } },
        ],
      },
    });

    expect(r.ok).toBe(true);
  });

  it('rejects view references using legacy source_defs namespace', () => {
    const r = validateLiveCardRuntimeExpressions({
      id: 'bad-view-refs',
      card_data: {},
      view: {
        elements: [{ kind: 'table', data: { bind: 'source_defs.raw' } }],
      },
    });

    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('/view/elements/0/data/bind') && e.includes('disallowed namespace "source_defs"'))).toBe(true);
  });

  it('accepts provides.src with all four valid namespaces', () => {
    const r = validateLiveCardRuntimeExpressions({
      id: 'ok-provides',
      card_data: {},
      provides: [
        { bindTo: 'a', src: 'fetched_sources.raw' },
        { bindTo: 'b', src: 'computed_values.total' },
        { bindTo: 'c', src: 'card_data.status' },
        { bindTo: 'd', src: 'requires.upstream' },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toHaveLength(0);
  });

  it('rejects provides.src using legacy source_defs namespace', () => {
    const r = validateLiveCardRuntimeExpressions({
      id: 'bad-provides-bsources',
      card_data: {},
      provides: [{ bindTo: 'trades', src: 'source_defs.rebalance.proposed_trades' }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('/provides/0/src') && e.includes('disallowed namespace "source_defs"'))).toBe(true);
  });

  it('rejects provides.src with unrecognised namespace', () => {
    const r = validateLiveCardRuntimeExpressions({
      id: 'bad-provides-unknown',
      card_data: {},
      provides: [{ bindTo: 'x', src: 'foobar.value' }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('/provides/0/src') && e.includes('must start with a valid namespace'))).toBe(true);
  });
});

describe('validateLiveCardDefinition', () => {
  it('passes when schema and expressions are valid', () => {
    const r = validateLiveCardDefinition({
      id: 'ok-full',
      card_data: {},
      compute: [{ bindTo: 'x', expr: 'requires.orders^(>amount)' }],
      view: { elements: [{ kind: 'list', data: { bind: 'computed_values.x' } }] },
    });
    expect(r.ok).toBe(true);
  });

  it('fails when schema passes but expression compile fails', () => {
    const r = validateLiveCardDefinition({
      id: 'bad-full',
      card_data: {},
      compute: [{ bindTo: 'x', expr: '$sort(requires.orders, function($a, $b){ $b.amount - $a.amount })[0..4]' }],
      view: { elements: [{ kind: 'list', data: { bind: 'computed_values.x' } }] },
    });
    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('/compute/0/expr'))).toBe(true);
  });

  it('runs schema + runtime namespace checks through validateLiveCard alias', () => {
    const r = validateLiveCard({
      id: 'bad-alias',
      card_data: {},
      compute: [{ bindTo: 'x', expr: '$count(source_defs.raw)' }],
      view: { elements: [{ kind: 'metric', data: { bind: 'computed_values.total' } }] },
    });

    expect(r.ok).toBe(false);
    expect(r.errors.some(e => e.includes('/compute/0/expr'))).toBe(true);
  });
});
