// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Reactive-rendering regression tests: confirm that the rendered DOM follows
// the state when callers drive LiveCard.Board via setState. The companion
// file live-cards-board.test.ts pins the lifecycle (which updateNode calls
// fire); this file pins what actually shows up in the DOM for the common
// view-element kinds (metric / text / markdown / table) and how add / remove
// / reorder affect the card column DOM.

const LIVE_CARDS_SRC = readFileSync(
  join(__dirname, '..', '..', 'browser', 'live-cards.js'),
  'utf-8',
);

declare global {
  // eslint-disable-next-line no-var
  var LiveCard: any;
}

function loadLiveCards(): any {
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function(LIVE_CARDS_SRC + '\n;globalThis.LiveCard = LiveCard;')();
  return globalThis.LiveCard;
}

interface State {
  ids: string[];
  byId: Record<string, any>;
}

function makeModel(id: string, opts: {
  elements?: any[];
  computed_values?: any;
  card_data?: any;
  status?: string;
} = {}): any {
  return {
    id,
    card: {
      id,
      meta: { title: id },
      view: {
        elements: opts.elements || [
          { kind: 'metric', id: 'm', label: 'Value', data: { bind: 'computed_values.value' } },
        ],
      },
    },
    card_data: Object.assign({ status: opts.status || 'completed', lastRun: '2026-01-01T00:00:00Z' }, opts.card_data || {}),
    requires: {},
    computed_values: opts.computed_values || { value: 0 },
    runtime_state: { task_status: opts.status || 'completed', runtime: {}, error: null, blocked_by: [], requires_missing: [] },
  };
}

function makeState(models: any[]): State {
  return {
    ids: models.map((m) => m.id),
    byId: Object.fromEntries(models.map((m) => [m.id, m])),
  };
}

let LiveCard: any;
let engine: any;
let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  delete (globalThis as any).LiveCard;
  LiveCard = loadLiveCards();
  container = document.createElement('div');
  document.body.appendChild(container);
  engine = LiveCard.init({ resolve: (_id: string) => null });
});

function mountBoard(state: State): any {
  return LiveCard.Board(engine, container, {
    initialState: state,
    getNodeIds: (s: State) => s.ids,
    selectNode: (s: State, id: string) => s.byId[id],
  });
}

describe('reactive rendering — metric element', () => {
  it('initial render shows the bound computed value', () => {
    const a = makeModel('a', { computed_values: { value: 42 } });
    const board = mountBoard(makeState([a]));
    try {
      const metric = container.querySelector('[data-node-id="a"] .lc-metric-value');
      expect(metric).toBeTruthy();
      expect((metric!.textContent || '').trim()).toBe('42');
    } finally { board.destroy(); }
  });

  it('updating computed_values.value via setState updates the metric DOM in place', () => {
    const a1 = makeModel('a', { computed_values: { value: 1 } });
    const board = mountBoard(makeState([a1]));
    try {
      const before = container.querySelector('[data-node-id="a"]') as HTMLElement;
      expect((before.querySelector('.lc-metric-value')!.textContent || '').trim()).toBe('1');

      board.setState(makeState([makeModel('a', { computed_values: { value: 99 } })]));
      const after = container.querySelector('[data-node-id="a"]') as HTMLElement;
      // Card DOM node itself should not be replaced — only inner contents update.
      expect(after).toBe(before);
      expect((after.querySelector('.lc-metric-value')!.textContent || '').trim()).toBe('99');
    } finally { board.destroy(); }
  });

  it('metric renders dash when bound value is missing', () => {
    const a = makeModel('a', {
      elements: [{ kind: 'metric', id: 'm', label: 'X', data: { bind: 'computed_values.missing' } }],
      computed_values: {},
    });
    const board = mountBoard(makeState([a]));
    try {
      const txt = container.querySelector('[data-node-id="a"] .lc-metric-value')!.textContent || '';
      expect(txt.trim()).toBe('—');
    } finally { board.destroy(); }
  });
});

describe('reactive rendering — text element', () => {
  it('renders bound string and re-renders on state change', () => {
    const a = makeModel('a', {
      elements: [{ kind: 'text', id: 't', data: { bind: 'computed_values.msg' } }],
      computed_values: { msg: 'hello' },
    });
    const board = mountBoard(makeState([a]));
    try {
      let host = container.querySelector('[data-node-id="a"]') as HTMLElement;
      expect((host.textContent || '')).toContain('hello');
      board.setState(makeState([makeModel('a', {
        elements: [{ kind: 'text', id: 't', data: { bind: 'computed_values.msg' } }],
        computed_values: { msg: 'world' },
      })]));
      host = container.querySelector('[data-node-id="a"]') as HTMLElement;
      expect((host.textContent || '')).toContain('world');
      expect((host.textContent || '')).not.toContain('hello');
    } finally { board.destroy(); }
  });

  it('text format=file-links renders Download anchors built from cfg.fileUrlBase', () => {
    // Local engine with explicit fileUrlBase
    engine = LiveCard.init({ resolve: (_id: string) => null, fileUrlBase: '/api/test-board' });
    const a = makeModel('a', {
      elements: [{
        kind: 'text',
        id: 'files',
        data: { bind: 'card_data.files', format: 'file-links', cardId: 'a' },
      }],
      card_data: {
        files: [
          { name: 'a.txt', size: 1024, stored_name: 's-a.txt' },
          { name: 'b.csv', size: 2048, stored_name: 's-b.csv' },
        ],
      },
    });
    const board = mountBoard(makeState([a]));
    try {
      const anchors = container.querySelectorAll('[data-node-id="a"] a[href]');
      expect(anchors.length).toBe(2);
      const h0 = (anchors[0] as HTMLAnchorElement).getAttribute('href');
      expect(h0).toBe('/api/test-board/cards/a/files/0?sn=' + encodeURIComponent('s-a.txt'));
      expect((anchors[0].textContent || '')).toContain('a.txt');
      expect((anchors[0].textContent || '')).toContain('1KB');
    } finally { board.destroy(); }
  });

  it('text format=file-links shows empty state with no files', () => {
    const a = makeModel('a', {
      elements: [{
        kind: 'text',
        id: 'files',
        data: { bind: 'card_data.files', format: 'file-links', cardId: 'a' },
      }],
      card_data: { files: [] },
    });
    const board = mountBoard(makeState([a]));
    try {
      const host = container.querySelector('[data-node-id="a"]') as HTMLElement;
      expect((host.textContent || '')).toContain('No files uploaded');
    } finally { board.destroy(); }
  });
});

describe('reactive rendering — markdown element', () => {
  it('renders markdown content reactively', () => {
    const a = makeModel('a', {
      elements: [{ kind: 'markdown', id: 'md', data: { bind: 'computed_values.body' } }],
      computed_values: { body: '# Title\n\nbody text' },
    });
    const board = mountBoard(makeState([a]));
    try {
      const host = container.querySelector('[data-node-id="a"]') as HTMLElement;
      expect((host.textContent || '')).toContain('Title');
      expect((host.textContent || '')).toContain('body text');
      // Update content.
      board.setState(makeState([makeModel('a', {
        elements: [{ kind: 'markdown', id: 'md', data: { bind: 'computed_values.body' } }],
        computed_values: { body: 'completely different' },
      })]));
      const after = container.querySelector('[data-node-id="a"]') as HTMLElement;
      expect((after.textContent || '')).toContain('completely different');
      expect((after.textContent || '')).not.toContain('body text');
    } finally { board.destroy(); }
  });
});

describe('reactive rendering — table element', () => {
  it('renders rows from bound array and updates rows reactively', () => {
    const tableDef = { kind: 'table', id: 'tbl', data: { bind: 'computed_values.rows', columns: ['name', 'value'] } };
    const a = makeModel('a', {
      elements: [tableDef],
      computed_values: { rows: [{ name: 'one', value: 1 }, { name: 'two', value: 2 }] },
    });
    const board = mountBoard(makeState([a]));
    try {
      let rows = container.querySelectorAll('[data-node-id="a"] table tbody tr');
      expect(rows.length).toBe(2);
      expect((rows[0].textContent || '')).toContain('one');
      expect((rows[1].textContent || '')).toContain('two');

      // Push one more row.
      board.setState(makeState([makeModel('a', {
        elements: [tableDef],
        computed_values: { rows: [{ name: 'one', value: 1 }, { name: 'two', value: 2 }, { name: 'three', value: 3 }] },
      })]));
      rows = container.querySelectorAll('[data-node-id="a"] table tbody tr');
      expect(rows.length).toBe(3);
      expect((rows[2].textContent || '')).toContain('three');
    } finally { board.destroy(); }
  });

  it('renders placeholder when bound array is empty', () => {
    const a = makeModel('a', {
      elements: [{ kind: 'table', id: 'tbl', data: { bind: 'computed_values.rows', placeholder: 'Empty table' } }],
      computed_values: { rows: [] },
    });
    const board = mountBoard(makeState([a]));
    try {
      const host = container.querySelector('[data-node-id="a"]') as HTMLElement;
      expect((host.textContent || '')).toContain('Empty table');
      expect(host.querySelector('table')).toBeNull();
    } finally { board.destroy(); }
  });
});

describe('reactive rendering — DOM lifecycle for add / remove / reorder', () => {
  it('add appends a new [data-node-id] card to the container', () => {
    const a = makeModel('a', { computed_values: { value: 1 } });
    const board = mountBoard(makeState([a]));
    try {
      expect(container.querySelectorAll('[data-node-id]').length).toBe(1);
      const b = makeModel('b', { computed_values: { value: 2 } });
      board.setState(makeState([a, b]));
      const cards = container.querySelectorAll('[data-node-id]');
      expect(cards.length).toBe(2);
      const ids = Array.from(cards).map((c) => (c as HTMLElement).dataset.nodeId);
      expect(ids).toEqual(['a', 'b']);
    } finally { board.destroy(); }
  });

  it('remove drops the card from the DOM but keeps untouched cards in place', () => {
    const a = makeModel('a', { computed_values: { value: 1 } });
    const b = makeModel('b', { computed_values: { value: 2 } });
    const board = mountBoard(makeState([a, b]));
    try {
      const aBeforeHtml = (container.querySelector('[data-node-id="a"]') as HTMLElement).outerHTML;
      board.setState(makeState([a]));
      expect(container.querySelector('[data-node-id="b"]')).toBeNull();
      const aAfter = container.querySelector('[data-node-id="a"]') as HTMLElement;
      expect(aAfter).toBeTruthy();
      expect(aAfter.outerHTML).toBe(aBeforeHtml); // contents unchanged
    } finally { board.destroy(); }
  });

  it('reorder changes DOM order without re-rendering identical card contents', () => {
    const a = makeModel('a', { computed_values: { value: 1 } });
    const b = makeModel('b', { computed_values: { value: 2 } });
    const c = makeModel('c', { computed_values: { value: 3 } });
    const board = mountBoard(makeState([a, b, c]));
    try {
      const idsBefore = Array.from(container.querySelectorAll('[data-node-id]')).map((e) => (e as HTMLElement).dataset.nodeId);
      expect(idsBefore).toEqual(['a', 'b', 'c']);

      const aHtmlBefore = (container.querySelector('[data-node-id="a"]') as HTMLElement).outerHTML;
      const updateSpy = vi.spyOn(board.core, 'updateNode');

      board.setState(makeState([c, a, b]));

      const idsAfter = Array.from(container.querySelectorAll('[data-node-id]')).map((e) => (e as HTMLElement).dataset.nodeId);
      expect(idsAfter).toEqual(['c', 'a', 'b']);
      // Card contents survived the reorder.
      expect((container.querySelector('[data-node-id="a"]') as HTMLElement).outerHTML).toBe(aHtmlBefore);
      // No card data changed, so no updateNode call should fire.
      expect(updateSpy).not.toHaveBeenCalled();
    } finally { board.destroy(); }
  });

  it('a no-op setState produces zero DOM mutations', () => {
    const a = makeModel('a', { computed_values: { value: 1 } });
    const state1 = makeState([a]);
    const board = mountBoard(state1);
    try {
      const before = (container.querySelector('[data-node-id="a"]') as HTMLElement).outerHTML;
      board.setState(state1);
      const after = (container.querySelector('[data-node-id="a"]') as HTMLElement).outerHTML;
      expect(after).toBe(before);
    } finally { board.destroy(); }
  });
});

describe('reactive rendering — multiple elements in one card', () => {
  it('a single setState updates every bound element on the changed card', () => {
    const elements = [
      { kind: 'metric', id: 'm', label: 'Count', data: { bind: 'computed_values.count' } },
      { kind: 'text', id: 't', data: { bind: 'computed_values.msg' } },
      { kind: 'table', id: 'tbl', data: { bind: 'computed_values.rows', columns: ['k', 'v'] } },
    ];
    const a = makeModel('a', {
      elements,
      computed_values: { count: 1, msg: 'first', rows: [{ k: 'a', v: 1 }] },
    });
    const board = mountBoard(makeState([a]));
    try {
      let host = container.querySelector('[data-node-id="a"]') as HTMLElement;
      expect((host.querySelector('.lc-metric-value')!.textContent || '').trim()).toBe('1');
      expect((host.textContent || '')).toContain('first');
      expect(host.querySelectorAll('table tbody tr').length).toBe(1);

      board.setState(makeState([makeModel('a', {
        elements,
        computed_values: { count: 2, msg: 'second', rows: [{ k: 'a', v: 1 }, { k: 'b', v: 2 }] },
      })]));

      host = container.querySelector('[data-node-id="a"]') as HTMLElement;
      expect((host.querySelector('.lc-metric-value')!.textContent || '').trim()).toBe('2');
      expect((host.textContent || '')).toContain('second');
      expect((host.textContent || '')).not.toContain('first');
      expect(host.querySelectorAll('table tbody tr').length).toBe(2);
    } finally { board.destroy(); }
  });

  it('changing one card does not re-render sibling cards', () => {
    const a = makeModel('a', { computed_values: { value: 1 } });
    const b = makeModel('b', { computed_values: { value: 2 } });
    const board = mountBoard(makeState([a, b]));
    try {
      const bBefore = (container.querySelector('[data-node-id="b"]') as HTMLElement).outerHTML;

      board.setState(makeState([makeModel('a', { computed_values: { value: 11 } }), b]));

      const bAfter = (container.querySelector('[data-node-id="b"]') as HTMLElement).outerHTML;
      expect(bAfter).toBe(bBefore);
      const aMetric = container.querySelector('[data-node-id="a"] .lc-metric-value')!.textContent || '';
      expect(aMetric.trim()).toBe('11');
    } finally { board.destroy(); }
  });
});
