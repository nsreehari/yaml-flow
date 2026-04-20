import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  initBoard, loadBoard, loadBoardEnvelope, saveBoard, cli,
  liveCardToTaskConfig,
  readCardInventory, lookupCardPath, appendCardInventory,
  BoardJournal, appendEventToJournal, getUndrainedEntries,
} from '../../src/cli/board-live-cards-cli.js';
import type { BoardLiveCard, CardInventoryEntry, BoardEnvelope, JournalEntry } from '../../src/cli/board-live-cards-cli.js';
import { createReactiveGraph, createLiveGraph, snapshot } from '../../src/continuous-event-graph/index.js';
import type { ReactiveGraph } from '../../src/continuous-event-graph/index.js';
import type { GraphConfig } from '../../src/event-graph/types.js';

process.env.BOARD_LIVE_CARDS_NO_SPAWN = '1';

const ts = () => new Date().toISOString();
const ticks = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Poll loadBoard until predicate passes or timeout. */
async function pollBoard(dir: string, pred: (tasks: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = loadBoard(dir);
    if (pred(live.config.tasks as Record<string, unknown>)) return;
    await ticks(100);
  }
  throw new Error('pollBoard timed out');
}

// ============================================================================
// Board persistence (envelope format)
// ============================================================================

describe('board-live-cards', () => {
  let tmpDir: string;
  let rg: ReactiveGraph | null = null;

  function freshDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-test-'));
    return tmpDir;
  }

  afterEach(() => {
    rg?.dispose();
    rg = null;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initBoard creates dir and board-graph.json with envelope format', () => {
    const dir = freshDir();
    const sub = path.join(dir, 'nested');
    const result = initBoard(sub);

    expect(result).toBe('created');
    expect(fs.existsSync(path.join(sub, 'board-graph.json'))).toBe(true);

    const envelope: BoardEnvelope = JSON.parse(fs.readFileSync(path.join(sub, 'board-graph.json'), 'utf-8'));
    expect(envelope.lastDrainedJournalId).toBe('');
    expect(envelope.graph.version).toBe(1);
    expect(Object.keys(envelope.graph.config.tasks)).toHaveLength(0);
  });

  it('initBoard is idempotent — returns exists on second call', () => {
    const dir = freshDir();
    const sub = path.join(dir, 'nested');
    expect(initBoard(sub)).toBe('created');
    expect(initBoard(sub)).toBe('exists');
  });

  it('initBoard throws if dir is non-empty without valid board-graph.json', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, 'some-file.txt'), 'hello');
    expect(() => initBoard(dir)).toThrow('not empty');
  });

  it('loadBoardEnvelope returns the full envelope', () => {
    const dir = freshDir();
    initBoard(path.join(dir, 'b'));
    const envelope = loadBoardEnvelope(path.join(dir, 'b'));
    expect(envelope.lastDrainedJournalId).toBe('');
    expect(envelope.graph.version).toBe(1);
  });

  it('loadBoard returns a LiveGraph from board-graph.json', () => {
    const dir = freshDir();
    initBoard(path.join(dir, 'b'));
    const live = loadBoard(path.join(dir, 'b'));
    expect(Object.keys(live.config.tasks)).toHaveLength(0);
  });

  it('full roundtrip: init → addNode → run → save → load → state preserved', async () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(dir);

    const live = loadBoard(dir);
    const journalPath = path.join(dir, 'board-journal.jsonl');
    const journal = new BoardJournal(journalPath, '');
    const gRef = { rg: null as ReactiveGraph | null };

    rg = createReactiveGraph(live, {
      handlers: {
        src: async ({ callbackToken }) => { gRef.rg!.resolveCallback(callbackToken, { v: 1 }); return 'task-initiated'; },
        calc: async ({ callbackToken }) => { gRef.rg!.resolveCallback(callbackToken, { result: 42 }); return 'task-initiated'; },
      },
      journal,
    });
    gRef.rg = rg;

    rg.addNode('src', { provides: ['x'], taskHandlers: ['src'] } as any);
    rg.addNode('calc', { requires: ['x'], provides: ['y'], taskHandlers: ['calc'] } as any);

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(100);

    expect(rg.getState().state.tasks.src.status).toBe('completed');
    expect(rg.getState().state.tasks.calc.status).toBe('completed');

    saveBoard(dir, rg, journal);
    rg.dispose();

    // Load again — state intact
    const live2 = loadBoard(dir);
    expect(live2.state.tasks.src.status).toBe('completed');
    expect(live2.state.tasks.src.data).toEqual({ v: 1 });
    expect(live2.state.tasks.calc.status).toBe('completed');
    expect(live2.state.tasks.calc.data).toEqual({ result: 42 });

    // No external journal drain happened in this roundtrip, so the pointer stays empty.
    const envelope = loadBoardEnvelope(dir);
    expect(envelope.lastDrainedJournalId).toBe('');
  });
});

// ============================================================================
// CLI commands
// ============================================================================

describe('board-live-cards CLI', () => {
  let tmpDir: string;

  function freshDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-cli-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('cli init <dir> creates an empty board', () => {
    const dir = path.join(freshDir(), 'myboard');
    cli(['init', dir]);

    expect(fs.existsSync(path.join(dir, 'board-graph.json'))).toBe(true);
    const live = loadBoard(dir);
    expect(Object.keys(live.config.tasks)).toHaveLength(0);
  });

  it('cli init <dir> twice is idempotent', () => {
    const dir = path.join(freshDir(), 'myboard');

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    cli(['init', dir]);
    cli(['init', dir]);
    spy.mockRestore();

    expect(logs[0]).toContain('initialized');
    expect(logs[1]).toContain('already initialized');
  });

  it('cli status --rg <dir> prints task info', () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(dir);

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    cli(['status', '--rg', dir]);
    spy.mockRestore();

    const output = logs.join('\n');
    expect(output).toContain('Tasks: 0');
    expect(output).toContain('0 eligible');
  });

  it('cli status --rg <dir> --json prints stable status object', () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(dir);

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));

    cli(['status', '--rg', dir, '--json']);
    spy.mockRestore();

    const output = logs.join('\n').trim();
    const parsed = JSON.parse(output) as {
      schema_version: string;
      board: { path: string };
      summary: { task_count: number };
      schedule: { eligible: number; pending: number; blocked: number; unresolved: number };
      tasks: unknown[];
    };

    expect(parsed.schema_version).toBe('v1');
    expect(parsed.board.path).toContain(path.resolve(dir));
    expect(parsed.summary.task_count).toBe(0);
    expect(parsed.schedule).toEqual({ eligible: 0, pending: 0, blocked: 0, unresolved: 0 });
    expect(parsed.tasks).toEqual([]);
  });
});

// ============================================================================
// liveCardToTaskConfig — single 'card-handler' for all types
// ============================================================================

describe('liveCardToTaskConfig', () => {
  it('card with sources → [card-handler]', () => {
    const card: BoardLiveCard = {
      id: 'prices',
      provides: [{ bindTo: 'prices', src: 'state.prices' }],
      sources: [{ cli: 'fetch.sh', bindTo: 'raw' }],
      state: { prices: {} },
    };
    const tc = liveCardToTaskConfig(card);
    expect(tc.taskHandlers).toEqual(['card-handler']);
    expect(tc.provides).toEqual(['prices']);
    expect(tc.requires).toBeUndefined();
  });

  it('card with compute → [card-handler]', () => {
    const card: BoardLiveCard = {
      id: 'total',
      requires: ['prices'],
      compute: [{ bindTo: 'sum', expr: '$sum(state.data.value)' }],
      state: {},
    };
    const tc = liveCardToTaskConfig(card);
    expect(tc.taskHandlers).toEqual(['card-handler']);
    expect(tc.requires).toEqual(['prices']);
    expect(tc.provides).toEqual(['total']);
  });

  it('card with optional source → still just [card-handler]', () => {
    const card: BoardLiveCard = {
      id: 'enriched',
      requires: ['raw'],
      compute: [{ bindTo: 'x', expr: '$sum(state.raw.v)' }],
      sources: [{ bindTo: 'extra', outputFile: 'extra.json', optional: true }],
      state: {},
    };
    const tc = liveCardToTaskConfig(card);
    expect(tc.taskHandlers).toEqual(['card-handler']);
  });

  it('card with required + optional sources → still just [card-handler]', () => {
    const card: BoardLiveCard = {
      id: 'live-feed',
      sources: [
        { cli: 'feed.sh', bindTo: 'data', outputFile: 'data.json' },
        { cli: 'enrich.sh', bindTo: 'extra', outputFile: 'extra.json', optional: true },
      ],
      state: {},
    };
    const tc = liveCardToTaskConfig(card);
    expect(tc.taskHandlers).toEqual(['card-handler']);
  });

  it('minimal card (just id) → [card-handler]', () => {
    const card: BoardLiveCard = {
      id: 'custom',
      state: {},
    };
    const tc = liveCardToTaskConfig(card);
    expect(tc.taskHandlers).toEqual(['card-handler']);
  });

  it('provides keys from card.provides', () => {
    const card: BoardLiveCard = {
      id: 'multi',
      provides: [{ bindTo: 'alpha', src: 'state.alpha' }, { bindTo: 'beta', src: 'state.beta' }],
      state: {},
    };
    const tc = liveCardToTaskConfig(card);
    expect(tc.provides).toEqual(['alpha', 'beta']);
  });

  it('falls back to [card.id] when no provides', () => {
    const card: BoardLiveCard = {
      id: 'standalone',
      state: {},
    };
    const tc = liveCardToTaskConfig(card);
    expect(tc.provides).toEqual(['standalone']);
  });

  it('maps meta.title to description', () => {
    const card: BoardLiveCard = {
      id: 'x',
      meta: { title: 'My Title' },
      state: {},
    };
    const tc = liveCardToTaskConfig(card);
    expect(tc.description).toBe('My Title');
  });
});

// ============================================================================
// BoardJournal
// ============================================================================

describe('BoardJournal', () => {
  let tmpDir: string;

  function freshDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-test-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('append writes JSONL entries with GUID ids', () => {
    const dir = freshDir();
    const journalPath = path.join(dir, 'journal.jsonl');
    const journal = new BoardJournal(journalPath, '');

    journal.append({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    journal.append({ type: 'inject-tokens', tokens: [], timestamp: ts() });

    const lines = fs.readFileSync(journalPath, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const entry0: JournalEntry = JSON.parse(lines[0]);
    const entry1: JournalEntry = JSON.parse(lines[1]);
    expect(entry0.id).toBeTruthy();
    expect(entry1.id).toBeTruthy();
    expect(entry0.id).not.toBe(entry1.id);
    expect(entry0.event.type).toBe('inject-tokens');
  });

  it('drain returns all events when no lastDrainedId', () => {
    const dir = freshDir();
    const journalPath = path.join(dir, 'journal.jsonl');
    const journal = new BoardJournal(journalPath, '');

    journal.append({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    journal.append({ type: 'inject-tokens', tokens: ['a'], timestamp: ts() });

    const events = journal.drain();
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('inject-tokens');
  });

  it('drain returns only undrained events after partial drain', () => {
    const dir = freshDir();
    const journalPath = path.join(dir, 'journal.jsonl');
    const journal = new BoardJournal(journalPath, '');

    journal.append({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    const first = journal.drain();
    expect(first).toHaveLength(1);

    journal.append({ type: 'inject-tokens', tokens: ['x'], timestamp: ts() });
    const second = journal.drain();
    expect(second).toHaveLength(1);
  });

  it('drain returns [] when journal file does not exist', () => {
    const dir = freshDir();
    const journalPath = path.join(dir, 'nonexistent.jsonl');
    const journal = new BoardJournal(journalPath, '');
    expect(journal.drain()).toEqual([]);
  });

  it('size returns count of undrained entries', () => {
    const dir = freshDir();
    const journalPath = path.join(dir, 'journal.jsonl');
    const journal = new BoardJournal(journalPath, '');

    expect(journal.size).toBe(0);
    journal.append({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    expect(journal.size).toBe(1);
    journal.drain();
    expect(journal.size).toBe(0);
    journal.append({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    journal.append({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    expect(journal.size).toBe(2);
  });

  it('constructor with lastDrainedJournalId skips already-drained entries', () => {
    const dir = freshDir();
    const journalPath = path.join(dir, 'journal.jsonl');

    // Write 3 entries manually
    const j1 = new BoardJournal(journalPath, '');
    j1.append({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    j1.append({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    j1.append({ type: 'inject-tokens', tokens: [], timestamp: ts() });

    // Drain first 2
    j1.drain(); // drains all 3, but let's use a different approach
    const lastId = j1.lastDrainedJournalId;

    // Create new journal starting from lastId — should see nothing new
    const j2 = new BoardJournal(journalPath, lastId);
    expect(j2.drain()).toEqual([]);

    // Append one more — should see only that
    j2.append({ type: 'inject-tokens', tokens: ['new'], timestamp: ts() });
    expect(j2.drain()).toHaveLength(1);
  });
});

// ============================================================================
// appendEventToJournal + getUndrainedEntries
// ============================================================================

describe('appendEventToJournal + getUndrainedEntries', () => {
  let tmpDir: string;

  function freshDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-standalone-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appendEventToJournal blind-appends without reading', () => {
    const dir = freshDir();
    appendEventToJournal(dir, { type: 'inject-tokens', tokens: [], timestamp: ts() });
    appendEventToJournal(dir, { type: 'inject-tokens', tokens: ['a'], timestamp: ts() });

    const entries = getUndrainedEntries(dir, '');
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBeTruthy();
    expect(entries[1].id).toBeTruthy();
    expect(entries[0].id).not.toBe(entries[1].id);
  });

  it('getUndrainedEntries returns [] for no journal file', () => {
    const dir = freshDir();
    expect(getUndrainedEntries(dir, '')).toEqual([]);
  });

  it('getUndrainedEntries filters by lastDrainedId', () => {
    const dir = freshDir();
    appendEventToJournal(dir, { type: 'inject-tokens', tokens: [], timestamp: ts() });
    appendEventToJournal(dir, { type: 'inject-tokens', tokens: [], timestamp: ts() });
    appendEventToJournal(dir, { type: 'inject-tokens', tokens: [], timestamp: ts() });

    const all = getUndrainedEntries(dir, '');
    expect(all).toHaveLength(3);

    // Skip first two
    const afterSecond = getUndrainedEntries(dir, all[1].id);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].id).toBe(all[2].id);

    // Skip all
    const afterLast = getUndrainedEntries(dir, all[2].id);
    expect(afterLast).toHaveLength(0);
  });
});

// ============================================================================
// Cards inventory
// ============================================================================

describe('cards-inventory', () => {
  let tmpDir: string;

  function freshDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inventory-test-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('readCardInventory returns [] when no file exists', () => {
    const dir = freshDir();
    expect(readCardInventory(dir)).toEqual([]);
  });

  it('appendCardInventory + readCardInventory roundtrip', () => {
    const dir = freshDir();
    appendCardInventory(dir, { cardId: 'a', cardFilePath: '/abs/a.json', addedAt: '2026-01-01T00:00:00Z' });
    appendCardInventory(dir, { cardId: 'b', cardFilePath: '/abs/b.json', addedAt: '2026-01-02T00:00:00Z' });

    const entries = readCardInventory(dir);
    expect(entries).toHaveLength(2);
    expect(entries[0].cardId).toBe('a');
    expect(entries[0].cardFilePath).toBe('/abs/a.json');
    expect(entries[1].cardId).toBe('b');
  });

  it('lookupCardPath returns path for known card', () => {
    const dir = freshDir();
    appendCardInventory(dir, { cardId: 'x', cardFilePath: '/some/x.json', addedAt: '2026-01-01T00:00:00Z' });
    expect(lookupCardPath(dir, 'x')).toBe('/some/x.json');
  });

  it('lookupCardPath returns null for unknown card', () => {
    const dir = freshDir();
    expect(lookupCardPath(dir, 'missing')).toBeNull();
  });
});

// ============================================================================
// CLI add-cards
// ============================================================================

describe('cli add-cards', () => {
  let tmpDir: string;

  function freshDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'addcard-test-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds a card to the board and inventory', async () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(dir);

    const cardFile = path.join(tmpDir, 'my-source.json');
    const card: BoardLiveCard = {
      id: 'prices',
      provides: [{ bindTo: 'prices', src: 'state.prices' }],
      source: { kind: 'api', bindTo: 'state.prices', url_template: 'https://example.com/prices' },
      state: { prices: {} },
    };
    fs.writeFileSync(cardFile, JSON.stringify(card));

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    cli(['add-cards', '--rg', dir, '--card', cardFile]);
    spy.mockRestore();

    // Wait for background try-drain to settle the board
    await pollBoard(dir, t => !!t['prices']);

    const live = loadBoard(dir);
    expect(live.config.tasks.prices).toBeDefined();
    expect(live.config.tasks.prices.taskHandlers).toEqual(['card-handler']);
    expect(live.config.tasks.prices.provides).toEqual(['prices']);

    const inv = readCardInventory(dir);
    expect(inv).toHaveLength(1);
    expect(inv[0].cardId).toBe('prices');
    expect(inv[0].cardFilePath).toBe(path.resolve(cardFile));

    expect(logs.join('\n')).toContain('Card "prices" added');
  });

  it('adds a card with compute + optional source (single card-handler)', async () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(dir);

    const cardFile = path.join(tmpDir, 'enriched.json');
    const card: BoardLiveCard = {
      id: 'enriched',
      requires: ['raw'],
      compute: [{ bindTo: 'total', expr: '$sum(state.raw.v)' }],
      sources: [{ bindTo: 'extra', outputFile: 'extra.json', optional: true }],
      state: {},
    };
    fs.writeFileSync(cardFile, JSON.stringify(card));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['add-cards', '--rg', dir, '--card', cardFile]);
    spy.mockRestore();

    await pollBoard(dir, t => !!t['enriched']);

    const live = loadBoard(dir);
    expect(live.config.tasks.enriched.taskHandlers).toEqual(['card-handler']);
    expect(live.config.tasks.enriched.requires).toEqual(['raw']);
  });

  it('rejects duplicate card id', async () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(dir);

    const cardFile = path.join(tmpDir, 'dup.json');
    fs.writeFileSync(cardFile, JSON.stringify({ id: 'x', state: {} }));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['add-cards', '--rg', dir, '--card', cardFile]);
    spy.mockRestore();

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as any);
    await expect(cli(['add-cards', '--rg', dir, '--card', cardFile])).rejects.toThrow('exit');
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

// ============================================================================
// CLI add-cards (glob)
// ============================================================================

describe('cli add-cards with --card-glob', () => {
  let tmpDir: string;

  function freshDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'addmulti-test-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('adds multiple cards using a glob pattern', async () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(dir);

    const cardsDir = path.join(tmpDir, 'cards');
    fs.mkdirSync(cardsDir, { recursive: true });
    fs.writeFileSync(path.join(cardsDir, 'a.json'), JSON.stringify({ id: 'a', state: {} }));
    fs.writeFileSync(path.join(cardsDir, 'b.json'), JSON.stringify({ id: 'b', state: {} }));

    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    cli(['add-cards', '--rg', dir, '--card-glob', path.join(cardsDir, '*.json')]);
    spy.mockRestore();

    await pollBoard(dir, t => !!t['a'] && !!t['b']);

    const live = loadBoard(dir);
    expect(live.config.tasks.a).toBeDefined();
    expect(live.config.tasks.b).toBeDefined();

    const inv = readCardInventory(dir);
    expect(inv.map(e => e.cardId).sort()).toEqual(['a', 'b']);
    expect(logs.join('\n')).toContain('Added 2 cards from glob');
  });

  it('rejects when glob matches no files', async () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(dir);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as any);
    await expect(cli(['add-cards', '--rg', dir, '--card-glob', path.join(tmpDir, 'nope', '*.json')])).rejects.toThrow('exit');
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

// ============================================================================
// CLI remove-card
// ============================================================================

describe('cli remove-card', () => {
  let tmpDir: string;

  function freshDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmcard-test-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('removes a card that was previously added', async () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(dir);

    const cardFile = path.join(tmpDir, 'temp.json');
    fs.writeFileSync(cardFile, JSON.stringify({ id: 'temp', state: {} }));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['add-cards', '--rg', dir, '--card', cardFile]);
    spy.mockRestore();

    await pollBoard(dir, t => !!t['temp']);

    const logs: string[] = [];
    const spy2 = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    cli(['remove-card', '--rg', dir, '--id', 'temp']);
    spy2.mockRestore();

    await cli(['process-accumulated-events', '--rg', dir, '--inline-loop']);

    await pollBoard(dir, t => !t['temp']);
    expect(logs.join('\n')).toContain('removed');
  });
});

// ============================================================================
// CLI update-card
// ============================================================================

describe('cli update-card', () => {
  let tmpDir: string;

  function freshDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'updatecard-test-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('updates a card config via upsert (no restart by default)', async () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(dir);

    const cardFile = path.join(tmpDir, 'my-card.json');
    const card: BoardLiveCard = {
      id: 'prices',
      provides: [{ bindTo: 'prices', src: 'state.prices' }],
      state: { prices: {} },
    };
    fs.writeFileSync(cardFile, JSON.stringify(card));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['add-cards', '--rg', dir, '--card', cardFile]);
    spy.mockRestore();

    await pollBoard(dir, t => !!t['prices']);

    const updatedCard: BoardLiveCard = {
      id: 'prices',
      provides: [{ bindTo: 'prices', src: 'state.prices' }, { bindTo: 'rates', src: 'state.rates' }],
      state: { prices: {}, rates: {} },
    };
    fs.writeFileSync(cardFile, JSON.stringify(updatedCard));

    const logs: string[] = [];
    const spy2 = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    cli(['update-card', '--rg', dir, '--card-id', 'prices']);
    spy2.mockRestore();

    await cli(['process-accumulated-events', '--rg', dir, '--inline-loop']);

    await pollBoard(dir, t => (t['prices'] as any)?.provides?.length === 2);

    const live = loadBoard(dir);
    expect(live.config.tasks.prices.provides).toEqual(['prices', 'rates']);
    expect(logs.join('\n')).toContain('updated');
    expect(logs.join('\n')).not.toContain('restarted');
  });

  it('updates a card config and restarts with --restart flag', () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(dir);

    const cardFile = path.join(tmpDir, 'my-card.json');
    fs.writeFileSync(cardFile, JSON.stringify({
      id: 'src',
      provides: [{ bindTo: 'src', src: 'state.src' }],
      state: {},
    }));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['add-cards', '--rg', dir, '--card', cardFile]);
    spy.mockRestore();

    // Run update-card with --restart
    const logs: string[] = [];
    const spy2 = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    cli(['update-card', '--rg', dir, '--card-id', 'src', '--restart']);
    spy2.mockRestore();

    expect(logs.join('\n')).toContain('restarted');
  });

  it('rejects unknown card-id', async () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(dir);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as any);
    await expect(cli(['update-card', '--rg', dir, '--card-id', 'nope'])).rejects.toThrow('exit');
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});

// ============================================================================
// CLI retrigger
// ============================================================================

describe('cli retrigger', () => {
  let tmpDir: string;

  function freshDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retrigger-test-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('appends task-restart event and drains', () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(dir);

    // Add a card so the task exists
    const cardFile = path.join(tmpDir, 'src.json');
    fs.writeFileSync(cardFile, JSON.stringify({ id: 'src', state: {} }));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['add-cards', '--rg', dir, '--card', cardFile]);
    spy.mockRestore();

    // Retrigger
    const logs: string[] = [];
    const spy2 = vi.spyOn(console, 'log').mockImplementation((...args) => logs.push(args.join(' ')));
    cli(['retrigger', '--rg', dir, '--task', 'src']);
    spy2.mockRestore();

    expect(logs.join('\n')).toContain('retriggered');
  });
});

// ============================================================================
// Windows launcher regression
// ============================================================================

describe('windows launcher behavior', () => {
  it('keeps the repo CLI wrapper hidden on Windows fallback launches', () => {
    const wrapper = fs.readFileSync(path.join(repoRoot, 'board-live-cards-cli.js'), 'utf-8');
    expect(wrapper).toContain('windowsHide: true');
  });

  it('keeps the portfolio tracker launches hidden on Windows', () => {
    const tracker = fs.readFileSync(path.join(repoRoot, 'examples', 'board-live-cards', 'portfolio-tracker', 'portfolio-tracker.js'), 'utf-8');
    expect(tracker).toContain('windowsHide: true');
  });

  it('keeps CLI child-process launches hidden on Windows', () => {
    const cliSource = fs.readFileSync(path.join(repoRoot, 'src', 'cli', 'board-live-cards-cli.ts'), 'utf-8');
    expect(cliSource).toContain('windowsHide: true');
    expect((cliSource.match(/windowsHide: true/g) ?? []).length).toBeGreaterThanOrEqual(7);
  });
});
