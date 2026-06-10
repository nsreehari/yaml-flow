// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Action / patch contract regression tests:
//   - actions buttons         → cfg.onAction(nodeId, 'action', { buttonId, elemId })
//   - card-header refresh     → cfg.onRefresh(nodeId)
//   - notes (textarea+Save)   → cfg.onPatchState(nodeId, { fieldValues: { notes } })
//   - editable-table (Save)   → cfg.onPatchState(nodeId, { fieldValues: rows })
//   - todo checkbox           → cfg.onPatchState(nodeId, { fieldValues: items })
//   - engine helpers          : getElement, subscribe/notify, destroy,
//                                getChatStateForCard, isReceivingChatsForCard

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

function makeModel(id: string, opts: {
  elements?: any[];
  computed_values?: any;
  card_data?: any;
  status?: string;
  features?: any;
} = {}): any {
  return {
    id,
    card: {
      id,
      meta: { title: id },
      view: {
        elements: opts.elements || [],
      },
    },
    card_data: Object.assign(
      { status: opts.status || 'completed', lastRun: '2026-01-01T00:00:00Z' },
      opts.features ? { features: opts.features } : {},
      opts.card_data || {},
    ),
    requires: {},
    computed_values: opts.computed_values || {},
    runtime_state: { task_status: opts.status || 'completed', runtime: {}, error: null, blocked_by: [], requires_missing: [] },
    card_chats: { messages: [], processing: false, receiving: false },
  };
}

let LiveCard: any;
let container: HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  delete (globalThis as any).LiveCard;
  LiveCard = loadLiveCards();
  container = document.createElement('div');
  document.body.appendChild(container);
});

function mount(models: any[], cfg: any = {}): any {
  const byId: Record<string, any> = Object.fromEntries(models.map((m) => [m.id, m]));
  const engine = LiveCard.init({
    resolve: (id: string) => byId[id] || null,
    fileUrlBase: '/api/test-board',
    ...cfg,
  });
  LiveCard.BoardCore(engine, container, { nodes: models });
  return engine;
}

describe('actions element → cfg.onAction', () => {
  it('renders one button per buttons[] entry with data-action-id', () => {
    const m = makeModel('a', {
      elements: [{
        kind: 'actions',
        id: 'acts',
        data: { buttons: [{ id: 'go', label: 'Go' }, { id: 'cancel', label: 'Cancel' }] },
      }],
    });
    mount([m]);
    const btns = container.querySelectorAll('[data-node-id="a"] [data-action-id]');
    expect(btns.length).toBe(2);
    expect((btns[0] as HTMLElement).dataset.actionId).toBe('go');
    expect((btns[0].textContent || '')).toContain('Go');
    expect((btns[1] as HTMLElement).dataset.actionId).toBe('cancel');
  });

  it('clicking a button invokes onAction(nodeId, "action", { buttonId, elemId })', () => {
    const onAction = vi.fn();
    const m = makeModel('a', {
      elements: [{
        kind: 'actions',
        id: 'acts',
        data: { buttons: [{ id: 'go', label: 'Go' }] },
      }],
    });
    mount([m], { onAction });
    const btn = container.querySelector('[data-action-id="go"]') as HTMLButtonElement;
    btn.click();
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction.mock.calls[0]).toEqual(['a', 'action', { buttonId: 'go', elemId: 'acts' }]);
  });

  it('honors button.disabled (no click fires)', () => {
    const onAction = vi.fn();
    const m = makeModel('a', {
      elements: [{
        kind: 'actions',
        id: 'acts',
        data: { buttons: [{ id: 'go', label: 'Go', disabled: true }] },
      }],
    });
    mount([m], { onAction });
    const btn = container.querySelector('[data-action-id="go"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    btn.click();
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe('card-header refresh button → cfg.onRefresh', () => {
  it('refresh button is present only when cfg.onRefresh is provided', () => {
    const m1 = makeModel('a');
    mount([m1]); // no onRefresh
    expect(container.querySelector('[id$="-refresh"]')).toBeNull();

    // Fresh DOM
    container.innerHTML = '';
    delete (globalThis as any).LiveCard;
    LiveCard = loadLiveCards();
    container = document.createElement('div');
    document.body.appendChild(container);

    const onRefresh = vi.fn();
    mount([makeModel('a')], { onRefresh });
    const btn = container.querySelector('[id$="-refresh"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    expect(onRefresh).toHaveBeenCalledWith('a');
    expect(btn.disabled).toBe(true); // disabled immediately after click
  });
});

describe('notes element → cfg.onPatchState', () => {
  it('edits in the textarea + Save click patch state with { fieldValues: { notes } }', () => {
    const onPatchState = vi.fn();
    const m = makeModel('a', {
      elements: [{ kind: 'notes', id: 'n', data: { bind: 'card_data.notes' } }],
      card_data: { status: 'completed', lastRun: '2026-01-01T00:00:00Z', notes: 'initial' },
    });
    mount([m], { onPatchState });
    const ta = container.querySelector('.lc-notes-textarea') as HTMLTextAreaElement;
    expect(ta).toBeTruthy();
    expect(ta.value).toBe('initial');
    // Initially clean → Save hidden.
    expect((container.querySelector('.lc-n-save') as HTMLElement).classList.contains('d-none')).toBe(true);

    ta.value = 'edited content';
    ta.dispatchEvent(new Event('input'));

    const save = container.querySelector('.lc-n-save') as HTMLButtonElement;
    expect(save.classList.contains('d-none')).toBe(false);
    save.click();

    expect(onPatchState).toHaveBeenCalledTimes(1);
    expect(onPatchState.mock.calls[0]).toEqual(['a', { fieldValues: { notes: 'edited content' } }]);
  });
});

describe('editable-table element → cfg.onPatchState', () => {
  it('editing a cell and clicking Save patches state with { fieldValues: rows }', () => {
    const onPatchState = vi.fn();
    const m = makeModel('a', {
      elements: [{
        kind: 'editable-table',
        id: 'et',
        data: {
          bind: 'computed_values.rows',
          writeTo: 'card_data.rows',
          columns: ['name', 'qty'],
          addRow: false,
          deleteRow: false,
          schema: { properties: { qty: { type: 'number' } } },
        },
      }],
      computed_values: { rows: [{ name: 'a', qty: 1 }, { name: 'b', qty: 2 }] },
    });
    mount([m], { onPatchState });
    const cells = container.querySelectorAll('.lc-et-cell') as NodeListOf<HTMLInputElement>;
    expect(cells.length).toBe(4);
    // Find name cell of row 0
    const r0name = container.querySelector('.lc-et-cell[data-row="0"][data-col="name"]') as HTMLInputElement;
    r0name.value = 'updated-a';
    r0name.dispatchEvent(new Event('change'));

    const save = container.querySelector('.lc-et-save') as HTMLButtonElement;
    expect(save).toBeTruthy();
    expect(save.classList.contains('d-none')).toBe(false);
    save.click();

    expect(onPatchState).toHaveBeenCalledTimes(1);
    const [nid, payload] = onPatchState.mock.calls[0];
    expect(nid).toBe('a');
    expect(Array.isArray(payload.fieldValues)).toBe(true);
    expect(payload.fieldValues[0]).toEqual({ name: 'updated-a', qty: 1 });
    expect(payload.fieldValues[1]).toEqual({ name: 'b', qty: 2 });
  });
});

describe('todo element → cfg.onPatchState', () => {
  it('toggling a checkbox patches state with the updated items array', () => {
    const onPatchState = vi.fn();
    const m = makeModel('a', {
      elements: [{
        kind: 'todo',
        id: 'tdo',
        data: { bind: 'computed_values.items', writeTo: 'card_data.items' },
      }],
      computed_values: { items: [{ text: 'one', done: false }, { text: 'two', done: false }] },
    });
    mount([m], { onPatchState });
    const cbs = container.querySelectorAll('input[type="checkbox"][data-idx]') as NodeListOf<HTMLInputElement>;
    expect(cbs.length).toBe(2);
    cbs[0].checked = true;
    cbs[0].dispatchEvent(new Event('change'));

    expect(onPatchState).toHaveBeenCalled();
    const lastCall = onPatchState.mock.calls[onPatchState.mock.calls.length - 1];
    expect(lastCall[0]).toBe('a');
    expect(Array.isArray(lastCall[1].fieldValues)).toBe(true);
    expect(lastCall[1].fieldValues[0]).toEqual({ text: 'one', done: true });
  });
});

describe('public engine helpers', () => {
  it('getElement(nodeId, elemId) returns the rendered inner element', () => {
    const m = makeModel('a', {
      elements: [{ kind: 'metric', id: 'm1', label: 'X', data: { bind: 'computed_values.value' } }],
      computed_values: { value: 7 },
    });
    const engine = mount([m]);
    const el = engine.getElement('a', 'm1');
    expect(el).toBeTruthy();
    expect(el.querySelector('.lc-metric-value')).toBeTruthy();
    // Unknown ids return null.
    expect(engine.getElement('a', 'does-not-exist')).toBeNull();
    expect(engine.getElement('missing-node', 'm1')).toBeNull();
  });

  it('subscribe(nodeId, cb) is fired by notify(nodeId, data)', () => {
    const engine = mount([makeModel('a'), makeModel('b')]);
    const cb = vi.fn();
    const unsub = engine.subscribe('a', cb);
    engine.notify('a', { v: 1 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]).toEqual(['a', { v: 1 }]);
    engine.notify('b', { v: 2 }); // different node — should not fire 'a' cb
    expect(cb).toHaveBeenCalledTimes(1);
    unsub();
    engine.notify('a', { v: 3 });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('destroy(nodeId) clears element tracking so getElement returns null', () => {
    const m = makeModel('a', {
      elements: [{ kind: 'metric', id: 'm1', data: { bind: 'computed_values.value' } }],
      computed_values: { value: 1 },
    });
    const engine = mount([m]);
    expect(engine.getElement('a', 'm1')).toBeTruthy();
    engine.destroy('a');
    expect(engine.getElement('a', 'm1')).toBeNull();
  });

  it('getChatStateForCard reads card_chats from the resolved node', () => {
    const m = makeModel('a');
    m.card_chats = { messages: [{ role: 'user', text: 'hi' }], processing: true, receiving: true };
    const engine = mount([m]);
    const st = engine.getChatStateForCard('a');
    expect(st.processing).toBe(true);
    expect(st.receiving).toBe(true);
    expect(st.messages.length).toBe(1);
    expect(st.messages[0].text).toBe('hi');
    // Unknown card → empty default state.
    const empty = engine.getChatStateForCard('missing');
    expect(empty.messages).toEqual([]);
    expect(empty.receiving).toBe(false);
    expect(empty.processing).toBe(false);
  });

  it('isReceivingChatsForCard reflects card_chats.receiving', () => {
    const m = makeModel('a');
    m.card_chats = { messages: [], processing: false, receiving: true };
    const engine = mount([m]);
    expect(engine.isReceivingChatsForCard('a')).toBe(true);
    m.card_chats.receiving = false;
    expect(engine.isReceivingChatsForCard('a')).toBe(false);
    expect(engine.isReceivingChatsForCard('missing')).toBe(false);
  });

  it('start/stopReceivingChatsForCard delegate to cfg.startReceivingChats / stopReceivingChats', () => {
    const startSpy = vi.fn();
    const stopSpy = vi.fn();
    const engine = mount([makeModel('a')], { startReceivingChats: startSpy, stopReceivingChats: stopSpy });
    engine.startReceivingChatsForCard('a');
    engine.stopReceivingChatsForCard('a');
    expect(startSpy).toHaveBeenCalledWith('a');
    expect(stopSpy).toHaveBeenCalledWith('a');
  });
});
