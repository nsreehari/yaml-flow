import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

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
const boardStatusSchema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'schema', 'board-status.schema.json'), 'utf-8'),
) as object;
const cardRuntimeSchema = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'schema', 'card-runtime.schema.json'), 'utf-8'),
) as object;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateBoardStatusArtifact = ajv.compile(boardStatusSchema);
const validateCardRuntimeArtifact = ajv.compile(cardRuntimeSchema);

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

async function pollForFile(filePath: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await ticks(100);
  }
  throw new Error(`pollForFile timed out: ${filePath}`);
}

function schemaErrors(validate: { errors?: Array<{ instancePath?: string; message?: string }> }): string {
  return (validate.errors ?? [])
    .map((err) => `${err.instancePath || '/'}: ${err.message || 'unknown error'}`)
    .join('\n');
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

  it('cli init <dir> writes default runtime-out registration and status snapshot', () => {
    const dir = path.join(freshDir(), 'board');
    cli(['init', dir]);

    const runtimeOutFile = path.join(dir, '.runtime-out');
    const runtimeOutDir = path.join(dir, 'runtime-out');
    const statusFile = path.join(runtimeOutDir, 'board-livegraph-status.json');

    expect(fs.readFileSync(runtimeOutFile, 'utf-8').trim()).toBe(runtimeOutDir);
    expect(fs.existsSync(statusFile)).toBe(true);

    const status = JSON.parse(fs.readFileSync(statusFile, 'utf-8')) as {
      meta: { board: { path: string } };
      summary: { card_count: number };
      cards: unknown[];
    };

    expect(status.meta.board.path).toContain(path.resolve(dir));
    expect(status.summary.card_count).toBe(0);
    expect(status.cards).toEqual([]);
    expect(validateBoardStatusArtifact(status), schemaErrors(validateBoardStatusArtifact)).toBe(true);
  });

  it('cli init <dir> with --runtime-out uses the configured directory for published status', () => {
    const dir = path.join(freshDir(), 'board');
    const runtimeOutDir = path.join(tmpDir, 'published-runtime');
    cli(['init', dir, '--runtime-out', runtimeOutDir]);

    expect(fs.readFileSync(path.join(dir, '.runtime-out'), 'utf-8').trim()).toBe(runtimeOutDir);
    expect(fs.existsSync(path.join(runtimeOutDir, 'board-livegraph-status.json'))).toBe(true);
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
      meta: {
        board: { path: string };
      };
      summary: {
        card_count: number;
        completed: number;
        eligible: number;
        pending: number;
        blocked: number;
        unresolved: number;
      };
      cards: unknown[];
    };

    expect(parsed.schema_version).toBe('v1');
    expect(parsed.meta.board.path).toContain(path.resolve(dir));
    expect(parsed.summary.card_count).toBe(0);
    expect(parsed.summary.completed).toBe(0);
    expect(parsed.summary).toMatchObject({ eligible: 0, pending: 0, blocked: 0, unresolved: 0 });
    expect(parsed.cards).toEqual([]);
  });

  it('publishes computed values under the configured runtime-out cards directory', async () => {
    const dir = path.join(freshDir(), 'board');
    const runtimeOutDir = path.join(tmpDir, 'runtime-publish');
    cli(['init', dir, '--runtime-out', runtimeOutDir]);

    const cardFile = path.join(tmpDir, 'totals.json');
    const card: BoardLiveCard = {
      id: 'totals',
      compute: [{ bindTo: 'total', expr: '$sum(card_data.data.v)' }],
      provides: [{ bindTo: 'totals', src: 'computed_values.total' }],
      card_data: {
        data: [{ v: 10 }, { v: 20 }, { v: 5 }],
      },
    };
    fs.writeFileSync(cardFile, JSON.stringify(card));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['upsert-card', '--rg', dir, '--card', cardFile]);
    spy.mockRestore();

    await pollBoard(dir, t => !!t['totals']);

    const computedFile = path.join(runtimeOutDir, 'cards', 'totals.computed.json');
    await pollForFile(computedFile);

    const computed = JSON.parse(fs.readFileSync(computedFile, 'utf-8')) as { schema_version: string; card_id: string; computed_values: { total: number } };
    expect(computed.schema_version).toBe('v1');
    expect(computed.card_id).toBe('totals');
    expect(computed.computed_values).toEqual({ total: 35 });
    expect(validateCardRuntimeArtifact(computed), schemaErrors(validateCardRuntimeArtifact)).toBe(true);

    const statusFile = path.join(runtimeOutDir, 'board-livegraph-status.json');
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf-8')) as object;
    expect(validateBoardStatusArtifact(status), schemaErrors(validateBoardStatusArtifact)).toBe(true);
  });
});

// ============================================================================
// liveCardToTaskConfig — single 'card-handler' for all types
// ============================================================================

describe('liveCardToTaskConfig', () => {
  it('card with sources → [card-handler]', () => {
    const card: BoardLiveCard = {
      id: 'prices',
      provides: [{ bindTo: 'prices', src: 'card_data.prices' }],
      sources: [{ cli: 'fetch.sh', bindTo: 'raw', outputFile: 'raw.json' }],
      card_data: { prices: {} },
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
      compute: [{ bindTo: 'sum', expr: '$sum(card_data.data.value)' }],
      card_data: {},
    };
    const tc = liveCardToTaskConfig(card);
    expect(tc.taskHandlers).toEqual(['card-handler']);
    expect(tc.requires).toEqual(['prices']);
    expect(tc.provides).toEqual([]);
  });

  it('card with non-gating source → still just [card-handler]', () => {
    const card: BoardLiveCard = {
      id: 'enriched',
      requires: ['raw'],
      compute: [{ bindTo: 'x', expr: '$sum(card_data.raw.v)' }],
      sources: [{ bindTo: 'extra', outputFile: 'extra.json', optionalForCompletionGating: true }],
      card_data: {},
    };
    const tc = liveCardToTaskConfig(card);
    expect(tc.taskHandlers).toEqual(['card-handler']);
  });

  it('card with required + non-gating sources → still just [card-handler]', () => {
    const card: BoardLiveCard = {
      id: 'live-feed',
      sources: [
        { cli: 'feed.sh', bindTo: 'data', outputFile: 'data.json' },
        { cli: 'enrich.sh', bindTo: 'extra', outputFile: 'extra.json', optionalForCompletionGating: true },
      ],
      card_data: {},
    };
    const tc = liveCardToTaskConfig(card);
    expect(tc.taskHandlers).toEqual(['card-handler']);
  });

  it('minimal card (just id) → [card-handler]', () => {
    const card: BoardLiveCard = {
      id: 'custom',
      card_data: {},
    };
    const tc = liveCardToTaskConfig(card);
    expect(tc.taskHandlers).toEqual(['card-handler']);
  });

  it('provides keys from card.provides', () => {
    const card: BoardLiveCard = {
      id: 'multi',
      provides: [{ bindTo: 'alpha', src: 'card_data.alpha' }, { bindTo: 'beta', src: 'card_data.beta' }],
      card_data: {},
    };
    const tc = liveCardToTaskConfig(card);
    expect(tc.provides).toEqual(['alpha', 'beta']);
  });

  it('keeps provides empty when no provides are declared', () => {
    const card: BoardLiveCard = {
      id: 'standalone',
      card_data: {},
    };
    const tc = liveCardToTaskConfig(card);
    expect(tc.provides).toEqual([]);
  });

  it('maps meta.title to description', () => {
    const card: BoardLiveCard = {
      id: 'x',
      meta: { title: 'My Title' },
      card_data: {},
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
    expect(entries[0].cardFilePath).toBe(path.resolve('/abs/a.json'));
    expect(entries[1].cardId).toBe('b');
  });

  it('lookupCardPath returns path for known card', () => {
    const dir = freshDir();
    appendCardInventory(dir, { cardId: 'x', cardFilePath: '/some/x.json', addedAt: '2026-01-01T00:00:00Z' });
    expect(lookupCardPath(dir, 'x')).toBe(path.resolve('/some/x.json'));
  });

  it('lookupCardPath returns null for unknown card', () => {
    const dir = freshDir();
    expect(lookupCardPath(dir, 'missing')).toBeNull();
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
    fs.writeFileSync(cardFile, JSON.stringify({ id: 'temp', card_data: {} }));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['upsert-card', '--rg', dir, '--card', cardFile]);
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
// CLI upsert-card (atomic glob behavior)
// ============================================================================

describe('cli upsert-card atomicity', () => {
  let tmpDir: string;

  function freshDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'upsert-atomic-test-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('does not partially apply glob upsert when one file violates id->path mapping', async () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(dir);

    // Seed existing mapping: x -> existing.json
    const existingCard = path.join(tmpDir, 'existing.json');
    fs.writeFileSync(existingCard, JSON.stringify({ id: 'x', card_data: {} }));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['upsert-card', '--rg', dir, '--card', existingCard]);
    spy.mockRestore();

    await pollBoard(dir, t => !!t['x']);

    // Batch contains one valid new card and one invalid remap for id x.
    const cardsDir = path.join(tmpDir, 'batch');
    fs.mkdirSync(cardsDir, { recursive: true });
    fs.writeFileSync(path.join(cardsDir, 'ok-y.json'), JSON.stringify({ id: 'y', card_data: {} }));
    fs.writeFileSync(path.join(cardsDir, 'bad-x-remap.json'), JSON.stringify({ id: 'x', card_data: {} }));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as any);
    await expect(cli(['upsert-card', '--rg', dir, '--card-glob', path.join(cardsDir, '*.json')])).rejects.toThrow('exit');
    exitSpy.mockRestore();
    errSpy.mockRestore();

    // Atomicity assertion: only original mapping remains; y must not be inserted.
    const inv = readCardInventory(dir);
    expect(inv.map(e => e.cardId).sort()).toEqual(['x']);

    await cli(['process-accumulated-events', '--rg', dir, '--inline-loop']);
    const live = loadBoard(dir);
    expect(live.config.tasks.x).toBeDefined();
    expect(live.config.tasks.y).toBeUndefined();
  });

  it('fails atomically when glob contains duplicate ids across different files', async () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(dir);

    const cardsDir = path.join(tmpDir, 'dupes');
    fs.mkdirSync(cardsDir, { recursive: true });
    fs.writeFileSync(path.join(cardsDir, 'a1.json'), JSON.stringify({ id: 'dup', card_data: {} }));
    fs.writeFileSync(path.join(cardsDir, 'a2.json'), JSON.stringify({ id: 'dup', card_data: {} }));

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as any);
    await expect(cli(['upsert-card', '--rg', dir, '--card-glob', path.join(cardsDir, '*.json')])).rejects.toThrow('exit');
    exitSpy.mockRestore();
    errSpy.mockRestore();

    // Atomicity assertion: no inventory entries written.
    expect(readCardInventory(dir)).toHaveLength(0);
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
    fs.writeFileSync(cardFile, JSON.stringify({ id: 'src', card_data: {} }));
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['upsert-card', '--rg', dir, '--card', cardFile]);
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
// Data objects persistence (token-centric architecture)
// ============================================================================

describe('data-objects persistence', () => {
  let tmpDir: string;

  function freshDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'data-objects-test-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes token data objects from provides to runtime-out/data-objects/', async () => {
    const dir = path.join(freshDir(), 'board');
    const runtimeOutDir = path.join(tmpDir, 'runtime-publish');
    cli(['init', dir, '--runtime-out', runtimeOutDir]);

    const cardFile = path.join(tmpDir, 'source.json');
    const card: BoardLiveCard = {
      id: 'source-data',
      provides: [
        { bindTo: 'orders', src: 'card_data.orders' },
        { bindTo: 'metadata', src: 'card_data.meta' },
      ],
      card_data: {
        orders: [
          { id: 1, name: 'Order A', amount: 100 },
          { id: 2, name: 'Order B', amount: 200 },
        ],
        meta: { source: 'test', version: '1.0' },
      },
    };
    fs.writeFileSync(cardFile, JSON.stringify(card));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['upsert-card', '--rg', dir, '--card', cardFile]);
    spy.mockRestore();

    await pollBoard(dir, t => !!t['source-data']);

    // Verify data objects directory and files
    const dataObjectsDir = path.join(runtimeOutDir, 'data-objects');
    expect(fs.existsSync(dataObjectsDir)).toBe(true);

    // Verify 'orders' token file
    const ordersFile = path.join(dataObjectsDir, 'orders');
    await pollForFile(ordersFile);
    const orders = JSON.parse(fs.readFileSync(ordersFile, 'utf-8'));
    expect(orders).toEqual([
      { id: 1, name: 'Order A', amount: 100 },
      { id: 2, name: 'Order B', amount: 200 },
    ]);

    // Verify 'metadata' token file
    const metadataFile = path.join(dataObjectsDir, 'metadata');
    await pollForFile(metadataFile);
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'));
    expect(metadata).toEqual({ source: 'test', version: '1.0' });
  });

  it('data objects persist across multiple card updates', async () => {
    const dir = path.join(freshDir(), 'board');
    const runtimeOutDir = path.join(tmpDir, 'runtime-publish');
    cli(['init', dir, '--runtime-out', runtimeOutDir]);

    // First card — provides 'prices'
    const pricesCard: BoardLiveCard = {
      id: 'prices-source',
      provides: [{ bindTo: 'prices', src: 'card_data.prices' }],
      card_data: {
        prices: [
          { product: 'A', price: 100 },
          { product: 'B', price: 200 },
        ],
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'prices.json'), JSON.stringify(pricesCard));

    let spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['upsert-card', '--rg', dir, '--card', path.join(tmpDir, 'prices.json')]);
    spy.mockRestore();

    await pollBoard(dir, t => !!t['prices-source']);

    const pricesFile = path.join(runtimeOutDir, 'data-objects', 'prices');
    await pollForFile(pricesFile);
    const prices1 = JSON.parse(fs.readFileSync(pricesFile, 'utf-8'));
    expect(prices1).toHaveLength(2);

    // Second card — provides 'discount-rules'
    const discountCard: BoardLiveCard = {
      id: 'discount-source',
      provides: [{ bindTo: 'discount-rules', src: 'card_data.rules' }],
      card_data: {
        rules: [
          { minAmount: 1000, discount: 0.1 },
          { minAmount: 5000, discount: 0.2 },
        ],
      },
    };
    fs.writeFileSync(path.join(tmpDir, 'discount.json'), JSON.stringify(discountCard));

    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['upsert-card', '--rg', dir, '--card', path.join(tmpDir, 'discount.json')]);
    spy.mockRestore();

    await pollBoard(dir, t => !!t['discount-source']);

    // Both files should coexist
    expect(fs.existsSync(pricesFile)).toBe(true);
    const discountFile = path.join(runtimeOutDir, 'data-objects', 'discount-rules');
    await pollForFile(discountFile);
    const discount = JSON.parse(fs.readFileSync(discountFile, 'utf-8'));
    expect(discount).toHaveLength(2);

    // Verify first token wasn't modified
    const prices2 = JSON.parse(fs.readFileSync(pricesFile, 'utf-8'));
    expect(prices2).toEqual(prices1);
  });

  it('handles special characters in token names by substituting path separators', async () => {
    const dir = path.join(freshDir(), 'board');
    const runtimeOutDir = path.join(tmpDir, 'runtime-publish');
    cli(['init', dir, '--runtime-out', runtimeOutDir]);

    const cardFile = path.join(tmpDir, 'special.json');
    const card: BoardLiveCard = {
      id: 'special-tokens',
      provides: [
        { bindTo: 'data/users', src: 'card_data.users' },
        { bindTo: 'data\\products', src: 'card_data.products' },
      ],
      card_data: {
        users: [{ id: 1, name: 'Alice' }],
        products: [{ id: 1, name: 'Widget' }],
      },
    };
    fs.writeFileSync(cardFile, JSON.stringify(card));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['upsert-card', '--rg', dir, '--card', cardFile]);
    spy.mockRestore();

    await pollBoard(dir, t => !!t['special-tokens']);

    const dataObjectsDir = path.join(runtimeOutDir, 'data-objects');
    // Token names with path separators should be sanitized (/ and \ replaced with __)
    const files = fs.readdirSync(dataObjectsDir).filter(f => f.startsWith('data'));
    expect(files.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// Computed values persistence
// ============================================================================

describe('computed-values persistence', () => {
  let tmpDir: string;

  function freshDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'computed-values-test-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('publishes computed values to runtime-out/cards/<cardId>.computed.json', async () => {
    const dir = path.join(freshDir(), 'board');
    const runtimeOutDir = path.join(tmpDir, 'runtime-publish');
    cli(['init', dir, '--runtime-out', runtimeOutDir]);

    const cardFile = path.join(tmpDir, 'metrics.json');
    const card: BoardLiveCard = {
      id: 'sales-metrics',
      compute: [
        { bindTo: 'totalSales', expr: '$sum(card_data.sales.amount)' },
        { bindTo: 'avgSale', expr: '$sum(card_data.sales.amount) / $count(card_data.sales)' },
        { bindTo: 'maxSale', expr: '$max(card_data.sales.amount)' },
      ],
      card_data: {
        sales: [
          { id: 1, amount: 1000 },
          { id: 2, amount: 1500 },
          { id: 3, amount: 2000 },
        ],
      },
    };
    fs.writeFileSync(cardFile, JSON.stringify(card));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['upsert-card', '--rg', dir, '--card', cardFile]);
    spy.mockRestore();

    await pollBoard(dir, t => !!t['sales-metrics']);

    const computedFile = path.join(runtimeOutDir, 'cards', 'sales-metrics.computed.json');
    await pollForFile(computedFile);

    const computed = JSON.parse(fs.readFileSync(computedFile, 'utf-8')) as {
      schema_version: string;
      card_id: string;
      computed_values: Record<string, unknown>;
    };
    expect(computed.schema_version).toBe('v1');
    expect(computed.card_id).toBe('sales-metrics');
    expect(computed.computed_values).toEqual({
      totalSales: 4500,
      avgSale: 1500,
      maxSale: 2000,
    });
  });

  it('updates computed values when card_data changes', async () => {
    const dir = path.join(freshDir(), 'board');
    const runtimeOutDir = path.join(tmpDir, 'runtime-publish');
    cli(['init', dir, '--runtime-out', runtimeOutDir]);

    const cardFile = path.join(tmpDir, 'counter.json');
    const card: BoardLiveCard = {
      id: 'counter',
      compute: [{ bindTo: 'count', expr: '$count(card_data.items)' }],
      card_data: { items: [1, 2, 3] },
    };
    fs.writeFileSync(cardFile, JSON.stringify(card));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['upsert-card', '--rg', dir, '--card', cardFile]);
    spy.mockRestore();

    await pollBoard(dir, t => !!t['counter']);

    const computedFile = path.join(runtimeOutDir, 'cards', 'counter.computed.json');
    await pollForFile(computedFile);

    const computed1 = JSON.parse(fs.readFileSync(computedFile, 'utf-8')) as { computed_values: { count: number } };
    expect(computed1.computed_values.count).toBe(3);

    // Update the card with new data
    const updatedCard: BoardLiveCard = {
      ...card,
      card_data: { items: [1, 2, 3, 4, 5, 6, 7] },
    };
    fs.writeFileSync(cardFile, JSON.stringify(updatedCard));

    const spy2 = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['upsert-card', '--rg', dir, '--card', cardFile, '--restart']);
    spy2.mockRestore();

    await pollBoard(dir, t => {
      try {
        const computed = JSON.parse(fs.readFileSync(computedFile, 'utf-8')) as { computed_values: { count: number } };
        return computed.computed_values.count === 7;
      } catch {
        return false;
      }
    }, 15000);  // Increased timeout from default 5000ms

    const computed2 = JSON.parse(fs.readFileSync(computedFile, 'utf-8')) as { computed_values: { count: number } };
    expect(computed2.computed_values.count).toBe(7);
  }, 30000);

  it('persists computed values with complex nested structures', async () => {
    const dir = path.join(freshDir(), 'board');
    const runtimeOutDir = path.join(tmpDir, 'runtime-publish');
    cli(['init', dir, '--runtime-out', runtimeOutDir]);

    const cardFile = path.join(tmpDir, 'analysis.json');
    const card: BoardLiveCard = {
      id: 'data-analysis',
      compute: [
        {
          bindTo: 'groupedByRegion',
          expr: '$each($reduce(card_data.orders, function($acc, $o){ $merge([$acc, { $o.region: ($lookup($acc, $o.region) ? $lookup($acc, $o.region) + $o.amount : $o.amount) }]) }, {}), function($v, $k){ { "region": $k, "total": $v } })',
        },
      ],
      card_data: {
        orders: [
          { region: 'North', amount: 100 },
          { region: 'South', amount: 200 },
          { region: 'North', amount: 150 },
        ],
      },
    };
    fs.writeFileSync(cardFile, JSON.stringify(card));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['upsert-card', '--rg', dir, '--card', cardFile]);
    spy.mockRestore();

    await pollBoard(dir, t => !!t['data-analysis']);

    const computedFile = path.join(runtimeOutDir, 'cards', 'data-analysis.computed.json');
    await pollForFile(computedFile);

    const computed = JSON.parse(fs.readFileSync(computedFile, 'utf-8')) as {
      computed_values: { groupedByRegion: Array<{ region: string; total: number }> };
    };
    expect(Array.isArray(computed.computed_values.groupedByRegion)).toBe(true);
    expect(computed.computed_values.groupedByRegion.length).toBe(2);
  });

  it('includes minimal runtime fields in persisted computed artifact', async () => {
    const dir = path.join(freshDir(), 'board');
    const runtimeOutDir = path.join(tmpDir, 'runtime-publish');
    cli(['init', dir, '--runtime-out', runtimeOutDir]);

    const cardFile = path.join(tmpDir, 'full.json');
    const card: BoardLiveCard = {
      id: 'full-artifact',
      compute: [{ bindTo: 'value', expr: '42' }],
      card_data: { custom: 'data' },
    };
    fs.writeFileSync(cardFile, JSON.stringify(card));

    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['upsert-card', '--rg', dir, '--card', cardFile]);
    spy.mockRestore();

    await pollBoard(dir, t => !!t['full-artifact']);

    const computedFile = path.join(runtimeOutDir, 'cards', 'full-artifact.computed.json');
    await pollForFile(computedFile);

    const computed = JSON.parse(fs.readFileSync(computedFile, 'utf-8'));
    // Should match CardRuntimeSchema
    expect(computed).toHaveProperty('schema_version', 'v1');
    expect(computed).toHaveProperty('card_id', 'full-artifact');
    expect(computed).toHaveProperty('computed_values');
    expect(computed).not.toHaveProperty('sources_data');
    expect(computed).not.toHaveProperty('card_data');
    expect(validateCardRuntimeArtifact(computed), schemaErrors(validateCardRuntimeArtifact)).toBe(true);
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
    const tracker = fs.readFileSync(path.join(repoRoot, 'examples', 'browser', 'boards', 'portfolio-tracker', 'portfolio-tracker.js'), 'utf-8');
    expect(tracker).toContain('windowsHide: true');
  });

  it('keeps CLI child-process launches hidden on Windows', () => {
    const cliSource = fs.readFileSync(path.join(repoRoot, 'src', 'cli', 'board-live-cards-cli.ts'), 'utf-8');
    expect(cliSource).toContain('windowsHide: true');
    expect((cliSource.match(/windowsHide: true/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
