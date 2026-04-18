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
 *   board-live-cards run-sources --card <card.json> --token <callbackToken> --rg <dir>
 *
 * Card transform:
 *   liveCardToTaskConfig(card) — LiveCard → TaskConfig (handler mapping)
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
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
const EMPTY_CONFIG: GraphConfig = { settings: { completion: 'manual', refreshStrategy: 'data-changed' }, tasks: {} } as GraphConfig;

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

// ============================================================================
// Source token — per-source opaque token carrying all delivery metadata
// ============================================================================

export interface SourceTokenPayload {
  /** Original callback token from the reactive graph (encodes taskName) */
  cbk: string;
  /** Board directory (absolute path) */
  rg: string;
  /** Card id */
  cid: string;
  /** sources[].bindTo */
  b: string;
  /** sources[].outputFile (relative to boardDir) */
  d: string;
}

export function encodeSourceToken(payload: SourceTokenPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeSourceToken(token: string): SourceTokenPayload | null {
  try {
    const p = JSON.parse(Buffer.from(token, 'base64url').toString());
    if (typeof p?.cbk === 'string' && typeof p?.cid === 'string' && typeof p?.b === 'string' && typeof p?.d === 'string') {
      return p as SourceTokenPayload;
    }
    return null;
  } catch { return null; }
}

// ============================================================================
// Runtime state sidecar — <cardId>.runtime.json
// ============================================================================

export interface SourceRuntimeEntry {
  lastRequestedAt?: string;
  lastFetchedAt?: string;
  lastError?: string;
}

export interface CardRuntimeState {
  _sources: Record<string, SourceRuntimeEntry>;
}

function runtimePath(boardDir: string, cardId: string): string {
  return path.join(boardDir, `${cardId}.runtime.json`);
}

function readRuntimeState(boardDir: string, cardId: string): CardRuntimeState {
  const p = runtimePath(boardDir, cardId);
  if (!fs.existsSync(p)) return { _sources: {} };
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as CardRuntimeState; }
  catch { return { _sources: {} }; }
}

function writeRuntimeState(boardDir: string, cardId: string, state: CardRuntimeState): void {
  fs.writeFileSync(runtimePath(boardDir, cardId), JSON.stringify(state, null, 2));
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
 * Schedule repeated drain attempts in-process until the journal settles.
 * This avoids spawning detached child processes/windows.
 */
function spawnTryDrain(boardDir: string): void {
  // Run drain inline in the same process (no subprocess / no cmd window).
  // Loops until the journal is fully settled.
  const MAX_PASSES = 200;
  const SETTLE_DELAY_MS = 50;
  let pass = 0;

  function loop(): void {
    if (pass++ >= MAX_PASSES) {
      console.warn('[try-drain] Reached max passes — journal may still have pending entries');
      return;
    }
    const ran = tryDrainCycle(boardDir);
    if (!ran) return; // lock held — another drainer is running
    setTimeout(() => {
      if (getUndrainedEntries(boardDir, loadBoardEnvelope(boardDir).lastDrainedJournalId).length > 0) {
        loop();
      }
    }, SETTLE_DELAY_MS);
  }

  loop();
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
    // Explicitly drain the external journal and push events into the reactive graph.
    // The engine never reads from external storage — the caller owns that boundary.
    const undrained = journal.drain();
    rg.pushAll(undrained);
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

export type BoardLiveCard = LiveCard;

/**
 * Transform a LiveCard into a TaskConfig for the reactive graph.
 *
 * Every card gets handler: 'card-handler'.
 * The handler inspects the card and decides what to do:
 * run compute, invoke sources.
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
 * Generalized CLI invocation: determines how to invoke this script in current environment.
 * Returns { cmd, args } suitable for execFile() or execFileSync().
 */
function getCliInvocation(command: string, args: string[]): { cmd: string; args: string[] } {
  // Check if we have a .js file (built/published)
  const jsPath = path.join(__dirname, 'board-live-cards.js');
  if (fs.existsSync(jsPath)) {
    return { cmd: 'node', args: [jsPath, command, ...args] };
  }
  // Fall back to .ts with tsx runner (dev environment)
  const tsPath = path.join(__dirname, 'board-live-cards.ts');
  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return { cmd: npxCmd, args: ['tsx', tsPath, command, ...args] };
}

function invokeRunSources(boardDir: string, cardPath: string, callbackToken: string, callback: (err?: Error) => void): void {
  const { cmd, args } = getCliInvocation('run-sources', ['--card', cardPath, '--token', callbackToken, '--rg', boardDir]);
  const child = spawn(cmd, args, {
    shell: true,
    detached: true,
    stdio: 'ignore',
  });
  child.on('error', callback);
  child.unref();
  callback();
}

function invokeSourceDataFetched(sourceToken: string, tmpFile: string, callback: (err?: Error) => void): void {
  const { cmd, args } = getCliInvocation('source-data-fetched', ['--tmp', tmpFile, '--token', sourceToken]);
  execFile(cmd, args, { shell: true }, (err, stdout, stderr) => {
    if (err) console.error(`[source-data-fetched] call failed:`, err.message);
    if (stdout) console.log(stdout.trim());
    if (stderr) console.error(stderr.trim());
    callback(err);
  });
}

function invokeSourceDataFetchFailure(sourceToken: string, reason: string, callback: (err?: Error) => void): void {
  const { cmd, args } = getCliInvocation('source-data-fetch-failure', ['--token', sourceToken, '--reason', reason]);
  execFile(cmd, args, { shell: true }, callback);
}

/**
 * Spin up a ReactiveGraph from a board directory with all handlers wired.
 *
 * Single handler:
 *   card-handler — reads card.json, loads sourcesData from outputFiles, runs CardCompute,
 *                  checks undelivered sources, emits task-completed or spawns run-sources.
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

      const card = JSON.parse(fs.readFileSync(cardPath, 'utf-8')) as Record<string, unknown>;
        const cardId = card.id as string;
        const cardState = (card.state ?? {}) as Record<string, unknown>;
        const allSources: ComputeSource[] = (card.sources ?? []) as ComputeSource[];
        const requiredSources = allSources.filter(s => !s.optional);

        // Read (or initialise) the runtime sidecar
        const runtime = readRuntimeState(boardDir, cardId);
        let runtimeDirty = false;

        // ---- Handle a task-progress re-invocation (source delivery or failure) ----
        if (input.update) {
          const u = input.update;
          const bindTo = u.bindTo as string;
          if (!runtime._sources[bindTo]) runtime._sources[bindTo] = {};

          if (u.failure) {
            // Source fetch failed — record error, stay in-progress
            runtime._sources[bindTo].lastError = (u.reason as string | undefined) ?? 'unknown';
            delete runtime._sources[bindTo].lastFetchedAt;
            runtimeDirty = true;
            console.log(`[card-handler] source "${bindTo}" fetch failed: ${runtime._sources[bindTo].lastError}`);
          } else {
            // Successful delivery — dest file already renamed into place by CLI
            runtime._sources[bindTo].lastFetchedAt = (u.fetchedAt as string | undefined) ?? new Date().toISOString();
            delete runtime._sources[bindTo].lastError;
            runtimeDirty = true;
            console.log(`[card-handler] source "${bindTo}" delivered → ${u.dest}`);
          }

          if (runtimeDirty) writeRuntimeState(boardDir, cardId, runtime);
        }

        // ---- Load sourcesData from outputFiles ----
        const sourcesData: Record<string, unknown> = {};
        for (const src of allSources) {
          if (src.outputFile) {
            const filePath = path.join(boardDir, src.outputFile);
            if (fs.existsSync(filePath)) {
              const raw = fs.readFileSync(filePath, 'utf-8').trim();
              try { sourcesData[src.bindTo] = JSON.parse(raw); }
              catch { sourcesData[src.bindTo] = raw; }
            }
          }
        }

        // ---- Run compute ----
        const computeNode: ComputeNode = {
          id: cardId,
          state: { ...cardState },
          requires: input.state ?? {},
          sources: allSources,
          compute: card.compute as ComputeStep[] | undefined,
        };
        if (card.compute) {
          await CardCompute.run(computeNode, { sourcesData });
          const cvPath = path.join(boardDir, `${cardId}.computed_values.json`);
          fs.writeFileSync(cvPath, JSON.stringify(computeNode.computed_values ?? {}, null, 2));
        }

        // ---- Delivery check: lastFetchedAt > lastRequestedAt for all required sources ----
        const now = new Date().toISOString();
        const undeliveredRequired = requiredSources.filter(s => {
          if (!s.outputFile) return false;
          const entry = runtime._sources[s.bindTo];
          if (!entry?.lastRequestedAt) return true;  // never requested — treat as undelivered
          if (!entry.lastFetchedAt) return true;      // requested but not yet fetched
          return entry.lastFetchedAt <= entry.lastRequestedAt; // stale
        });

        if (undeliveredRequired.length > 0) {
          // First-time or re-request: stamp lastRequestedAt for any not-yet-requested sources
          // and invoke run-sources to deliver them.
          let stampedAny = false;
          for (const src of undeliveredRequired) {
            const entry = runtime._sources[src.bindTo] ?? {};
            // Only re-stamp if not already requested after last fetch (avoid double-dispatch)
            if (!entry.lastRequestedAt || (entry.lastFetchedAt && entry.lastFetchedAt >= entry.lastRequestedAt)) {
              entry.lastRequestedAt = now;
              runtime._sources[src.bindTo] = entry;
              stampedAny = true;
            }
          }
          if (stampedAny) writeRuntimeState(boardDir, cardId, runtime);

          invokeRunSources(boardDir, cardPath, input.callbackToken, (err) => {
            if (err) console.error(`[card-handler] ${input.nodeId}:`, err.message);
          });
          return 'task-initiated';
        }

        // ---- All required sources delivered — build provides + emit task-completed ----
        const providesBindings = (card.provides ?? [{ bindTo: cardId, src: `state.${cardId}` }]) as { bindTo: string; src: string }[];
        const data: Record<string, unknown> = {};
        for (const { bindTo, src } of providesBindings) {
          data[bindTo] = CardCompute.resolve(computeNode, src);
        }

        // Spawn undelivered optional sources in background
        const undeliveredOptional = allSources.filter(s => {
          if (!s.optional || !s.outputFile) return false;
          const entry = runtime._sources[s.bindTo];
          if (!entry?.lastRequestedAt) return true;
          if (!entry.lastFetchedAt) return true;
          return entry.lastFetchedAt <= entry.lastRequestedAt;
        });
        if (undeliveredOptional.length > 0) {
          invokeRunSources(boardDir, cardPath, input.callbackToken, (err) => {
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
    },
  };

  const rg = createReactiveGraph(live, { handlers });
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

  spawnTryDrain(dir);

  console.log(`Card "${card.id}" added to board at ${path.resolve(dir)} (drain scheduled)`);
  console.log(`  taskHandlers: [${taskConfig.taskHandlers?.join(', ') ?? ''}]`);
  console.log(`  provides: [${taskConfig.provides.join(', ')}]`);
  if (taskConfig.requires) console.log(`  requires: [${taskConfig.requires.join(', ')}]`);
}

function cmdInit(args: string[]): void {
  const dir = args[0];
  if (!dir) { console.error('Usage: board-live-cards init <dir> [--task-executor <script>]'); process.exit(1); }

  const teIdx = args.indexOf('--task-executor');
  const taskExecutor = teIdx !== -1 ? args[teIdx + 1] : undefined;

  const result = initBoard(dir);

  if (taskExecutor) {
    fs.writeFileSync(path.join(dir, '.task-executor'), taskExecutor, 'utf-8');
  }

  if (result === 'exists') {
    console.log(`Board already initialized at ${path.resolve(dir)}${taskExecutor ? ` (task-executor updated: ${taskExecutor})` : ''}`);
  } else {
    console.log(`Board initialized at ${path.resolve(dir)}${taskExecutor ? ` (task-executor: ${taskExecutor})` : ''}`);
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

  spawnTryDrain(dir);
  console.log('Task completed.');
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

  spawnTryDrain(dir);
  console.log('Task failed.');
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

  spawnTryDrain(dir);
  console.log(`Card "${cardId}" removed.`);
}

function cmdSourceDataFetched(args: string[]): void {
  const tmpIdx = args.indexOf('--tmp');
  const tokenIdx = args.indexOf('--token');
  const tmpFile = tmpIdx !== -1 ? args[tmpIdx + 1] : undefined;
  const token = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;
  if (!tmpFile || !token) {
    console.error('Usage: board-live-cards source-data-fetched --tmp <tmp-file> --token <sourceToken>');
    process.exit(1);
  }

  const payload = decodeSourceToken(token);
  if (!payload) {
    console.error('Invalid source token');
    process.exit(1);
  }

  const { cbk, rg, cid, b, d } = payload;
  const destPath = path.join(rg, d);

  // Atomic move: rename from tmp into boardDir destination
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.renameSync(tmpFile, destPath);
  console.log(`[source-data-fetched] ${cid}.${b} → ${d}`);

  const fetchedAt = new Date().toISOString();
  const cbkDecoded = decodeCallbackToken(cbk);
  if (!cbkDecoded) {
    console.error('Invalid callback token embedded in source token');
    process.exit(1);
  }

  appendEventToJournal(rg, {
    type: 'task-progress',
    taskName: cbkDecoded.taskName,
    update: { bindTo: b, fetchedAt, dest: d },
    timestamp: fetchedAt,
  });

  tryDrainCycle(rg);
}

function cmdSourceDataFetchFailure(args: string[]): void {
  const tokenIdx = args.indexOf('--token');
  const reasonIdx = args.indexOf('--reason');
  const token = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;
  const reason = reasonIdx !== -1 ? args[reasonIdx + 1] : 'unknown';
  if (!token) {
    console.error('Usage: board-live-cards source-data-fetch-failure --token <sourceToken> [--reason <msg>]');
    process.exit(1);
  }

  const payload = decodeSourceToken(token);
  if (!payload) {
    console.error('Invalid source token');
    process.exit(1);
  }

  const { cbk, rg, cid, b } = payload;
  console.log(`[source-data-fetch-failure] ${cid}.${b}: ${reason}`);

  const cbkDecoded = decodeCallbackToken(cbk);
  if (!cbkDecoded) {
    console.error('Invalid callback token embedded in source token');
    process.exit(1);
  }

  const timestamp = new Date().toISOString();
  appendEventToJournal(rg, {
    type: 'task-progress',
    taskName: cbkDecoded.taskName,
    update: { bindTo: b, failure: true, reason },
    timestamp,
  });

  tryDrainCycle(rg);
}

function cmdRunSources(args: string[]): void {
  const cardIdx = args.indexOf('--card');
  const tokenIdx = args.indexOf('--token');
  const rgIdx = args.indexOf('--rg');
  const cardFilePath = cardIdx !== -1 ? args[cardIdx + 1] : undefined;
  const callbackToken = tokenIdx !== -1 ? args[tokenIdx + 1] : undefined;
  const boardDir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
  if (!cardFilePath || !callbackToken || !boardDir) {
    console.error('Usage: board-live-cards run-sources --card <path> --token <token> --rg <dir>');
    process.exit(1);
  }

  const card = JSON.parse(fs.readFileSync(cardFilePath, 'utf-8'));
  console.log(`[run-sources] Processing card "${card.id as string}"`);

  // Load registered task-executor (if any)
  const executorFile = path.join(boardDir!, '.task-executor');
  const taskExecutor = fs.existsSync(executorFile) ? fs.readFileSync(executorFile, 'utf-8').trim() : undefined;

  type SourceDef = { script?: string; bindTo: string; outputFile?: string; optional?: boolean; timeout?: number };

  function runSource(src: SourceDef): void {
    const sourceToken = encodeSourceToken({
      cbk: callbackToken!,
      rg: boardDir!,
      cid: card.id as string,
      b: src.bindTo,
      d: src.outputFile ?? '',
    });

    function reportFailure(reason: string): void {
      invokeSourceDataFetchFailure(sourceToken, reason, (e) => {
        if (e) console.error(`[run-sources] source-data-fetch-failure call failed:`, e.message);
      });
    }

    function reportFetched(outFile: string): void {
      invokeSourceDataFetched(sourceToken, outFile, (e) => {
        // logging already done in helper
      });
    }

    if (taskExecutor) {
      // External task-executor registered: invoke run-source-fetch subcommand
      if (!src.outputFile) {
        console.warn(`[run-sources] source "${src.bindTo}" has no outputFile configured — cannot deliver`);
        reportFailure('no outputFile configured');
        return;
      }
      const inFile  = path.join(os.tmpdir(), `card-source-in-${src.bindTo}-${Date.now()}.json`);
      const outFile = path.join(os.tmpdir(), `card-source-out-${src.bindTo}-${Date.now()}.json`);
      const errFile = path.join(os.tmpdir(), `card-source-err-${src.bindTo}-${Date.now()}.txt`);
      fs.writeFileSync(inFile, JSON.stringify(src, null, 2), 'utf-8');
      console.log(`[run-sources] task-executor: ${taskExecutor} run-source-fetch --in ${inFile} --out ${outFile} --err ${errFile}`);
      try {
        execFileSync(taskExecutor, ['run-source-fetch', '--in', inFile, '--out', outFile, '--err', errFile], {
          shell: true,
          timeout: src.timeout ?? 120_000,
        });
      } catch (err: unknown) {
        const reason = (err as Error).message ?? String(err);
        console.error(`[run-sources] task-executor failed for source "${src.bindTo}":`, reason);
        reportFailure(reason);
        return;
      }
      if (fs.existsSync(outFile)) {
        reportFetched(outFile);
      } else {
        const errMsg = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf-8').trim() : 'executor produced no output file';
        console.warn(`[run-sources] source "${src.bindTo}": ${errMsg}`);
        reportFailure(errMsg);
      }
      return;
    }

    // No external executor: use board-live-cards run-source-fetch as the executor
    if (!src.outputFile) {
      console.warn(`[run-sources] source "${src.bindTo}" has no outputFile configured — cannot deliver`);
      reportFailure('no outputFile configured');
      return;
    }
    const inFile  = path.join(os.tmpdir(), `card-source-in-${src.bindTo}-${Date.now()}.json`);
    const outFile = path.join(os.tmpdir(), `card-source-out-${src.bindTo}-${Date.now()}.json`);
    const errFile = path.join(os.tmpdir(), `card-source-err-${src.bindTo}-${Date.now()}.txt`);
    fs.writeFileSync(inFile, JSON.stringify(src, null, 2), 'utf-8');
    
    const { cmd, args: baseArgs } = getCliInvocation('run-source-fetch', ['--in', inFile, '--out', outFile, '--err', errFile]);
    console.log(`[run-sources] run-source-fetch: ${cmd} ${baseArgs.join(' ')}`);
    try {
      execFileSync(cmd, baseArgs, {
        shell: true,
        timeout: src.timeout ?? 120_000,
      });
    } catch (err: unknown) {
      const reason = (err as Error).message ?? String(err);
      console.error(`[run-sources] run-source-fetch failed for source "${src.bindTo}":`, reason);
      reportFailure(reason);
      return;
    }
    if (fs.existsSync(outFile)) {
      reportFetched(outFile);
    } else {
      const errMsg = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf-8').trim() : 'executor produced no output file';
      console.warn(`[run-sources] source "${src.bindTo}": ${errMsg}`);
      reportFailure(errMsg);
    }
  }

  const sources = (card.sources ?? []) as SourceDef[];
  for (const src of sources) {
    runSource(src);
  }
}

/**
 * Run-source-fetch protocol: execute a source definition.
 * Board-live-cards built-in implementation understands source.cli field.
 *
 * Reads source definition from --in, executes its cli field,
 * writes result to --out file. Presence of --out indicates success.
 */
function cmdRunSourceFetch(args: string[]): void {
  const inIdx = args.indexOf('--in');
  const outIdx = args.indexOf('--out');
  const errIdx = args.indexOf('--err');

  const inFile = inIdx !== -1 ? args[inIdx + 1] : undefined;
  const outFile = outIdx !== -1 ? args[outIdx + 1] : undefined;
  const errFile = errIdx !== -1 ? args[errIdx + 1] : undefined;

  if (!inFile || !outFile) {
    console.error('Usage: board-live-cards run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]');
    process.exit(1);
  }

  if (!fs.existsSync(inFile)) {
    const msg = `Input file not found: ${inFile}`;
    if (errFile) fs.writeFileSync(errFile, msg);
    console.error(`[run-source-fetch] ${msg}`);
    process.exit(1);
  }

  // Parse source definition
  let source: any;
  try {
    const raw = fs.readFileSync(inFile, 'utf-8');
    source = JSON.parse(raw);
  } catch (err) {
    const msg = `Failed to parse input file: ${(err as Error).message}`;
    if (errFile) fs.writeFileSync(errFile, msg);
    console.error(`[run-source-fetch] ${msg}`);
    process.exit(1);
  }

  // Source must have a cli field (not script)
  if (!source.cli) {
    const msg = 'Source definition missing cli field (board-live-cards built-in executor only understands source.cli)';
    if (errFile) fs.writeFileSync(errFile, msg);
    console.error(`[run-source-fetch] ${msg}`);
    process.exit(1);
  }

  // Execute the source cli command
  console.log(`[run-source-fetch] executing: ${source.cli}`);
  const timeout = source.timeout ?? 120_000;

  let stdout: string;
  try {
    stdout = execFileSync(source.cli, {
      shell: true,
      encoding: 'utf-8',
      timeout,
    });
  } catch (err: unknown) {
    const msg = (err as Error).message ?? String(err);
    console.error(`[run-source-fetch] cli failed: ${msg}`);
    if (errFile) fs.writeFileSync(errFile, msg);
    process.exit(1);
  }

  // Write result to --out
  const result = stdout.trim();
  try {
    fs.writeFileSync(outFile, result);
    console.log(`[run-source-fetch] result written to ${outFile}`);
  } catch (err) {
    const msg = `Failed to write output file: ${(err as Error).message}`;
    console.error(`[run-source-fetch] ${msg}`);
    if (errFile) fs.writeFileSync(errFile, msg);
    process.exit(1);
  }
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

  spawnTryDrain(dir);
  console.log(`Card "${cardId}" updated${restart ? ' (restarted)' : ''}.`);
}

/**
 * try-drain — manual command to loop until the journal has fully settled:
 * no undrained entries remain after a full async drain cycle.
 */
async function cmdTryDrain(args: string[]): Promise<void> {
  const rgIdx = args.indexOf('--rg');
  const boardDir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
  if (!boardDir) {
    console.error('Usage: board-live-cards try-drain --rg <dir>');
    process.exit(1);
  }

  const MAX_PASSES = 200;
  const SETTLE_DELAY_MS = 50;

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const ran = tryDrainCycle(boardDir);
    if (!ran) {
      return;
    }
    await new Promise<void>(resolve => setTimeout(resolve, SETTLE_DELAY_MS));
    if (getUndrainedEntries(boardDir, loadBoardEnvelope(boardDir).lastDrainedJournalId).length === 0) {
      return;
    }
  }
  console.warn('[try-drain] Reached max passes — journal may still have pending entries');
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

  spawnTryDrain(dir);
  console.log(`Task "${taskName}" retriggered.`);
}

export async function cli(argv: string[]): Promise<void> {
  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':            return cmdHelp();
    case 'init':           return cmdInit(rest);
    case 'status':         return cmdStatus(rest);
    case 'add-card':       return cmdAddCard(rest);
    case 'update-card':    return cmdUpdateCard(rest);
    case 'remove-card':              return cmdRemoveCard(rest);
    case 'retrigger':                 return cmdRetrigger(rest);
    case 'task-completed':            return cmdTaskCompleted(rest);
    case 'task-failed':               return cmdTaskFailed(rest);
    case 'source-data-fetched':       return cmdSourceDataFetched(rest);
    case 'source-data-fetch-failure': return cmdSourceDataFetchFailure(rest);
    case 'run-sources':               return cmdRunSources(rest);
    case 'run-source-fetch':          return cmdRunSourceFetch(rest);
    case 'try-drain':                 return await cmdTryDrain(rest);
    default:
      console.error(`Unknown command: ${cmd ?? '(none)'}`);
      console.error('Run: board-live-cards help');
      process.exit(1);
  }
}

function cmdHelp(): void {
  console.log(`
bboard-live-cards — LiveCards board CLI

USAGE
  board-live-cards <command> [options]

BOARD MANAGEMENT
  init <dir> [--task-executor <script>]
    Create a new board in <dir>.
    If --task-executor is given, writes <dir>/.task-executor with the script path.
    Re-running init on an existing board is safe; --task-executor updates the registration.

  status --rg <dir>
    Print the current task status of every card in the board.

CARD MANAGEMENT
  add-card --rg <dir> --card <card.json>
    Add a card to the board from a JSON file and trigger it.

  update-card --rg <dir> --card-id <card-id> [--restart]
    Re-read the card JSON from disk and patch the board.
    --restart clears the task so it re-triggers from scratch.

  remove-card --rg <dir> --id <card-id>
    Remove a card and its task from the board.

  retrigger --rg <dir> --task <task-name>
    Mark a task not-started and drain to re-trigger it.

TASK CALLBACKS  (called by task executor scripts)
  task-completed --token <callbackToken> [--data <json>]
    Signal successful task completion with optional JSON result data.

  task-failed --token <callbackToken> [--error <message>]
    Signal task failure with an optional error message.

SOURCE CALLBACKS  (called internally by run-sources)
  source-data-fetched --tmp <file> --token <sourceToken>
    Atomically rename <file> into the outputFile destination and record delivery
    in runtime.json. Appends a task-progress event to re-invoke the card handler.

  source-data-fetch-failure --token <sourceToken> [--reason <message>]
    Record a source fetch failure in runtime.json and append a task-progress event.

INTERNAL COMMANDS
  try-drain --rg <dir>
    Drains the journal until fully settled.
    Can be run manually for diagnostics.

  run-sources --card <card.json> --token <callbackToken> --rg <dir>
    Execute all source[] entries for a card, then report delivery or failure.

    If <dir>/.task-executor exists, invokes it with run-source-fetch subcommand:
      <executor> run-source-fetch --in <source_json> --out <outfile> --err <errfile>
    
    If no .task-executor is registered, uses board-live-cards built-in run-source-fetch.

  run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]
    Execute a source definition. Board-live-cards reads source.cli and executes it.
    Writes result to --out. Presence of --out after exit indicates success.

RUN-SOURCE-FETCH PROTOCOL
  External task-executors implement:
    <executor> run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]

  INPUT:   --in file contains the full sources[x] definition object
  OUTPUT:  --out file is written with the result to signal success.
           --err file may be written to explain failure.
           
  Exit code and --out presence determine success:
    Exit 0 + --out file present → source delivery recorded, card re-evaluated.
    Exit non-zero OR --out absent → source-data-fetch-failure recorded.

BOARD-LIVE-CARDS BUILT-IN EXECUTOR
  Understands source.cli field only:
    "sources": [{ "cli": "node scripts/fetch-prices.js", "bindTo": "prices", "outputFile": "prices.json" }]
    
  The source.cli command is executed with:
    - Shell execution (allows pipes, redirects, environment variables, etc.)
    - Stdout is captured and delivered to the card as-is
    - Timeout from source.timeout (default 120s)
    
  The source.cli command must:
    - Execute successfully (exit 0)
    - Write output to stdout
    - Complete within the timeout
    
  The output format is the concern of the card's compute function to interpret.
    
  External task-executors can interpret source definitions however they want.

EXAMPLES
  board-live-cards init ./my-board
  board-live-cards init ./my-board --task-executor ./executors/my-runner.py
  board-live-cards add-card --rg ./my-board --card cards/prices.json
  board-live-cards status --rg ./my-board
  board-live-cards retrigger --rg ./my-board --task price-fetch
`.trimStart());
}

// Run when invoked directly
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
if (isMain) {
  await cli(process.argv.slice(2));
}
