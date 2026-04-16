import { describe, it, expect } from 'vitest';
import { validateLiveCardSchema } from '../../src/card-compute/schema-validator.js';

// ============================================================================
// validateLiveCardSchema — full JSON Schema validation via AJV
// ============================================================================

describe('validateLiveCardSchema', () => {

  // ---------- valid nodes ----------

  describe('valid nodes', () => {
    it('minimal valid card', () => {
      const r = validateLiveCardSchema({
        id: 'card1',
        type: 'card',
        state: { status: 'fresh' },
        view: { elements: [{ kind: 'metric' }] },
      });
      expect(r.ok).toBe(true);
      expect(r.errors).toHaveLength(0);
    });

    it('minimal valid source', () => {
      const r = validateLiveCardSchema({
        id: 'src1',
        type: 'source',
        state: { status: 'fresh' },
        source: { kind: 'api', bindTo: 'state.raw' },
      });
      expect(r.ok).toBe(true);
      expect(r.errors).toHaveLength(0);
    });

    it('card with all optional sections', () => {
      const r = validateLiveCardSchema({
        id: 'full-card',
        type: 'card',
        meta: { title: 'Dashboard', tags: ['finance'] },
        data: {
          requires: ['src1'],
          provides: { total: { bind: 'state.total' } },
        },
        state: { status: 'fresh' },
        view: {
          elements: [
            { kind: 'metric', data: { bind: 'state.total' } },
            { kind: 'table', data: { bind: 'state.rows', columns: ['a', 'b'] } },
          ],
          layout: { board: { col: 6, order: 1 } },
          features: { chat: true, refresh: true },
        },
        compute: {
          total: { fn: 'sum', input: 'state.data', field: 'revenue' },
        },
      });
      expect(r.ok).toBe(true);
    });

    it('source with full source_def', () => {
      const r = validateLiveCardSchema({
        id: 'src-full',
        type: 'source',
        state: {},
        source: {
          kind: 'api',
          bindTo: 'state.quotes',
          method: 'POST',
          url_template: 'https://api.example.com/{{symbol}}',
          headers: { Authorization: 'Bearer abc' },
          body_template: { query: '{{q}}' },
          template_vars: { symbol: 'MSFT' },
          poll_interval: 30,
          transform: 'data.items',
        },
      });
      expect(r.ok).toBe(true);
    });

    it('all element kinds accepted', () => {
      const kinds = [
        'metric', 'table', 'chart', 'form', 'filter', 'list',
        'notes', 'todo', 'alert', 'narrative', 'badge', 'text',
        'markdown', 'custom', 'file-upload', 'chat', 'actions',
      ];
      for (const kind of kinds) {
        const r = validateLiveCardSchema({
          id: `k-${kind}`, type: 'card', state: {},
          view: { elements: [{ kind }] },
        });
        expect(r.ok, `kind "${kind}" should be valid`).toBe(true);
      }
    });

    it('all source kinds accepted', () => {
      for (const kind of ['api', 'websocket', 'static', 'llm']) {
        const r = validateLiveCardSchema({
          id: `s-${kind}`, type: 'source', state: {},
          source: { kind, bindTo: 'state.x' },
        });
        expect(r.ok, `source kind "${kind}" should be valid`).toBe(true);
      }
    });

    it('all status values accepted', () => {
      for (const status of ['fresh', 'stale', 'loading', 'error']) {
        const r = validateLiveCardSchema({
          id: 'x', type: 'card', state: { status },
          view: { elements: [{ kind: 'text' }] },
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
      const r = validateLiveCardSchema({
        type: 'card', state: {},
        view: { elements: [{ kind: 'text' }] },
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('id'))).toBe(true);
    });

    it('invalid type', () => {
      const r = validateLiveCardSchema({
        id: 'x', type: 'widget', state: {},
      });
      expect(r.ok).toBe(false);
    });

    it('card with unknown top-level key', () => {
      const r = validateLiveCardSchema({
        id: 'x', type: 'card', state: {},
        view: { elements: [{ kind: 'text' }] },
        extra: true,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('additional'))).toBe(true);
    });

    it('card missing view', () => {
      const r = validateLiveCardSchema({
        id: 'x', type: 'card', state: {},
      });
      expect(r.ok).toBe(false);
    });

    it('card view.elements empty', () => {
      const r = validateLiveCardSchema({
        id: 'x', type: 'card', state: {},
        view: { elements: [] },
      });
      expect(r.ok).toBe(false);
    });

    it('invalid element kind', () => {
      const r = validateLiveCardSchema({
        id: 'x', type: 'card', state: {},
        view: { elements: [{ kind: 'sparkline' }] },
      });
      expect(r.ok).toBe(false);
    });

    it('invalid state.status', () => {
      const r = validateLiveCardSchema({
        id: 'x', type: 'card', state: { status: 'bogus' },
        view: { elements: [{ kind: 'text' }] },
      });
      expect(r.ok).toBe(false);
    });

    it('source missing source property', () => {
      const r = validateLiveCardSchema({
        id: 'x', type: 'source', state: {},
      });
      expect(r.ok).toBe(false);
    });

    it('source.bindTo wrong prefix', () => {
      const r = validateLiveCardSchema({
        id: 'x', type: 'source', state: {},
        source: { kind: 'api', bindTo: 'data.raw' },
      });
      expect(r.ok).toBe(false);
    });

    it('source.kind invalid', () => {
      const r = validateLiveCardSchema({
        id: 'x', type: 'source', state: {},
        source: { kind: 'ftp', bindTo: 'state.x' },
      });
      expect(r.ok).toBe(false);
    });

    it('compute expression with invalid fn', () => {
      const r = validateLiveCardSchema({
        id: 'x', type: 'card', state: {},
        view: { elements: [{ kind: 'text' }] },
        compute: { total: { fn: 'bogus_fn' } },
      });
      expect(r.ok).toBe(false);
    });

    it('meta.title wrong type', () => {
      const r = validateLiveCardSchema({
        id: 'x', type: 'card', state: {},
        meta: { title: 123 },
        view: { elements: [{ kind: 'text' }] },
      });
      expect(r.ok).toBe(false);
    });

    it('meta.tags wrong type', () => {
      const r = validateLiveCardSchema({
        id: 'x', type: 'card', state: {},
        meta: { tags: 'not-array' },
        view: { elements: [{ kind: 'text' }] },
      });
      expect(r.ok).toBe(false);
    });
  });

  // ---------- error message quality ----------

  describe('error messages', () => {
    it('includes instance path in errors', () => {
      const r = validateLiveCardSchema({
        id: 'x', type: 'card', state: { status: 'bogus' },
        view: { elements: [{ kind: 'text' }] },
      });
      expect(r.ok).toBe(false);
      // AJV should report the path to the invalid value
      expect(r.errors.some(e => e.includes('status') || e.includes('state'))).toBe(true);
    });

    it('reports multiple errors with allErrors', () => {
      const r = validateLiveCardSchema({
        type: 'card',
        // missing id, state, view
      });
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThan(1);
    });
  });
});
