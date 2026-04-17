import { describe, it, expect } from 'vitest';
import { validateLiveCardSchema } from '../../src/card-compute/schema-validator.js';

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
        state: { status: 'fresh' },
        view: { elements: [{ kind: 'metric' }] },
      });
      expect(r.ok).toBe(true);
    });

    it('card with sources', () => {
      const r = validateLiveCardSchema({
        id: 'src1',
        state: { status: 'fresh' },
        sources: [{ bindTo: 'raw', kind: 'api' }],
      });
      expect(r.ok).toBe(true);
    });

    it('card with all optional sections', () => {
      const r = validateLiveCardSchema({
        id: 'full-card',
        meta: { title: 'Dashboard', tags: ['finance'] },
        requires: ['src1'],
        provides: ['total'],
        state: { status: 'fresh' },
        view: {
          elements: [
            { kind: 'metric', data: { bind: 'state.total' } },
            { kind: 'table', data: { bind: 'state.rows', columns: ['a', 'b'] } },
          ],
          layout: { board: { col: 6, order: 1 } },
          features: { chat: true, refresh: true },
        },
        compute: [
          { bindTo: 'total', fn: 'sum', input: 'state.data', field: 'revenue' },
        ],
        sources: [{ bindTo: 'data', kind: 'api' }],
        optionalSources: [{ bindTo: 'news' }],
      });
      expect(r.ok).toBe(true);
    });

    it('source with full source_def fields', () => {
      const r = validateLiveCardSchema({
        id: 'src-full',
        state: {},
        sources: [{
          kind: 'api',
          bindTo: 'quotes',
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
        'markdown', 'custom', 'file-upload', 'chat', 'actions',
      ];
      for (const kind of kinds) {
        const r = validateLiveCardSchema({
          id: `k-${kind}`, state: {},
          view: { elements: [{ kind }] },
        });
        expect(r.ok, `kind "${kind}" should be valid`).toBe(true);
      }
    });

    it('all source kinds accepted in sources array', () => {
      for (const kind of ['api', 'websocket', 'static', 'llm']) {
        const r = validateLiveCardSchema({
          id: `s-${kind}`, state: {},
          sources: [{ kind, bindTo: 'x' }],
        });
        expect(r.ok, `source kind "${kind}" should be valid`).toBe(true);
      }
    });

    it('all status values accepted', () => {
      for (const status of ['fresh', 'stale', 'loading', 'error']) {
        const r = validateLiveCardSchema({
          id: 'x', state: { status },
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
      const r = validateLiveCardSchema({ state: {} });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('id'))).toBe(true);
    });

    it('card with unknown top-level key', () => {
      const r = validateLiveCardSchema({
        id: 'x', state: {},
        extra: true,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('additional'))).toBe(true);
    });

    it('view.elements empty', () => {
      const r = validateLiveCardSchema({
        id: 'x', state: {},
        view: { elements: [] },
      });
      expect(r.ok).toBe(false);
    });

    it('invalid element kind', () => {
      const r = validateLiveCardSchema({
        id: 'x', state: {},
        view: { elements: [{ kind: 'sparkline' }] },
      });
      expect(r.ok).toBe(false);
    });

    it('invalid state.status', () => {
      const r = validateLiveCardSchema({
        id: 'x', state: { status: 'bogus' },
      });
      expect(r.ok).toBe(false);
    });

    it('compute step with invalid fn', () => {
      const r = validateLiveCardSchema({
        id: 'x', state: {},
        compute: [{ bindTo: 'total', fn: 'bogus_fn' }],
      });
      expect(r.ok).toBe(false);
    });

    it('compute step missing bindTo', () => {
      const r = validateLiveCardSchema({
        id: 'x', state: {},
        compute: [{ fn: 'sum' }],
      });
      expect(r.ok).toBe(false);
    });

    it('compute as object instead of array', () => {
      const r = validateLiveCardSchema({
        id: 'x', state: {},
        compute: { total: { fn: 'sum' } },
      });
      expect(r.ok).toBe(false);
    });

    it('sources entry missing bindTo', () => {
      const r = validateLiveCardSchema({
        id: 'x', state: {},
        sources: [{ kind: 'api' }],
      });
      expect(r.ok).toBe(false);
    });

    it('meta.title wrong type', () => {
      const r = validateLiveCardSchema({
        id: 'x', state: {},
        meta: { title: 123 },
      });
      expect(r.ok).toBe(false);
    });

    it('meta.tags wrong type', () => {
      const r = validateLiveCardSchema({
        id: 'x', state: {},
        meta: { tags: 'not-array' },
      });
      expect(r.ok).toBe(false);
    });
  });

  // ---------- error message quality ----------

  describe('error messages', () => {
    it('includes instance path in errors', () => {
      const r = validateLiveCardSchema({
        id: 'x', state: { status: 'bogus' },
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('status') || e.includes('state'))).toBe(true);
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
