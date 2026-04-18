/**
 * Board Live Cards — Disk persistence + CLI for ReactiveGraph.
 *
 * Library:
 *   initBoard(dir)     — create dir + board-graph.json (idempotent)
 *   loadBoard(dir)     — read board-graph.json → LiveGraph
 *   saveBoard(dir, rg) — rg.snapshot() → write board-graph.json
 *
 * CLI:
 *   board-live-cards init <dir>
 *   board-live-cards status --rg <dir>
 *   board-live-cards add-card --rg <dir> --card <card.json>
 *
 * Card transform:
 *   liveCardToTaskConfig(card) — LiveCard → TaskConfig (handler mapping)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lockSync } from 'proper-lockfile';
import { restore } from '../continuous-event-graph/core.js';
import type { LiveGraph, LiveGraphSnapshot } from '../continuous-event-graph/types.js';
import type { ReactiveGraph, TaskHandlerFn } from '../continuous-event-graph/reactive.js';
import { createReactiveGraph } from '../continuous-event-graph/reactive.js';
import { createLiveGraph, snapshot } from '../continuous-event-graph/core.js';
import { schedule } from '../continuous-event-graph/schedule.js';
import type { GraphConfig, TaskConfig, GraphEvent } from '../event-graph/types.js';
import type { LiveCard } from '../continuous-event-graph/live-cards-bridge.js';
import type { Journal } from '../continuous-event-graph/journal.js';
import { CardCompute } from '../card-compute/index.js';
import type { ComputeNode, ComputeStep, ComputeSource } from '../card-compute/index.js';

const BOARD_FILE = 'board-graph.json';
const JOURNAL_FILE = 'board-journal.jsonl';
const INVENTORY_FILE = 'cards-inventory.jsonl';
const EMPTY_CONFIG: GraphConfig = { settings: { completion: 'all-tasks-done' }, tasks: {} } as GraphConfig;

/** Envelope stored in board-graph.json — wraps the LiveGraph snapshot with journal pointer. */
export interface BoardEnvelope {
  lastDrainedJournalId: string;
  graph: LiveGraphSnapshot;
}

// ============================================================================
// Board Journal — append-only JSONL with GUID IDs
// ============================================================================

export interface JournalEntry {
  id: string;
  event: GraphEvent;
}

export class BoardJournal implements Journal {
  private readonly journalPath: string;
  private lastDrainedId: string;

  constructor(journalPath: string, lastDrainedJournalId: string) {
    this.journalPath = journalPath;
    this.lastDrainedId = lastDrainedJournalId;
  }

  append(event: GraphEvent): void {
    const entry: JournalEntry = { id: randomUUID(), event };
    fs.appendFileSync(this.journalPath, JSON.stringify(entry) + '\n', 'utf-8');
  }

  drain(): GraphEvent[] {
    if (!fs.existsSync(this.journalPath)) return [];
    const content = fs.readFileSync(this.journalPath, 'utf-8').trim();
    if (!content) return [];
    const entries: JournalEntry[] = content.split('\n').map(l => JSON.parse(l));

    // Find the index of the last drained entry; take everything after it
    let startIdx = 0;
    if (this.lastDrainedId) {
      const drainedIdx = entries.findIndex(e => e.id === this.lastDrainedId);
      if (drainedIdx !== -1) startIdx = drainedIdx + 1;
    }

    const undrained = entries.slice(startIdx);
    if (undrained.length > 0) {
      this.lastDrainedId = undrained[undrained.length - 1].id;
    }
    return undrained.map(e => e.event);
  }

  get size(): number {
    if (!fs.existsSync(this.journalPath)) return 0;
    const content = fs.readFileSync(this.journalPath, 'utf-8').trim();
    if (!content) return 0;
    const entries: JournalEntry[] = content.split('\n').map(l => JSON.parse(l));
    if (!this.lastDrainedId) return entries.length;
    const drainedIdx = entries.findIndex(e => e.id === this.lastDrainedId);
    return drainedIdx === -1 ? entries.length : entries.length - drainedIdx - 1;
  }

  get lastDrainedJournalId(): string {
    return this.lastDrainedId;
  }
}

// ============================================================================
// Cards inventory
// ============================================================================

export interface CardInventoryEntry {
  cardId: string;
  cardFilePath: string;
  addedAt: string;
}

export function readCardInventory(boardDir: string): CardInventoryEntry[] {
  const inventoryPath = path.join(boardDir, INVENTORY_FILE);
  if (!fs.existsSync(inventoryPath)) return [];
  const lines = fs.readFileSync(inventoryPath, 'utf-8').split('\n').filter(l => l.trim());
  return lines.map(l => JSON.parse(l) as CardInventoryEntry);
}

export function lookupCardPath(boardDir: string, cardId: string): string | null {
  const entries = readCardInventory(boardDir);
  const entry = entries.find(e => e.cardId === cardId);
  return entry?.cardFilePath ?? null;
}

export function appendCardInventory(boardDir: string, entry: CardInventoryEntry): void {
  const inventoryPath = path.join(boardDir, INVENTORY_FILE);
  fs.appendFileSync(inventoryPath, JSON.stringify(entry) + '\n');
}

// ============================================================================
// Library
// ============================================================================

/**
 * Initialize a board directory.
 * - Dir doesn't exist → create it, write empty board-graph.json
 * - Dir exists + valid board-graph.json → no-op, return 'exists'
 * - Dir exists + non-empty (no valid board-graph.json) → throw
 */
export function initBoard(dir: string): 'created' | 'exists' {
  const boardPath = path.join(dir, BOARD_FILE);

  if (fs.existsSync(boardPath)) {
    // Validate it's a real board envelope
    const envelope = JSON.parse(fs.readFileSync(boardPath, 'utf-8')) as BoardEnvelope;
    restore(envelope.graph);
    return 'exists';
  }

  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir);
    if (entries.length > 0) {
      throw new Error(`Directory "${dir}" is not empty and has no valid ${BOARD_FILE}`);
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  const live = createLiveGraph(EMPTY_CONFIG);
  const snap = snapshot(live);
  const envelope: BoardEnvelope = { lastDrainedJournalId: '', graph: snap };
  fs.writeFileSync(boardPath, JSON.stringify(envelope, null, 2));
  return 'created';
}

export function loadBoardEnvelope(dir: string): BoardEnvelope {
  const raw = fs.readFileSync(path.join(dir, BOARD_FILE), 'utf-8');
  return JSON.parse(raw) as BoardEnvelope;
}

export function loadBoard(dir: string): LiveGraph {
  const envelope = loadBoardEnvelope(dir);
  return restore(envelope.graph);
}

export function saveBoard(dir: string, rg: ReactiveGraph, journal: BoardJournal): void {
  const snap = rg.snapshot();
  const envelope: BoardEnvelope = {
    lastDrainedJournalId: journal.lastDrainedJournalId,
    graph: snap,
  };
  fs.writeFileSync(path.join(dir, BOARD_FILE), JSON.stringify(envelope, null, 2));
}

/**
 * Acquire an exclusive lock on the board, run `fn`, then release.
 * Uses proper-lockfile on board-graph.json.
 */
export function withBoardLock<T>(boardDir: string, fn: () => T): T {
  const boardPath = path.join(boardDir, BOARD_FILE);
  const release = lockSync(boardPath, { retries: { retries: 5, minTimeout: 100 } });
  try {
    return fn();
  } finally {
    release();
  }
}

// ============================================================================
// Standalone journal append + opportunistic drain
// ============================================================================

/**
 * Decode a callback token → { taskName } or null if malformed.
 * Mirrors the private encodeCallbackToken format in reactive.ts.
 */
function decodeCallbackToken(token: string): { taskName: string } | null {
  try {
    const payload = JSON.parse(Buffer.from(token, 'base64url').toString());
    if (typeof payload?.t === 'string') return { taskName: payload.t };
    return null;
  } catch { return null; }
}

/**
 * Append a raw event to the journal file. No lock, no file read.
 * Safe for hundreds of concurrent callers (appendFileSync is atomic for small writes).
 */
export function appendEventToJournal(boardDir: string, event: GraphEvent): void {
  const journalPath = path.join(boardDir, JOURNAL_FILE);
  const entry: JournalEntry = { id: randomUUID(), event };
  fs.appendFileSync(journalPath, JSON.stringify(entry) + '\n', 'utf-8');
}

/**
 * Read journal entries after the given ID. Pure file read, no mutation.
 */
export function getUndrainedEntries(boardDir: string, lastDrainedId: string): JournalEntry[] {
  const journalPath = path.join(boardDir, JOURNAL_FILE);
  if (!fs.existsSync(journalPath)) return [];
  const content = fs.readFileSync(journalPath, 'utf-8').trim();
  if (!content) return [];
  const entries: JournalEntry[] = content.split('\n').map(l => JSON.parse(l));
  if (!lastDrainedId) return entries;
  const idx = entries.findIndex(e => e.id === lastDrainedId);
  return idx === -1 ? entries : entries.slice(idx + 1);
}

/**
 * Try to acquire lock, drain the journal, and save. Non-blocking.
 * If the lock is held by another process, returns false — that process will drain.
 * Returns true if the drain cycle was executed.
 */
export function tryDrainCycle(boardDir: string): boolean {
  const boardPath = path.join(boardDir, BOARD_FILE);
  let release: (() => void) | undefined;
  try {
    release = lockSync(boardPath, { retries: 0 });
  } catch {
    // Lock held by another process — it will drain our entries
    return false;
  }
  try {
    const { rg, journal } = createBoardReactiveGraph(boardDir);
    while (getUndrainedEntries(boardDir, journal.lastDrainedJournalId).length > 0) {
      rg.pushAll([]);
    }
    saveBoard(boardDir, rg, journal);
    rg.dispose();
    return true;
  } finally {
    release!();
  }
}

// ============================================================================
// Card transform
// ============================================================================

/** LiveCard extended with optional asyncHelpers section. */
export type BoardLiveCard = LiveCard & { asyncHelpers?: Record<string, unknown> };

/**
 * Transform a LiveCard into a TaskConfig for the reactive graph.
 *
 * Every card gets handler: 'card-handler'.
 * The handler inspects the card and decides what to do:
 * run compute, invoke sources, fire asyncHelpers.
 */
export function liveCardToTaskConfig(card: BoardLiveCard): TaskConfig {
  const requires = card.requires;
  const provides = card.provides
    ? card.provides.map(p => p.bindTo)
    : [card.id];

  return {
    requires: requires && requires.length > 0 ? requires : undefined,
    provides,
    taskHandlers: ['card-handler'],
    description: card.meta?.title ?? card.id,
  };
}

// ============================================================================
// Reactive graph factory
// ============================================================================

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Spin up a ReactiveGraph from a board directory with all handlers wired.
 *
 * Single handler:
 *   card-handler — spawns source-handler.js <card-path> <callbackToken>
 *                  source-handler.js inspects the card and handles everything:
 *                  compute (CardCompute.run), source invocation, asyncHelpers.
 *                  Fire & forget — returns 'task-initiated' immediately.
 */
export interface BoardReactiveGraph {
  rg: ReactiveGraph;
  journal: BoardJournal;
}

export function createBoardReactiveGraph(boardDir: string): BoardReactiveGraph {
  const envelope = loadBoardEnvelope(boardDir);
  const live = restore(envelope.graph);
  const journalPath = path.join(boardDir, JOURNAL_FILE);
  const journal = new BoardJournal(journalPath, envelope.lastDrainedJournalId);

  const handlers: Record<string, TaskHandlerFn> = {
    'card-handler': async (input) => {
      const cardPath = lookupCardPath(boardDir, input.nodeId);
      if (!cardPath) return 'task-initiate-failure';

      // Lock the card file for read (never for write — card-handler never mutates card.json)
      const releaseCard = lockSync(cardPath, { retries: { retries: 5, minTimeout: 100 } });
      let card: Record<string, unknown>;
      try {
        card = JSON.parse(fs.readFileSync(cardPath, 'utf-8'));
        const cardState = (card.state ?? {}) as Record<string, unknown>;

        // Merge sources and optionalSources (backward compat) into one unified array.
        // Legacy cards may have optionalSources as a separate top-level array.
        const allSources: ComputeSource[] = [
          ...((card.sources ?? []) as ComputeSource[]),
          ...((card.optionalSources ?? []) as ComputeSource[]).map(s => ({ ...s, optional: true as const })),
        ];

        // Load already-delivered sources from their outputFiles into the sources context.
        // outputFile-based delivery: the file existing = the source has delivered.
        // Legacy sources (no outputFile) fall back to cardState[bindTo].
        const sourcesData: Record<string, unknown> = {};
        for (const src of allSources) {
          if (src.outputFile) {
            const filePath = path.join(boardDir, src.outputFile);
            if (fs.existsSync(filePath)) {
              const raw = fs.readFileSync(filePath, 'utf-8').trim();
              try { sourcesData[src.bindTo] = JSON.parse(raw); }
              catch { sourcesData[src.bindTo] = raw; }
            }
          } else if (cardState[src.bindTo] != null) {
            // Legacy: sourced via state (pre-outputFile cards)
            sourcesData[src.bindTo] = cardState[src.bindTo];
          }
        }

        // Build compute node with sources definitions (for resolve() and context)
        const computeNode: ComputeNode = {
          id: card.id as string,
          state: { ...cardState },
          requires: input.state ?? {},
          sources: allSources,
          compute: card.compute as ComputeStep[] | undefined,
        };

        // Run compute with sources context injected
        if (card.compute) {
          await CardCompute.run(computeNode, { sourcesData });
        }

        // Check for undelivered required sources:
        //   outputFile-based: undelivered iff the file does not yet exist
        //   legacy (no outputFile): undelivered iff cardState[bindTo] is null
        const undeliveredRequired = allSources.filter(s => {
          if (s.optional) return false;
          if (s.outputFile) return !fs.existsSync(path.join(boardDir, s.outputFile));
          return cardState[s.bindTo] == null; // legacy fallback
        });

        if (undeliveredRequired.length > 0) {
          // Spawn execute-card-task to run source scripts; it will retrigger on delivery.
          // card-handler NEVER writes card.json — sources write to their outputFiles.
          const scriptPath = path.join(__dirname, 'execute-card-task.js');
          execFile('node', [scriptPath, cardPath, input.callbackToken, boardDir], (err) => {
            if (err) console.error(`[card-handler] ${input.nodeId}:`, err.message);
          });
          return 'task-initiated';
        }

        // All required sources delivered (or no sources required).
        // Build provides data via explicit src paths — sources.* resolves from sourcesData.
        const providesBindings = (card.provides ?? [{ bindTo: card.id as string, src: `state.${card.id}` }]) as { bindTo: string; src: string }[];
        const data: Record<string, unknown> = {};
        for (const { bindTo, src } of providesBindings) {
          data[bindTo] = CardCompute.resolve(computeNode, src);
        }

        // Spawn undelivered optional sources in background (don't gate completion)
        const undeliveredOptional = allSources.filter(s => {
          if (!s.optional) return false;
          if (s.outputFile) return !fs.existsSync(path.join(boardDir, s.outputFile));
          return cardState[s.bindTo] == null;
        });
        if (undeliveredOptional.length > 0 || (card as any).asyncHelpers) {
          const scriptPath = path.join(__dirname, 'execute-card-task.js');
          execFile('node', [scriptPath, cardPath, input.callbackToken, boardDir], (err) => {
            if (err) console.error(`[card-handler] ${input.nodeId}:`, err.message);
          });
        }

        appendEventToJournal(boardDir, {
          type: 'task-completed',
          taskName: input.nodeId,
          data,
          timestamp: new Date().toISOString(),
        });
        return 'task-initiated';
      } finally {
        releaseCard();
      }
    },
  };

  const rg = createReactiveGraph(live, { handlers, journal });
  return { rg, journal };
}

// ============================================================================
// CLI
// ============================================================================

function cmdAddCard(args: string[]): void {
  const rgIdx = args.indexOf('--rg');
  const cardIdx = args.indexOf('--card');
  const dir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
  const cardFile = cardIdx !== -1 ? args[cardIdx + 1] : undefined;
  if (!dir || !cardFile) {
    console.error('Usage: board-live-cards add-card --rg <dir> --card <card.json>');
    process.exit(1);
  }

  const absCardPath = path.resolve(cardFile);
  if (!fs.existsSync(absCardPath)) {
    console.error(`Card file not found: ${absCardPath}`);
    process.exit(1);
  }

  const card: BoardLiveCard = JSON.parse(fs.readFileSync(absCardPath, 'utf-8'));
  if (!card.id) {
    console.error('Card JSON must have an "id" field');
    process.exit(1);
  }

  // Check for duplicate
  const existing = readCardInventory(dir);
  if (existing.some(e => e.cardId === card.id)) {
    console.error(`Card "${card.id}" already exists in inventory`);
    process.exit(1);
  }

  // Append to inventory first — handlers need it to look up card paths
  appendCardInventory(dir, {
    cardId: card.id,
    cardFilePath: absCardPath,
    addedAt: new Date().toISOString(),
  });

  // Transform card → TaskConfig
  const taskConfig = liveCardToTaskConfig(card);

  // 1. Append task-upsert event to journal (no lock)
  appendEventToJournal(dir, {
    type: 'task-upsert',
    taskName: card.id,
    taskConfig,
    timestamp: new Date().toISOString(),
  });

  // 2. Try to drain — if locked, another process will drain our entry
  const drained = tryDrainCycle(dir);

  console.log(`Card "${card.id}" added to board at ${path.resolve(dir)}${drained ? '' : ' (drain deferred)'}`);
  console.log(`  taskHandlers: [${taskConfig.taskHandlers?.join(', ') ?? ''}]`);
  console.log(`  provides: [${taskConfig.provides.join(', ')}]`);
  if (taskConfig.requires) console.log(`  requires: [${taskConfig.requires.join(', ')}]`);
}

function cmdInit(args: string[]): void {
  const dir = args[0];
  if (!dir) { console.error('Usage: board-live-cards init <dir>'); process.exit(1); }

  const result = initBoard(dir);
  if (result === 'exists') {
    console.log(`Board already initialized at ${path.resolve(dir)}`);
  } else {
    console.log(`Board initialized at ${path.resolve(dir)}`);
  }
}

function cmdStatus(args: string[]): void {
  const rgIdx = args.indexOf('--rg');
  const dir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
  if (!dir) { console.error('Usage: board-live-cards status --rg <dir>'); process.exit(1); }

  const live = loadBoard(dir);
  const tasks = live.state.tasks;
  const taskNames = Object.keys(tasks);
  const sched = schedule(live);

  console.log(`Board: ${path.resolve(dir)}`);
  console.log(`Tasks: ${taskNames.length}`);
  console.log('');

  for (const name of taskNames.sort()) {
    const t = tasks[name];
    const dataKeys = t.data ? Object.keys(t.data).join(', ') : '';
    console.log(`  ${t.status.padEnd(12)} ${name}${dataKeys ? ` — [${dataKeys}]` : ''}`);
  }

  console.log('');
  console.log(`Schedule: ${sched.eligible.length} eligible, ${sched.pending.length} pending, ${sched.blocked.length} blocked, ${sched.unresolved.length} unresolved`);
}

function cmdTaskCompleted(args: string[]): void {
  const rgIdx = args.indexOf('--rg');
  const tokenIdx = args.indexOf('--token');
  const dataIdx = args.indexOf('--data');
  const dir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
  const token = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;
  if (!dir || !token) {
    console.error('Usage: board-live-cards task-completed --rg <dir> --token <token> [--data <json>]');
    process.exit(1);
  }

  const decoded = decodeCallbackToken(token);
  if (!decoded) {
    console.error('Invalid callback token');
    process.exit(1);
  }

  const data: Record<string, unknown> = dataIdx !== -1
    ? JSON.parse(args[dataIdx + 1])
    : {};

  // 1. Append event to journal (no lock)
  appendEventToJournal(dir, {
    type: 'task-completed',
    taskName: decoded.taskName,
    data,
    timestamp: new Date().toISOString(),
  });

  // 2. Try to drain — if locked, another process will drain our entry
  const drained = tryDrainCycle(dir);
  console.log(drained ? 'Task completed — drained.' : 'Task completed — journaled (drain deferred).');
}

function cmdTaskFailed(args: string[]): void {
  const rgIdx = args.indexOf('--rg');
  const tokenIdx = args.indexOf('--token');
  const errorIdx = args.indexOf('--error');
  const dir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
  const token = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;
  const errorMsg = errorIdx !== -1 ? args[errorIdx + 1] : 'unknown error';
  if (!dir || !token) {
    console.error('Usage: board-live-cards task-failed --rg <dir> --token <token> [--error <message>]');
    process.exit(1);
  }

  const decoded = decodeCallbackToken(token);
  if (!decoded) {
    console.error('Invalid callback token');
    process.exit(1);
  }

  // 1. Append event to journal (no lock)
  appendEventToJournal(dir, {
    type: 'task-failed',
    taskName: decoded.taskName,
    error: errorMsg,
    timestamp: new Date().toISOString(),
  });

  // 2. Try to drain — if locked, another process will drain our entry
  const drained = tryDrainCycle(dir);
  console.log(drained ? 'Task failed — drained.' : 'Task failed — journaled (drain deferred).');
}

function cmdRemoveCard(args: string[]): void {
  const rgIdx = args.indexOf('--rg');
  const idIdx = args.indexOf('--id');
  const dir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
  const cardId = idIdx !== -1 ? args[idIdx + 1] : undefined;
  if (!dir || !cardId) {
    console.error('Usage: board-live-cards remove-card --rg <dir> --id <card-id>');
    process.exit(1);
  }

  appendEventToJournal(dir, {
    type: 'task-removal',
    taskName: cardId,
    timestamp: new Date().toISOString(),
  });

  const drained = tryDrainCycle(dir);
  console.log(`Card "${cardId}" removed${drained ? '' : ' (drain deferred)'}.`);
}

function cmdUpdateCard(args: string[]): void {
  const rgIdx = args.indexOf('--rg');
  const idIdx = args.indexOf('--card-id');
  const restart = args.includes('--restart');
  const dir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
  const cardId = idIdx !== -1 ? args[idIdx + 1] : undefined;
  if (!dir || !cardId) {
    console.error('Usage: board-live-cards update-card --rg <dir> --card-id <card-id> [--restart]');
    process.exit(1);
  }

  // 1. Look up card in inventory
  const cardPath = lookupCardPath(dir, cardId);
  if (!cardPath) {
    console.error(`Card "${cardId}" not found in inventory`);
    process.exit(1);
  }

  // 2. Validate card file exists on disk
  if (!fs.existsSync(cardPath)) {
    console.error(`Card file not found: ${cardPath}`);
    process.exit(1);
  }

  // 3. Read updated card, transform to TaskConfig, upsert
  const card: BoardLiveCard = JSON.parse(fs.readFileSync(cardPath, 'utf-8'));
  const taskConfig = liveCardToTaskConfig(card);

  appendEventToJournal(dir, {
    type: 'task-upsert',
    taskName: cardId,
    taskConfig,
    timestamp: new Date().toISOString(),
  });

  // 4. Optionally restart the task so handler re-runs with updated card
  if (restart) {
    appendEventToJournal(dir, {
      type: 'task-restart',
      taskName: cardId,
      timestamp: new Date().toISOString(),
    });
  }

  // 5. Drain
  const drained = tryDrainCycle(dir);
  console.log(`Card "${cardId}" updated${restart ? ' (restarted)' : ''}${drained ? '' : ' (drain deferred)'}.`);
}

function cmdRetrigger(args: string[]): void {
  const rgIdx = args.indexOf('--rg');
  const taskIdx = args.indexOf('--task');
  const dir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
  const taskName = taskIdx !== -1 ? args[taskIdx + 1] : undefined;
  if (!dir || !taskName) {
    console.error('Usage: board-live-cards retrigger --rg <dir> --task <task-name>');
    process.exit(1);
  }

  appendEventToJournal(dir, {
    type: 'task-restart',
    taskName,
    timestamp: new Date().toISOString(),
  });

  const drained = tryDrainCycle(dir);
  console.log(`Task "${taskName}" retriggered${drained ? '' : ' (drain deferred)'}.`);
}

export function cli(argv: string[]): void {
  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'init':           return cmdInit(rest);
    case 'status':         return cmdStatus(rest);
    case 'add-card':       return cmdAddCard(rest);
    case 'update-card':    return cmdUpdateCard(rest);
    case 'remove-card':    return cmdRemoveCard(rest);
    case 'retrigger':      return cmdRetrigger(rest);
    case 'task-completed': return cmdTaskCompleted(rest);
    case 'task-failed':    return cmdTaskFailed(rest);
    default:
      console.error(`Unknown command: ${cmd}`);
      console.error('Commands: init, status, add-card, update-card, remove-card, retrigger, task-completed, task-failed');
      process.exit(1);
  }
}

// Run when invoked directly
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
if (isMain) {
  cli(process.argv.slice(2));
}
