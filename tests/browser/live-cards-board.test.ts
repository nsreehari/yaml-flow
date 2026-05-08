// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// live-cards.js is an IIFE that defines a global `LiveCard`. Load and eval it once
// per test in jsdom to get a fresh module instance with a clean DOM.
const LIVE_CARDS_SRC = readFileSync(
  join(__dirname, '..', '..', 'browser', 'live-cards.js'),
  'utf-8',
);

declare global {
  // eslint-disable-next-line no-var
  var LiveCard: any;
}

function loadLiveCards(): any {
  // Evaluate in the current jsdom global so window/document are bound.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function(LIVE_CARDS_SRC + '\n;globalThis.LiveCard = LiveCard;')();
  return globalThis.LiveCard;
}

function makeCardDef(id: string, title = id): any {
  return {
    id,
    meta: { title },
    view: {
      elements: [
        { kind: 'metric', label: 'Value', data: { bind: 'computed_values.value' } },
      ],
    },
  };
}

function makeModel(id: string, computedValue: unknown, status = 'completed'): any {
  return {
    id,
    card: makeCardDef(id),
    card_data: { status, lastRun: '2026-01-01T00:00:00Z' },
    requires: {},
    computed_values: { value: computedValue },
    runtime_state: { task_status: status, runtime: {}, error: null, blocked_by: [], requires_missing: [] },
  };
}

interface State {
  ids: string[];
  byId: Record<string, any>;
}

function makeState(models: any[]): State {
  return {
    ids: models.map((m) => m.id),
    byId: Object.fromEntries(models.map((m) => [m.id, m])),
  };
}

describe('LiveCard.Board (reactive) and LiveCard.BoardCore', () => {
  let LiveCard: any;
  let container: HTMLElement;
  let engine: any;

  beforeEach(() => {
    document.body.innerHTML = '';
    LiveCard = loadLiveCards();
    container = document.createElement('div');
    document.body.appendChild(container);
    engine = LiveCard.init({ resolve: (id: string) => null });
  });

  it('exposes both Board (reactive) and BoardCore (imperative)', () => {
    expect(typeof LiveCard.Board).toBe('function');
    expect(typeof LiveCard.BoardCore).toBe('function');
  });

  it('BoardCore has no refresh() method', () => {
    const core = LiveCard.BoardCore(engine, container, { nodes: [] });
    expect((core as any).refresh).toBeUndefined();
    core.destroy();
  });

  it('Board initial render mounts N nodes', () => {
    const state = makeState([
      makeModel('a', 1),
      makeModel('b', 2),
      makeModel('c', 3),
    ]);
    const board = LiveCard.Board(engine, container, {
      initialState: state,
      getNodeIds: (s: State) => s.ids,
      selectNode: (s: State, id: string) => s.byId[id],
    });
    const cardEls = container.querySelectorAll('[data-node-id]');
    expect(cardEls.length).toBe(3);
    board.destroy();
  });

  it('setState with no model changes does not call updateNode', () => {
    const m1 = makeModel('a', 1);
    const state1 = makeState([m1]);
    const board = LiveCard.Board(engine, container, {
      initialState: state1,
      getNodeIds: (s: State) => s.ids,
      selectNode: (s: State, id: string) => s.byId[id],
    });
    const updateSpy = vi.spyOn(board.core, 'updateNode');
    board.setState(state1);
    expect(updateSpy).not.toHaveBeenCalled();
    board.destroy();
  });

  it('setState changing one card calls updateNode exactly once for that id', () => {
    const a1 = makeModel('a', 1);
    const b1 = makeModel('b', 2);
    const state1 = makeState([a1, b1]);
    const board = LiveCard.Board(engine, container, {
      initialState: state1,
      getNodeIds: (s: State) => s.ids,
      selectNode: (s: State, id: string) => s.byId[id],
    });
    const updateSpy = vi.spyOn(board.core, 'updateNode');

    const a2 = makeModel('a', 99);
    const state2 = makeState([a2, b1]);
    board.setState(state2);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toBe('a');
    board.destroy();
  });

  it('setState accepts updater function signature', () => {
    const a1 = makeModel('a', 1);
    const state1 = makeState([a1]);
    const board = LiveCard.Board(engine, container, {
      initialState: state1,
      getNodeIds: (s: State) => s.ids,
      selectNode: (s: State, id: string) => s.byId[id],
    });
    const updateSpy = vi.spyOn(board.core, 'updateNode');

    board.setState((prev: State) => {
      return {
        ids: prev.ids,
        byId: {
          ...prev.byId,
          a: {
            ...prev.byId.a,
            computed_values: {
              ...prev.byId.a.computed_values,
              value: 42,
            },
          },
        },
      };
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toBe('a');
    board.destroy();
  });

  it('setState does not update when only refs change but data stays equal', () => {
    const a1 = makeModel('a', 1);
    const state1 = makeState([a1]);
    const board = LiveCard.Board(engine, container, {
      initialState: state1,
      getNodeIds: (s: State) => s.ids,
      selectNode: (s: State, id: string) => s.byId[id],
    });
    const updateSpy = vi.spyOn(board.core, 'updateNode');

    const aSameDataNewRefs = {
      ...a1,
      card: { ...a1.card },
      card_data: { ...a1.card_data },
      requires: { ...a1.requires },
      computed_values: { ...a1.computed_values },
      runtime_state: { ...a1.runtime_state },
    };

    board.setState(makeState([aSameDataNewRefs]));

    expect(updateSpy).not.toHaveBeenCalled();
    board.destroy();
  });

  it('setState detects in-place mutation and updates the node', () => {
    const a1 = makeModel('a', 1);
    const state1 = makeState([a1]);
    const board = LiveCard.Board(engine, container, {
      initialState: state1,
      getNodeIds: (s: State) => s.ids,
      selectNode: (s: State, id: string) => s.byId[id],
    });
    const updateSpy = vi.spyOn(board.core, 'updateNode');

    // Mutate in place to mimic non-immutable caller code.
    a1.computed_values.value = 2;
    board.setState(state1);

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toBe('a');
    board.destroy();
  });

  it('setState updater returning undefined is treated as no-op', () => {
    const a1 = makeModel('a', 1);
    const state1 = makeState([a1]);
    const board = LiveCard.Board(engine, container, {
      initialState: state1,
      getNodeIds: (s: State) => s.ids,
      selectNode: (s: State, id: string) => s.byId[id],
    });
    const updateSpy = vi.spyOn(board.core, 'updateNode');
    const reorderSpy = vi.spyOn(board.core, 'reorder');

    board.setState(() => undefined as unknown as State);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(reorderSpy).not.toHaveBeenCalled();
    expect(board.state).toBe(state1);
    board.destroy();
  });

  it('setState updater can mutate prev in place and still trigger only changed node', () => {
    const a1 = makeModel('a', 1);
    const b1 = makeModel('b', 2);
    const state1 = makeState([a1, b1]);
    const board = LiveCard.Board(engine, container, {
      initialState: state1,
      getNodeIds: (s: State) => s.ids,
      selectNode: (s: State, id: string) => s.byId[id],
    });
    const updateSpy = vi.spyOn(board.core, 'updateNode');

    board.setState((prev: State) => {
      prev.byId.a.computed_values.value = 7;
      return prev;
    });

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toBe('a');
    board.destroy();
  });

  it('setState updates exactly the nodes with semantic data changes', () => {
    const a1 = makeModel('a', 1);
    const b1 = makeModel('b', 2);
    const c1 = makeModel('c', 3);
    const board = LiveCard.Board(engine, container, {
      initialState: makeState([a1, b1, c1]),
      getNodeIds: (s: State) => s.ids,
      selectNode: (s: State, id: string) => s.byId[id],
    });
    const updateSpy = vi.spyOn(board.core, 'updateNode');

    const aSameDataNewRefs = {
      ...a1,
      card_data: { ...a1.card_data },
      requires: { ...a1.requires },
      computed_values: { ...a1.computed_values },
      runtime_state: { ...a1.runtime_state },
    };
    const bChanged = {
      ...b1,
      computed_values: { ...b1.computed_values, value: 22 },
    };
    const cSameRef = c1;

    board.setState(makeState([aSameDataNewRefs, bChanged, cSameRef]));

    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy.mock.calls[0][0]).toBe('b');
    board.destroy();
  });

  it('setState removing a card calls core.remove and drops it from DOM', () => {
    const a = makeModel('a', 1);
    const b = makeModel('b', 2);
    const state1 = makeState([a, b]);
    const board = LiveCard.Board(engine, container, {
      initialState: state1,
      getNodeIds: (s: State) => s.ids,
      selectNode: (s: State, id: string) => s.byId[id],
    });
    const removeSpy = vi.spyOn(board.core, 'remove');
    board.setState(makeState([a]));
    expect(removeSpy).toHaveBeenCalledWith('b');
    expect(container.querySelectorAll('[data-node-id="b"]').length).toBe(0);
    expect(container.querySelectorAll('[data-node-id="a"]').length).toBe(1);
    board.destroy();
  });

  it('setState adding a card calls core.add', () => {
    const a = makeModel('a', 1);
    const board = LiveCard.Board(engine, container, {
      initialState: makeState([a]),
      getNodeIds: (s: State) => s.ids,
      selectNode: (s: State, id: string) => s.byId[id],
    });
    const addSpy = vi.spyOn(board.core, 'add');
    const b = makeModel('b', 2);
    board.setState(makeState([a, b]));
    expect(addSpy).toHaveBeenCalledTimes(1);
    expect(addSpy.mock.calls[0][0].id).toBe('b');
    board.destroy();
  });

  it('setState reordering ids calls core.reorder with the new sequence', () => {
    const a = makeModel('a', 1);
    const b = makeModel('b', 2);
    const c = makeModel('c', 3);
    const board = LiveCard.Board(engine, container, {
      initialState: makeState([a, b, c]),
      getNodeIds: (s: State) => s.ids,
      selectNode: (s: State, id: string) => s.byId[id],
    });
    const reorderSpy = vi.spyOn(board.core, 'reorder');
    board.setState(makeState([c, a, b]));
    expect(reorderSpy).toHaveBeenCalledWith(['c', 'a', 'b']);
    board.destroy();
  });

  it('view bind to fetched_sources.* resolves to undefined (namespace gone)', () => {
    const id = 'x';
    const card = {
      id,
      meta: { title: id },
      view: {
        elements: [
          { kind: 'text', label: 'Source', data: { bind: 'fetched_sources.foo.bar' }, id: 'src-text' },
        ],
      },
    };
    const model = {
      id,
      card,
      card_data: { status: 'completed' },
      requires: {},
      computed_values: {},
      runtime_state: { task_status: 'completed' },
    };
    LiveCard.BoardCore(engine, container, { nodes: [model] });
    const el = container.querySelector('[data-node-id="x"]');
    expect(el).toBeTruthy();
    // The text element should render but with no resolved value (empty/missing).
    // We only assert that the namespace did not produce any value into the DOM.
    const txt = el!.textContent || '';
    expect(txt).not.toContain('fetched_sources');
  });

  it('inspector renders no editor textarea or Submit button (read-only)', () => {
    const m = makeModel('a', 1);
    LiveCard.BoardCore(engine, container, { nodes: [m], devMode: true });
    // Dev mode shows a "</>" code button in the card header that opens the inspector.
    const codeBtn = Array.from(container.querySelectorAll('.card-header button')).find(
      (b) => /\//.test(b.innerHTML),
    ) as HTMLButtonElement | undefined;
    expect(codeBtn).toBeTruthy();
    codeBtn!.click();

    const modal = document.querySelector('.modal.d-block');
    expect(modal).toBeTruthy();
    expect(modal!.querySelector('textarea')).toBeNull();
    const submit = Array.from(modal!.querySelectorAll('button')).find((b) => /submit/i.test(b.textContent || ''));
    expect(submit).toBeFalsy();
    const headings = Array.from(modal!.querySelectorAll('h6')).map((h) => h.textContent || '');
    expect(headings.some((t) => /Card Definition.*Read-only/i.test(t))).toBe(true);
  });
});
