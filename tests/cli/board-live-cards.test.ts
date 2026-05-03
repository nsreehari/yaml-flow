import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  createBoardLiveCardsNonCorePublic, createFsBoardNonCorePlatformAdapter,
  createFsBoardPlatformAdapter,
} from '../../src/cli/node/fs-board-adapter.js';
import {
  createBoardLiveCardsPublic,
  BOARD_GRAPH_KEY, SNAPSHOT_SCHEMA_VERSION_V1,
} from '../../src/cli/common/board-live-cards-public.js';
import {
  createStateSnapshotStore,
  boardEnvelopeToSnapshotEntries,
  snapshotEntriesToBoardEnvelope,
  liveCardToTaskConfig,
  createCardStore,
} from '../../src/cli/common/board-live-cards-lib.js';
import type { BoardLiveCard, BoardEnvelope, CardInventoryEntry } from '../../src/cli/common/board-live-cards-lib.js';
import { createCardStorePublic } from '../../src/cli/common/card-store-lib-public.js';
import { createFsJournalStorageAdapter, createFsStateSnapshotStorageAdapter, createFsCardStorageAdapter } from '../../src/cli/node/storage-fs-adapters.js';
import { parseRef, serializeRef } from '../../src/cli/common/storage-interface.js';
import type { KindValueRef } from '../../src/cli/common/storage-interface.js';
import { createReactiveGraph, restore, createLiveGraph, snapshot } from '../../src/continuous-event-graph/index.js';
import type { ReactiveGraph } from '../../src/continuous-event-graph/index.js';
import type { GraphConfig, GraphEvent } from '../../src/event-graph/types.js';

process.env.BOARD_LIVE_CARDS_NO_SPAWN = '1';

// ============================================================================
// Test-local helpers (adapters previously in fs-board-adapter.ts)
// ============================================================================

interface JournalEntry { id: string; event: GraphEvent; }

const snapshotStore = createStateSnapshotStore(createFsStateSnapshotStorageAdapter());

function initBoard(baseRef: KindValueRef): 'created' | 'exists' {
  if (baseRef.kind !== 'fs-path') throw new Error(`initBoard: unsupported kind "${baseRef.kind}"`);
  const dir = baseRef.value;
  const snap = snapshotStore.readSnapshot(dir);
  if (snap.values[BOARD_GRAPH_KEY]) return 'exists';
  // Guard: non-empty dir without valid board
  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir);
    if (entries.length > 0) throw new Error(`Directory "${dir}" is not empty and has no valid board`);
  }
  const board = createBoardLiveCardsPublic(baseRef, createFsBoardPlatformAdapter(baseRef, testDir));
  const result = board.init({ params: { cardStoreRef: '::fs-path::' + path.join(dir, '.cards') } });
  if (result.status !== 'success') throw new Error(`initBoard failed: ${JSON.stringify(result)}`);
  return 'created';
}

function loadBoardEnvelope(baseRef: KindValueRef): BoardEnvelope {
  const snap = snapshotStore.readSnapshot(baseRef.value);
  if (!snap.values[BOARD_GRAPH_KEY]) throw new Error(`Missing board state at: ${baseRef.value}`);
  return snapshotEntriesToBoardEnvelope(snap.values);
}

function loadBoard(baseRef: KindValueRef) {
  return restore(loadBoardEnvelope(baseRef).graph);
}

function saveBoard(baseRef: KindValueRef, rg: ReactiveGraph, journalOrCursor: BoardJournal | string): void {
  const newCursor = typeof journalOrCursor === 'string' ? journalOrCursor : journalOrCursor.lastDrainedJournalId;
  const snap = rg.snapshot();
  const envelope: BoardEnvelope = { lastDrainedJournalId: newCursor, graph: snap };
  const current = snapshotStore.readSnapshot(baseRef.value);
  const result = snapshotStore.commitSnapshot(baseRef.value, {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION_V1,
    expectedVersion: current.version,
    commitId: randomUUID(),
    committedAt: new Date().toISOString(),
    deleteKeys: [],
    shallowMerge: boardEnvelopeToSnapshotEntries(envelope),
  });
  if (!result.ok) throw new Error(`saveBoard commit failed`);
}

class BoardJournal {
  private readonly adapter: ReturnType<typeof createFsJournalStorageAdapter>;
  private lastDrainedId: string;
  constructor(journalPath: string, lastDrainedJournalId: string) {
    this.adapter = createFsJournalStorageAdapter(path.dirname(journalPath));
    this.lastDrainedId = lastDrainedJournalId;
  }
  append(event: GraphEvent): void { this.adapter.appendEntry({ id: randomUUID(), event }); }
  drain(): GraphEvent[] {
    const all = this.adapter.readAllEntries();
    if (all.length === 0) return [];
    let startIdx = 0;
    if (this.lastDrainedId) {
      const idx = all.findIndex(e => e.id === this.lastDrainedId);
      if (idx !== -1) startIdx = idx + 1;
    }
    const undrained = all.slice(startIdx);
    if (undrained.length > 0) this.lastDrainedId = undrained[undrained.length - 1].id;
    return undrained.map(e => e.event);
  }
  get size(): number {
    const all = this.adapter.readAllEntries();
    if (!this.lastDrainedId) return all.length;
    const idx = all.findIndex(e => e.id === this.lastDrainedId);
    return idx === -1 ? all.length : all.length - idx - 1;
  }
  get lastDrainedJournalId(): string { return this.lastDrainedId; }
}

function appendEventToJournal(baseRef: KindValueRef, event: GraphEvent): void {
  createFsJournalStorageAdapter(baseRef.value).appendEntry({ id: randomUUID(), event });
}

function getUndrainedEntries(baseRef: KindValueRef, lastDrainedId: string): JournalEntry[] {
  const entries = createFsJournalStorageAdapter(baseRef.value).readAllEntries();
  if (!lastDrainedId) return entries;
  const idx = entries.findIndex(e => e.id === lastDrainedId);
  return idx === -1 ? entries : entries.slice(idx + 1);
}

const INVENTORY_FILE = 'cards-inventory.jsonl';

function readCardInventory(baseRef: KindValueRef): CardInventoryEntry[] {
  const p = path.join(baseRef.value, INVENTORY_FILE);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as CardInventoryEntry);
}

function appendCardInventory(baseRef: KindValueRef, entry: CardInventoryEntry): void {
  const p = path.join(baseRef.value, INVENTORY_FILE);
  const existing = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '';
  const normalized: CardInventoryEntry = { ...entry, cardFilePath: path.resolve(entry.cardFilePath) };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.appendFileSync(p, JSON.stringify(normalized) + '\n', 'utf-8');
}

function lookupCardPath(baseRef: KindValueRef, cardId: string): string | null {
  const entry = readCardInventory(baseRef).find(e => e.cardId === cardId);
  return entry?.cardFilePath ?? null;
}


const ref = (d: string) => ({ kind: 'fs-path' as const, value: d });

/** Serialized card store ref — always at <boardDir>/.cards */
const cardStoreRef = (boardDir: string) => '::fs-path::' + path.join(boardDir, '.cards');
const outputsStoreRef = (boardDir: string) => '::fs-path::' + path.join(boardDir, '.output');

/** Create a BoardLiveCardsPublic instance for a given dir. */
function board(dir: string) {
  const br = ref(dir);
  return createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, testDir, { onWarn: () => {} }));
}


const ticks = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const ts = () => new Date().toISOString();
const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..');
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
    const live = loadBoard(ref(dir));
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

/** Write a card to the board's card store via the card-store public API. */
function writeCardToStore(boardDir: string, card: { id: string } & Record<string, unknown>): void {
  const result = createCardStorePublic(
    createCardStore(createFsCardStorageAdapter(path.join(boardDir, '.cards'))),
  ).set({ body: card });
  if (result.status !== 'success') throw new Error(`writeCardToStore failed: ${result.error}`);
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
    const result = initBoard(ref(sub));

    expect(result).toBe('created');
    const envelope = loadBoardEnvelope(ref(sub));
    expect(envelope.lastDrainedJournalId).toBe('');
    expect(envelope.graph.version).toBe(1);
    expect(Object.keys(envelope.graph.config.tasks)).toHaveLength(0);
  });

  it('initBoard is idempotent — returns exists on second call', () => {
    const dir = freshDir();
    const sub = path.join(dir, 'nested');
    expect(initBoard(ref(sub))).toBe('created');
    expect(initBoard(ref(sub))).toBe('exists');
  });

  it('initBoard throws if dir is non-empty without valid board-graph.json', () => {
    const dir = freshDir();
    fs.writeFileSync(path.join(dir, 'some-file.json'), '{}');
    expect(() => initBoard(ref(dir))).toThrow('not empty');
  });

  it('loadBoardEnvelope returns the full envelope', () => {
    const dir = freshDir();
    initBoard(ref(path.join(dir, 'b')));
    const envelope = loadBoardEnvelope(ref(path.join(dir, 'b')));
    expect(envelope.lastDrainedJournalId).toBe('');
    expect(envelope.graph.version).toBe(1);
  });

  it('loadBoard returns a LiveGraph from board-graph.json', () => {
    const dir = freshDir();
    initBoard(ref(path.join(dir, 'b')));
    const live = loadBoard(ref(path.join(dir, 'b')));
    expect(Object.keys(live.config.tasks)).toHaveLength(0);
  });

  it('full roundtrip: init → addNode → run → save → load → state preserved', async () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(ref(dir));

    const live = loadBoard(ref(dir));
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

    saveBoard(ref(dir), rg, journal);
    rg.dispose();

    // Load again — state intact
    const live2 = loadBoard(ref(dir));
    expect(live2.state.tasks.src.status).toBe('completed');
    expect(live2.state.tasks.src.data).toEqual({ v: 1 });
    expect(live2.state.tasks.calc.status).toBe('completed');
    expect(live2.state.tasks.calc.data).toEqual({ result: 42 });

    // No external journal drain happened in this roundtrip, so the pointer stays empty.
    const envelope = loadBoardEnvelope(ref(dir));
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

  it('cli init --base-ref <ref> creates an empty board', async () => {
    const dir = path.join(freshDir(), 'myboard');
    board(dir).init({ params: { cardStoreRef: cardStoreRef(dir), outputsStoreRef: outputsStoreRef(dir) } });

    const live = loadBoard(ref(dir));
    expect(Object.keys(live.config.tasks)).toHaveLength(0);
  });

  it('cli init --base-ref <ref> writes status snapshot to .output/', async () => {
    const dir = path.join(freshDir(), 'board');
    board(dir).init({ params: { cardStoreRef: cardStoreRef(dir), outputsStoreRef: outputsStoreRef(dir) } });

    const statusFile = path.join(dir, '.output', 'status.json');
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

  it.skip('cli init with --runtime-out (feature removed from CLI)', () => { /* no-op */ });

  it('cli init --base-ref <ref> twice is idempotent', async () => {
    const dir = path.join(freshDir(), 'myboard');

    const result1 = board(dir).init({ params: { cardStoreRef: cardStoreRef(dir), outputsStoreRef: outputsStoreRef(dir) } });
    const result2 = board(dir).init({ params: { cardStoreRef: cardStoreRef(dir), outputsStoreRef: outputsStoreRef(dir) } });

    expect(result1.status).toBe('success');
    expect(result2.status).toBe('success');
  });

  it('cli status --base-ref <ref> prints stable status JSON', async () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(ref(dir));

    const result = board(dir).status({});

    expect(result.status).toBe('success');
    if (result.status !== 'success') throw new Error();
    const data = result.data;
    expect(data.schema_version).toBe('v1');
    expect(data.meta.board.path).toContain(path.resolve(dir));
    expect(data.summary.card_count).toBe(0);
    expect(data.summary).toMatchObject({ eligible: 0, pending: 0, blocked: 0, unresolved: 0 });
    expect(data.cards).toEqual([]);
    expect(validateBoardStatusArtifact(data), schemaErrors(validateBoardStatusArtifact)).toBe(true);
  });

  it('publishes computed values under the configured output cards directory', async () => {
    const dir = path.join(freshDir(), 'board');
    board(dir).init({ params: { cardStoreRef: cardStoreRef(dir), outputsStoreRef: outputsStoreRef(dir) } });

    const card: BoardLiveCard = {
      id: 'totals',
      compute: [{ bindTo: 'total', expr: '$sum(card_data.data.v)' }],
      provides: [{ bindTo: 'totals', ref: 'computed_values.total' }],
      card_data: {
        data: [{ v: 10 }, { v: 20 }, { v: 5 }],
      },
    };
    writeCardToStore(dir, card);

    board(dir).upsertCard({ params: { cardId: 'totals' } });

    await pollBoard(dir, t => !!t['totals']);

    const computedFile = path.join(dir, '.output', 'cards', 'totals', 'computed_values.json');
    await pollForFile(computedFile);

    const computedValues = JSON.parse(fs.readFileSync(computedFile, 'utf-8')) as { total: number };
    expect(computedValues).toEqual({ total: 35 });

    const statusFile = path.join(dir, '.output', 'status.json');
    const status = JSON.parse(fs.readFileSync(statusFile, 'utf-8')) as object;
    expect(validateBoardStatusArtifact(status), schemaErrors(validateBoardStatusArtifact)).toBe(true);
  });
});

// ============================================================================
// liveCardToTaskConfig — single 'card-handler' for all types
// ============================================================================

describe('liveCardToTaskConfig', () => {
  it('card with source_defs → [card-handler]', () => {
    const card: BoardLiveCard = {
      id: 'prices',
      provides: [{ bindTo: 'prices', ref: 'card_data.prices' }],
      source_defs: [{ cli: 'fetch.sh', bindTo: 'raw', outputFile: 'raw.json' }],
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
      source_defs: [{ bindTo: 'extra', outputFile: 'extra.json', optionalForCompletionGating: true }],
      card_data: {},
    };
    const tc = liveCardToTaskConfig(card);
    expect(tc.taskHandlers).toEqual(['card-handler']);
  });

  it('card with required + non-gating source_defs → still just [card-handler]', () => {
    const card: BoardLiveCard = {
      id: 'live-feed',
      source_defs: [
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
      provides: [{ bindTo: 'alpha', ref: 'card_data.alpha' }, { bindTo: 'beta', ref: 'card_data.beta' }],
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
    const journalPath = path.join(dir, 'board-journal.jsonl');
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
    const journalPath = path.join(dir, 'board-journal.jsonl');
    const journal = new BoardJournal(journalPath, '');

    journal.append({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    journal.append({ type: 'inject-tokens', tokens: ['a'], timestamp: ts() });

    const events = journal.drain();
    expect(events).toHaveLength(2);
    expect(events[1].type).toBe('inject-tokens');
  });

  it('drain returns only undrained events after partial drain', () => {
    const dir = freshDir();
    const journalPath = path.join(dir, 'board-journal.jsonl');
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
    const journalPath = path.join(dir, 'board-journal.jsonl');
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
    const journalPath = path.join(dir, 'board-journal.jsonl');

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
    appendEventToJournal(ref(dir), { type: 'inject-tokens', tokens: [], timestamp: ts() });
    appendEventToJournal(ref(dir), { type: 'inject-tokens', tokens: ['a'], timestamp: ts() });

    const entries = getUndrainedEntries(ref(dir), '');
    expect(entries).toHaveLength(2);
    expect(entries[0].id).toBeTruthy();
    expect(entries[1].id).toBeTruthy();
    expect(entries[0].id).not.toBe(entries[1].id);
  });

  it('getUndrainedEntries returns [] for no journal file', () => {
    const dir = freshDir();
    expect(getUndrainedEntries(ref(dir), '')).toEqual([]);
  });

  it('getUndrainedEntries filters by lastDrainedId', () => {
    const dir = freshDir();
    appendEventToJournal(ref(dir), { type: 'inject-tokens', tokens: [], timestamp: ts() });
    appendEventToJournal(ref(dir), { type: 'inject-tokens', tokens: [], timestamp: ts() });
    appendEventToJournal(ref(dir), { type: 'inject-tokens', tokens: [], timestamp: ts() });

    const all = getUndrainedEntries(ref(dir), '');
    expect(all).toHaveLength(3);

    // Skip first two
    const afterSecond = getUndrainedEntries(ref(dir), all[1].id);
    expect(afterSecond).toHaveLength(1);
    expect(afterSecond[0].id).toBe(all[2].id);

    // Skip all
    const afterLast = getUndrainedEntries(ref(dir), all[2].id);
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
    expect(readCardInventory(ref(dir))).toEqual([]);
  });

  it('appendCardInventory + readCardInventory roundtrip', () => {
    const dir = freshDir();
    appendCardInventory(ref(dir), { cardId: 'a', cardFilePath: '/abs/a.json', addedAt: '2026-01-01T00:00:00Z' });
    appendCardInventory(ref(dir), { cardId: 'b', cardFilePath: '/abs/b.json', addedAt: '2026-01-02T00:00:00Z' });

    const entries = readCardInventory(ref(dir));
    expect(entries).toHaveLength(2);
    expect(entries[0].cardId).toBe('a');
    expect(entries[0].cardFilePath).toBe(path.resolve('/abs/a.json'));
    expect(entries[1].cardId).toBe('b');
  });

  it('lookupCardPath returns path for known card', () => {
    const dir = freshDir();
    appendCardInventory(ref(dir), { cardId: 'x', cardFilePath: '/some/x.json', addedAt: '2026-01-01T00:00:00Z' });
    expect(lookupCardPath(ref(dir), 'x')).toBe(path.resolve('/some/x.json'));
  });

  it('lookupCardPath returns null for unknown card', () => {
    const dir = freshDir();
    expect(lookupCardPath(ref(dir), 'missing')).toBeNull();
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
    initBoard(ref(dir));

    writeCardToStore(dir, { id: 'temp', card_data: {} });

    board(dir).upsertCard({ params: { cardId: 'temp' } });

    await pollBoard(dir, t => !!t['temp']);

    const removeResult = board(dir).removeCard({ params: { id: 'temp' } });

    await board(dir).processAccumulatedEvents({});

    await pollBoard(dir, t => !t['temp']);
    expect(removeResult.status).toBe('success');
  });
});

// ============================================================================
// CLI validate-card
// ============================================================================

describe('cli validate-card', () => {
  let tmpDir: string;

  function freshDir() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'validate-card-test-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeNonCore() {
    const br = ref(tmpDir);
    return createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, testDir, { onWarn: () => {} }));
  }

  it('accepts a valid card', () => {
    freshDir();
    const result = makeNonCore().validateTmpCard({ body: {
      id: 'ok-card',
      provides: [{ bindTo: 'prices', ref: 'card_data.prices' }],
      card_data: { prices: {} },
    } });
    expect(result.status).toBe('success');
  });

  it('rejects a card with invalid provides.ref namespace', () => {
    freshDir();
    const result = makeNonCore().validateTmpCard({ body: {
      id: 'bad-ns',
      provides: [{ bindTo: 'data', ref: 'source_defs.foo.bar' }],
      card_data: {},
    } });
    expect(result.status).toBe('success');
    const data = (result as { status: string; data: { isValid: boolean; issues: string[] } }).data;
    expect(data.isValid).toBe(false);
    expect(data.issues.length).toBeGreaterThan(0);
  });

  it('rejects a card with an unparseable compute expression', () => {
    freshDir();
    const result = makeNonCore().validateTmpCard({ body: {
      id: 'bad-expr',
      compute: [{ bindTo: 'total', expr: '$$$broken(' }],
      card_data: {},
    } });
    expect(result.status).toBe('success');
    const data = (result as { status: string; data: { isValid: boolean; issues: string[] } }).data;
    expect(data.isValid).toBe(false);
    expect(data.issues.length).toBeGreaterThan(0);
  });

  it('rejects a card missing the id field', () => {
    freshDir();
    const result = makeNonCore().validateTmpCard({ body: { card_data: { x: 1 } } });
    // id is '(unknown)' when missing — schema validation should still catch that
    expect(result.status).toBe('success');
    const data = (result as { status: string; data: { cardId: string; isValid: boolean; issues: string[] } }).data;
    expect(data.cardId).toBe('(unknown)');
  });

  it.skip('validates multiple cards via --card-glob (feature removed from CLI)', () => {
    // --card-glob was removed from the CLI; use the public API to validate cards individually
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

  it.skip('does not partially apply glob upsert when one file violates id->path mapping (--card-glob removed)', () => {
    // The --card-glob flag was removed from the CLI.
    // Use the public API (updateInCardStore + upsertCard) to add cards individually.
  });

  it.skip('fails atomically when glob contains duplicate ids across different files (--card-glob removed)', () => {
    // The --card-glob flag was removed from the CLI.
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

  it('appends task-restart event and drains', async () => {
    const dir = path.join(freshDir(), 'board');
    initBoard(ref(dir));

    // Add a card so the task exists
    writeCardToStore(dir, { id: 'src', card_data: {} });
    board(dir).upsertCard({ params: { cardId: 'src' } });

    // Retrigger
    const retrigerResult = board(dir).retrigger({ params: { id: 'src' } });

    expect(retrigerResult.status).toBe('success');
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

  it('writes token data objects from provides to .output/data-objects/', async () => {
    const dir = path.join(freshDir(), 'board');
    board(dir).init({ params: { cardStoreRef: cardStoreRef(dir), outputsStoreRef: outputsStoreRef(dir) } });

    const card: BoardLiveCard = {
      id: 'source-data',
      provides: [
        { bindTo: 'orders', ref: 'card_data.orders' },
        { bindTo: 'metadata', ref: 'card_data.meta' },
      ],
      card_data: {
        orders: [
          { id: 1, name: 'Order A', amount: 100 },
          { id: 2, name: 'Order B', amount: 200 },
        ],
        meta: { source: 'test', version: '1.0' },
      },
    };
    writeCardToStore(dir, card);

    board(dir).upsertCard({ params: { cardId: 'source-data' } });

    await pollBoard(dir, t => !!t['source-data']);

    const dataObjectsDir = path.join(dir, '.output', 'data-objects');
    expect(fs.existsSync(dataObjectsDir)).toBe(true);

    const ordersFile = path.join(dataObjectsDir, 'orders.json');
    await pollForFile(ordersFile);
    const orders = JSON.parse(fs.readFileSync(ordersFile, 'utf-8'));
    expect(orders).toEqual([
      { id: 1, name: 'Order A', amount: 100 },
      { id: 2, name: 'Order B', amount: 200 },
    ]);

    const metadataFile = path.join(dataObjectsDir, 'metadata.json');
    await pollForFile(metadataFile);
    const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf-8'));
    expect(metadata).toEqual({ source: 'test', version: '1.0' });
  });

  it('data objects persist across multiple card updates', async () => {
    const dir = path.join(freshDir(), 'board');
    board(dir).init({ params: { cardStoreRef: cardStoreRef(dir), outputsStoreRef: outputsStoreRef(dir) } });

    // First card — provides 'prices'
    const pricesCard: BoardLiveCard = {
      id: 'prices-source',
      provides: [{ bindTo: 'prices', ref: 'card_data.prices' }],
      card_data: {
        prices: [
          { product: 'A', price: 100 },
          { product: 'B', price: 200 },
        ],
      },
    };
    writeCardToStore(dir, pricesCard);

    board(dir).upsertCard({ params: { cardId: 'prices-source' } });

    await pollBoard(dir, t => !!t['prices-source']);

    const pricesFile = path.join(dir, '.output', 'data-objects', 'prices.json');
    await pollForFile(pricesFile);
    const prices1 = JSON.parse(fs.readFileSync(pricesFile, 'utf-8'));
    expect(prices1).toHaveLength(2);

    // Second card — provides 'discount-rules'
    const discountCard: BoardLiveCard = {
      id: 'discount-source',
      provides: [{ bindTo: 'discount-rules', ref: 'card_data.rules' }],
      card_data: {
        rules: [
          { minAmount: 1000, discount: 0.1 },
          { minAmount: 5000, discount: 0.2 },
        ],
      },
    };
    writeCardToStore(dir, discountCard);

    board(dir).upsertCard({ params: { cardId: 'discount-source' } });

    await pollBoard(dir, t => !!t['discount-source']);

    // Both files should coexist
    expect(fs.existsSync(pricesFile)).toBe(true);
    const discountFile = path.join(dir, '.output', 'data-objects', 'discount-rules.json');
    await pollForFile(discountFile);
    const discount = JSON.parse(fs.readFileSync(discountFile, 'utf-8'));
    expect(discount).toHaveLength(2);

    // Verify first token wasn't modified
    const prices2 = JSON.parse(fs.readFileSync(pricesFile, 'utf-8'));
    expect(prices2).toEqual(prices1);
  });

  it('handles token names with path separators as subdirectories', async () => {
    const dir = path.join(freshDir(), 'board');
    board(dir).init({ params: { cardStoreRef: cardStoreRef(dir), outputsStoreRef: outputsStoreRef(dir) } });

    const card: BoardLiveCard = {
      id: 'special-tokens',
      provides: [
        { bindTo: 'data/users', ref: 'card_data.users' },
        { bindTo: 'data/products', ref: 'card_data.products' },
      ],
      card_data: {
        users: [{ id: 1, name: 'Alice' }],
        products: [{ id: 1, name: 'Widget' }],
      },
    };
    writeCardToStore(dir, card);

    board(dir).upsertCard({ params: { cardId: 'special-tokens' } });

    await pollBoard(dir, t => !!t['special-tokens']);

    const dataObjectsDir = path.join(dir, '.output', 'data-objects');
    await pollForFile(path.join(dataObjectsDir, 'data', 'users.json'));
    await pollForFile(path.join(dataObjectsDir, 'data', 'products.json'));

    const users = JSON.parse(fs.readFileSync(path.join(dataObjectsDir, 'data', 'users.json'), 'utf-8'));
    expect(users).toEqual([{ id: 1, name: 'Alice' }]);
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

  it('publishes computed values to .output/cards/<cardId>/computed_values.json', async () => {
    const dir = path.join(freshDir(), 'board');
    board(dir).init({ params: { cardStoreRef: cardStoreRef(dir), outputsStoreRef: outputsStoreRef(dir) } });

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
    writeCardToStore(dir, card);

    board(dir).upsertCard({ params: { cardId: 'sales-metrics' } });

    await pollBoard(dir, t => !!t['sales-metrics']);

    const computedFile = path.join(dir, '.output', 'cards', 'sales-metrics', 'computed_values.json');
    await pollForFile(computedFile);

    const computed = JSON.parse(fs.readFileSync(computedFile, 'utf-8')) as Record<string, number>;
    expect(computed).toEqual({
      totalSales: 4500,
      avgSale: 1500,
      maxSale: 2000,
    });
  });

  it('updates computed values when card_data changes', async () => {
    const dir = path.join(freshDir(), 'board');
    board(dir).init({ params: { cardStoreRef: cardStoreRef(dir), outputsStoreRef: outputsStoreRef(dir) } });

    const card: BoardLiveCard = {
      id: 'counter',
      compute: [{ bindTo: 'count', expr: '$count(card_data.items)' }],
      card_data: { items: [1, 2, 3] },
    };
    writeCardToStore(dir, card);

    board(dir).upsertCard({ params: { cardId: 'counter' } });

    await pollBoard(dir, t => !!t['counter']);

    const computedFile = path.join(dir, '.output', 'cards', 'counter', 'computed_values.json');
    await pollForFile(computedFile);

    const computed1 = JSON.parse(fs.readFileSync(computedFile, 'utf-8')) as { count: number };
    expect(computed1.count).toBe(3);

    // Update the card with new data
    writeCardToStore(dir, { ...card, card_data: { items: [1, 2, 3, 4, 5, 6, 7] } });

    board(dir).upsertCard({ params: { cardId: 'counter', restart: true } });

    await pollBoard(dir, () => {
      try {
        const vals = JSON.parse(fs.readFileSync(computedFile, 'utf-8')) as { count: number };
        return vals.count === 7;
      } catch {
        return false;
      }
    }, 15000);

    const computed2 = JSON.parse(fs.readFileSync(computedFile, 'utf-8')) as { count: number };
    expect(computed2.count).toBe(7);
  }, 30000);

  it('persists computed values with complex nested structures', async () => {
    const dir = path.join(freshDir(), 'board');
    board(dir).init({ params: { cardStoreRef: cardStoreRef(dir), outputsStoreRef: outputsStoreRef(dir) } });

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
    writeCardToStore(dir, card);

    board(dir).upsertCard({ params: { cardId: 'data-analysis' } });

    await pollBoard(dir, t => !!t['data-analysis']);

    const computedFile = path.join(dir, '.output', 'cards', 'data-analysis', 'computed_values.json');
    await pollForFile(computedFile);

    const computed = JSON.parse(fs.readFileSync(computedFile, 'utf-8')) as {
      groupedByRegion: Array<{ region: string; total: number }>;
    };
    expect(Array.isArray(computed.groupedByRegion)).toBe(true);
    expect(computed.groupedByRegion.length).toBe(2);
  });

  it('stores computed values as a plain values map (no schema_version/card_id wrapper)', async () => {
    const dir = path.join(freshDir(), 'board');
    board(dir).init({ params: { cardStoreRef: cardStoreRef(dir), outputsStoreRef: outputsStoreRef(dir) } });

    const card: BoardLiveCard = {
      id: 'full-artifact',
      compute: [{ bindTo: 'value', expr: '42' }],
      card_data: { custom: 'data' },
    };
    writeCardToStore(dir, card);

    board(dir).upsertCard({ params: { cardId: 'full-artifact' } });

    await pollBoard(dir, t => !!t['full-artifact']);

    const computedFile = path.join(dir, '.output', 'cards', 'full-artifact', 'computed_values.json');
    await pollForFile(computedFile);

    const computedValues = JSON.parse(fs.readFileSync(computedFile, 'utf-8')) as Record<string, unknown>;
    // Just the values object — no schema_version/card_id wrapper
    expect(computedValues).toHaveProperty('value', 42);
    expect(computedValues).not.toHaveProperty('schema_version');
    expect(computedValues).not.toHaveProperty('card_id');
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
    // All process execution is consolidated in process-runner.ts; check there.
    const processRunner = fs.readFileSync(path.join(repoRoot, 'src', 'cli', 'node', 'process-runner.ts'), 'utf-8');
    expect(processRunner).toContain('windowsHide: true');
    expect((processRunner.match(/windowsHide: true/g) ?? []).length).toBeGreaterThanOrEqual(4);
  });
});
