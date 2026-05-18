// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Regression tests for the chat/files pane public surface on LiveCard.init(...):
//   - mountChatPane({container, cardId, ...})         -> { refresh, dispose }
//   - mountFilesUploadPane({container, cardId, ...})  -> { refresh, dispose }
//   - mountFilesListPane({container, cardId, ...})    -> { refresh, dispose }
//   - openChatModal / openFilesModal / appendChatMessage / onServerSseEvent
// All panes share builders with the modal; these tests pin the DOM contract
// and lifecycle so the modal code path can be refactored safely.

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

interface NodeModel {
  id: string;
  card: any;
  card_data: any;
  card_chats?: any;
}

function makeNode(id: string, opts: { messages?: any[]; files?: any[]; filesDisabled?: boolean; processing?: boolean; receiving?: boolean } = {}): NodeModel {
  return {
    id,
    card: { id, meta: { title: id } },
    card_data: {
      status: 'completed',
      files: opts.files || [],
      features: { files: { disabled: !!opts.filesDisabled } },
    },
    card_chats: {
      messages: opts.messages || [],
      processing: !!opts.processing,
      receiving: !!opts.receiving,
    },
  };
}

function makeEngine(nodes: Record<string, NodeModel>, overrides: any = {}) {
  return loadLiveCards().init({
    resolve: (id: string) => nodes[id] || null,
    fileUrlBase: '/api/boards/test',
    onAction: vi.fn(),
    onPatch: vi.fn(),
    onPatchState: vi.fn(),
    startReceivingChats: vi.fn(),
    stopReceivingChats: vi.fn(),
    ...overrides,
  });
}

beforeEach(() => {
  // Reset jsdom: fresh document body for each test (panes attach modal
  // backdrops directly to document.body the first time they open).
  document.body.innerHTML = '';
  delete (globalThis as any).LiveCard;
});

describe('LiveCard.init engine public surface', () => {
  it('exposes mount* / open* / SSE helpers on the returned engine', () => {
    const engine = makeEngine({ a: makeNode('a') });
    expect(typeof engine.mountChatPane).toBe('function');
    expect(typeof engine.mountFilesUploadPane).toBe('function');
    expect(typeof engine.mountFilesListPane).toBe('function');
    expect(typeof engine.openChatModal).toBe('function');
    expect(typeof engine.openFilesModal).toBe('function');
    expect(typeof engine.appendChatMessage).toBe('function');
    expect(typeof engine.onServerSseEvent).toBe('function');
    expect(typeof engine.destroyAll).toBe('function');
  });
});

describe('mountChatPane', () => {
  it('throws when container or cardId is missing', () => {
    const engine = makeEngine({ a: makeNode('a') });
    expect(() => engine.mountChatPane({})).toThrow(/container is required/);
    expect(() => engine.mountChatPane({ container: document.createElement('div') })).toThrow(/cardId is required/);
  });

  it('builds body + input row DOM with expected classes/data-attrs', () => {
    const engine = makeEngine({ a: makeNode('a', { messages: [{ role: 'user', text: 'hi' }] }) });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = engine.mountChatPane({ container: host, cardId: 'a' });
    try {
      const body = host.querySelector('.lc-chat-pane-body');
      const input = host.querySelector('[data-lc-chat-input]') as HTMLTextAreaElement | null;
      const send = host.querySelector('[data-lc-chat-send]');
      expect(body).toBeTruthy();
      expect(input).toBeTruthy();
      expect(send).toBeTruthy();
      // refresh() pulls messages from card_chats
      handle.refresh();
      const bubbles = host.querySelectorAll('.lc-chat-bubble');
      expect(bubbles.length).toBe(1);
      expect(bubbles[0].textContent || '').toContain('hi');
    } finally {
      handle.dispose();
    }
  });

  it('calls startReceivingChats on mount with the cardId, stopReceivingChats on dispose', () => {
    const startSpy = vi.fn();
    const stopSpy = vi.fn();
    const engine = makeEngine({ a: makeNode('a') }, { startReceivingChats: startSpy, stopReceivingChats: stopSpy });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = engine.mountChatPane({ container: host, cardId: 'a' });
    expect(startSpy).toHaveBeenCalledWith('a');
    handle.dispose();
    expect(stopSpy).toHaveBeenCalledWith('a');
  });

  it('autoSubscribe=false skips lifecycle hooks', () => {
    const startSpy = vi.fn();
    const stopSpy = vi.fn();
    const engine = makeEngine({ a: makeNode('a') }, { startReceivingChats: startSpy, stopReceivingChats: stopSpy });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = engine.mountChatPane({ container: host, cardId: 'a', autoSubscribe: false });
    expect(startSpy).not.toHaveBeenCalled();
    handle.dispose();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it('Send button invokes onAction(cardId, "chat-send", { text, files })', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const engine = makeEngine({ a: makeNode('a') }, { onAction });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = engine.mountChatPane({ container: host, cardId: 'a' });
    try {
      const input = host.querySelector('[data-lc-chat-input]') as HTMLTextAreaElement;
      const send = host.querySelector('[data-lc-chat-send]') as HTMLButtonElement;
      input.value = 'hello world';
      send.click();
      // sendMessage is async (awaits onAction); flush microtasks.
      await Promise.resolve();
      await Promise.resolve();
      expect(onAction).toHaveBeenCalledTimes(1);
      const [nodeId, kind, payload] = onAction.mock.calls[0];
      expect(nodeId).toBe('a');
      expect(kind).toBe('chat-send');
      expect(payload.text).toBe('hello world');
      expect(Array.isArray(payload.files)).toBe(true);
    } finally {
      handle.dispose();
    }
  });

  it('appendChatMessage updates an inline-mounted pane', () => {
    const engine = makeEngine({ a: makeNode('a') });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = engine.mountChatPane({ container: host, cardId: 'a' });
    try {
      engine.appendChatMessage('a', 'assistant', 'streamed token');
      const bubbles = host.querySelectorAll('.lc-chat-bubble');
      expect(bubbles.length).toBeGreaterThan(0);
      const last = bubbles[bubbles.length - 1];
      expect(last.textContent || '').toContain('streamed token');
      expect(last.className).toContain('lc-chat-bubble-assistant');
    } finally {
      handle.dispose();
    }
  });

  it('onServerSseEvent re-renders inline pane from updated card_chats', () => {
    const node = makeNode('a', { messages: [] });
    const engine = makeEngine({ a: node });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = engine.mountChatPane({ container: host, cardId: 'a' });
    try {
      // Empty initially (showEmptyState default true).
      expect((host.querySelector('.lc-chat-pane-body') as HTMLElement).textContent || '').toContain('No messages yet');
      node.card_chats.messages = [{ role: 'user', text: 'first' }, { role: 'assistant', text: 'second' }];
      engine.onServerSseEvent();
      const bubbles = host.querySelectorAll('.lc-chat-bubble');
      expect(bubbles.length).toBe(2);
      expect(bubbles[0].textContent || '').toContain('first');
      expect(bubbles[1].textContent || '').toContain('second');
    } finally {
      handle.dispose();
    }
  });

  it('disposed pane no longer receives appendChatMessage updates', () => {
    const engine = makeEngine({ a: makeNode('a') });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = engine.mountChatPane({ container: host, cardId: 'a' });
    handle.dispose();
    engine.appendChatMessage('a', 'assistant', 'should be ignored');
    expect(host.querySelectorAll('.lc-chat-bubble').length).toBe(0);
  });

  it('modal pane is inactive (skipped by appendChatMessage) when modal is closed but inline pane stays active', () => {
    const node = makeNode('a');
    const engine = makeEngine({ a: node });
    // Inline pane mounted but never opens modal
    const host = document.createElement('div');
    document.body.appendChild(host);
    const inline = engine.mountChatPane({ container: host, cardId: 'a' });
    try {
      // Force the modal pane to exist by opening then closing it.
      engine.openChatModal('a');
      const modalBackdrop = document.querySelector('.lc-chat-modal-backdrop') as HTMLElement;
      expect(modalBackdrop).toBeTruthy();
      modalBackdrop.classList.remove('lc-open'); // simulate close

      engine.appendChatMessage('a', 'assistant', 'inline-only');
      // Inline got the bubble
      expect(host.querySelectorAll('.lc-chat-bubble').length).toBeGreaterThan(0);
      // Modal body should NOT have received the message (modal not open).
      const modalBubbles = modalBackdrop.querySelectorAll('.lc-chat-bubble');
      expect(modalBubbles.length).toBe(0);
    } finally {
      inline.dispose();
    }
  });
});

describe('mountFilesListPane', () => {
  it('throws when container or cardId is missing', () => {
    const engine = makeEngine({ a: makeNode('a') });
    expect(() => engine.mountFilesListPane({})).toThrow(/container is required/);
    expect(() => engine.mountFilesListPane({ container: document.createElement('div') })).toThrow(/cardId is required/);
  });

  it('renders empty state when card has no files', () => {
    const engine = makeEngine({ a: makeNode('a', { files: [] }) });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = engine.mountFilesListPane({ container: host, cardId: 'a', livePoll: false });
    try {
      expect(host.textContent || '').toContain('No files uploaded yet');
      expect(host.querySelector('.list-group')).toBeNull();
    } finally {
      handle.dispose();
    }
  });

  it('honors custom emptyText', () => {
    const engine = makeEngine({ a: makeNode('a', { files: [] }) });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = engine.mountFilesListPane({
      container: host,
      cardId: 'a',
      emptyText: 'nothing here yet',
      livePoll: false,
    });
    try {
      expect(host.textContent || '').toContain('nothing here yet');
    } finally {
      handle.dispose();
    }
  });

  it('renders a list-group with download anchor per file using cfg.fileUrlBase', () => {
    const node = makeNode('a', {
      files: [
        { name: 'doc.pdf', size: 1234, stored_name: '0001-doc.pdf' },
        { name: 'data.csv', size: 5678, stored_name: '0002-data.csv' },
      ],
    });
    const engine = makeEngine({ a: node });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = engine.mountFilesListPane({ container: host, cardId: 'a', livePoll: false });
    try {
      const items = host.querySelectorAll('.list-group .list-group-item');
      expect(items.length).toBe(2);
      const links = host.querySelectorAll('.list-group a[href]');
      expect(links.length).toBe(2);
      const href0 = (links[0] as HTMLAnchorElement).getAttribute('href');
      expect(href0).toBe('/api/boards/test/cards/a/files/0?sn=' + encodeURIComponent('0001-doc.pdf'));
      expect((items[0].textContent || '')).toContain('doc.pdf');
      expect((items[0].textContent || '')).toContain('1234');
    } finally {
      handle.dispose();
    }
  });

  it('refresh() picks up files added to card_data after mount', () => {
    const node = makeNode('a', { files: [] });
    const engine = makeEngine({ a: node });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = engine.mountFilesListPane({ container: host, cardId: 'a', livePoll: false });
    try {
      expect(host.querySelector('.list-group')).toBeNull();
      node.card_data.files = [{ name: 'late.txt', size: 1, stored_name: 's-late.txt' }];
      handle.refresh();
      expect(host.querySelectorAll('.list-group .list-group-item').length).toBe(1);
    } finally {
      handle.dispose();
    }
  });
});

describe('mountFilesUploadPane', () => {
  it('throws when container or cardId is missing', () => {
    const engine = makeEngine({ a: makeNode('a') });
    expect(() => engine.mountFilesUploadPane({})).toThrow(/container is required/);
    expect(() => engine.mountFilesUploadPane({ container: document.createElement('div') })).toThrow(/cardId is required/);
  });

  it('renders dropzone with placeholder text', () => {
    const engine = makeEngine({ a: makeNode('a') });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = engine.mountFilesUploadPane({
      container: host,
      cardId: 'a',
      placeholder: 'Drop ingest sources here',
      livePoll: false,
    });
    try {
      const dz = host.querySelector('.lc-dropzone');
      expect(dz).toBeTruthy();
      expect(host.textContent || '').toContain('Drop ingest sources here');
    } finally {
      handle.dispose();
    }
  });

  it('embeds a files-list pane when showUploadedList is true (default)', () => {
    const engine = makeEngine({
      a: makeNode('a', {
        files: [{ name: 'a.txt', size: 1, stored_name: 's-a.txt' }],
      }),
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = engine.mountFilesUploadPane({ container: host, cardId: 'a', livePoll: false });
    try {
      // List-group from embedded list pane should appear inside the upload host.
      expect(host.querySelectorAll('.list-group .list-group-item').length).toBe(1);
      expect(host.querySelector('.lc-dropzone')).toBeTruthy();
    } finally {
      handle.dispose();
    }
  });

  it('omits the embedded list when showUploadedList=false', () => {
    const engine = makeEngine({
      a: makeNode('a', { files: [{ name: 'a.txt', size: 1, stored_name: 's-a.txt' }] }),
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = engine.mountFilesUploadPane({
      container: host,
      cardId: 'a',
      showUploadedList: false,
      livePoll: false,
    });
    try {
      expect(host.querySelector('.list-group')).toBeNull();
      expect(host.querySelector('.lc-dropzone')).toBeTruthy();
    } finally {
      handle.dispose();
    }
  });

  it('marks dropzone disabled when card_data.features.files.disabled is true', () => {
    const engine = makeEngine({ a: makeNode('a', { filesDisabled: true }) });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const handle = engine.mountFilesUploadPane({ container: host, cardId: 'a', livePoll: false });
    try {
      const dz = host.querySelector('.lc-dropzone') as HTMLElement;
      expect(dz).toBeTruthy();
      expect(dz.classList.contains('lc-disabled')).toBe(true);
    } finally {
      handle.dispose();
    }
  });
});

describe('openFilesModal / openChatModal compose the same panes', () => {
  it('openFilesModal attaches a backdrop and binds list+upload panes to the card', () => {
    const engine = makeEngine({
      a: makeNode('a', { files: [{ name: 'one.txt', size: 7, stored_name: 's-one.txt' }] }),
    });
    engine.openFilesModal('a');
    const backdrop = document.querySelector('.lc-files-modal-backdrop') as HTMLElement;
    expect(backdrop).toBeTruthy();
    expect(backdrop.classList.contains('lc-open')).toBe(true);
    // List pane is hoisted into the modal body — file should be visible there.
    const body = backdrop.querySelector('[data-lc-files-body]') as HTMLElement;
    expect(body).toBeTruthy();
    expect(body.querySelectorAll('.list-group .list-group-item').length).toBe(1);
    // Footer hosts the upload pane.
    const footer = backdrop.querySelector('[data-lc-files-footer]') as HTMLElement;
    expect(footer).toBeTruthy();
    expect(footer.querySelector('.lc-dropzone')).toBeTruthy();
  });

  it('openChatModal builds the modal pane and renders messages', () => {
    const engine = makeEngine({
      a: makeNode('a', { messages: [{ role: 'user', text: 'hello modal' }] }),
    });
    engine.openChatModal('a');
    const backdrop = document.querySelector('.lc-chat-modal-backdrop') as HTMLElement;
    expect(backdrop).toBeTruthy();
    expect(backdrop.classList.contains('lc-open')).toBe(true);
    const bubbles = backdrop.querySelectorAll('.lc-chat-bubble');
    expect(bubbles.length).toBe(1);
    expect(bubbles[0].textContent || '').toContain('hello modal');
  });
});

describe('destroyAll', () => {
  it('disposes all registered chat + files panes without throwing', () => {
    const engine = makeEngine({ a: makeNode('a') });
    const c1 = document.createElement('div');
    const c2 = document.createElement('div');
    const c3 = document.createElement('div');
    document.body.append(c1, c2, c3);
    engine.mountChatPane({ container: c1, cardId: 'a' });
    engine.mountFilesUploadPane({ container: c2, cardId: 'a', livePoll: false });
    engine.mountFilesListPane({ container: c3, cardId: 'a', livePoll: false });
    expect(() => engine.destroyAll()).not.toThrow();
    // After destroyAll, appendChatMessage on the disposed pane should be a no-op.
    engine.appendChatMessage('a', 'assistant', 'after destroy');
    expect(c1.querySelectorAll('.lc-chat-bubble').length).toBe(0);
  });
});
