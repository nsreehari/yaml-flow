/**
 * Board Live Cards — Disk persistence + CLI for ReactiveGraph.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  parseCommandSpec,
  splitCommandLine,
  runSync,
  runAsync,
  runDetached,
} from './process-runner.js';
import fg from 'fast-glob';
import { lockSync } from 'proper-lockfile';
import { restore } from '../continuous-event-graph/core.js';
import type { LiveGraph, LiveGraphSnapshot } from '../continuous-event-graph/types.js';
import type { ReactiveGraph } from '../continuous-event-graph/reactive.js';
import { createReactiveGraph } from '../continuous-event-graph/reactive.js';
import { createLiveGraph, snapshot } from '../continuous-event-graph/core.js';
import type { GraphConfig, TaskConfig, GraphEvent } from '../event-graph/types.js';
import type { LiveCard } from '../continuous-event-graph/live-cards-bridge.js';
import type { Journal } from '../continuous-event-graph/journal.js';
import { validateLiveCardDefinition } from '../card-compute/schema-validator.js';
import { createBoardCommandHandlers } from './board-live-cards-cli-board-commands.js';
import { createCallbackCommandHandlers } from './board-live-cards-cli-callbacks.js';
import { createNonCoreCommandHandlers } from './board-live-cards-cli-noncore.js';
import { createCardCommandHandlers } from './board-live-cards-cli-card-commands.js';
import { createExecutionCommandHandlers } from './board-live-cards-cli-execution-commands.js';
import { createCardHandlerFn } from './board-live-cards-lib-card-handler.js';
import { buildBoardStatusObject } from './board-live-cards-lib-board-status.js';
import {
  createNodeRuntimeStore,
  createNodeOutputStore,
  createNodeInputStore,
  createNodeCardStore,
  createNodeInvocationAdapter,
} from './board-live-cards-lib-node-adapters.js';
import { createNodeStateSnapshotStoreSync } from './board-live-cards-state-snapshot-node.js';
import {
  BOARD_GRAPH_KEY,
  BOARD_LAST_JOURNAL_PROCESSED_ID_KEY,
  SNAPSHOT_SCHEMA_VERSION_V1,
} from './board-live-cards-state-snapshot-types.js';
// Re-export domain types and functions for backward compatibility
import { nextEntryAfterFetchDelivery } from './board-live-cards-lib-types.js';
export type { SourceRuntimeEntry, InferenceRuntimeEntry, FetchRuntimeEntry, SourceTokenPayload } from './board-live-cards-lib-types.js';
export { isSourceInFlight, decideSourceAction, nextEntryAfterFetchDelivery, nextEntryAfterFetchFailure } from './board-live-cards-lib-types.js';

const BOARD_FILE = 'board-graph.json';
const JOURNAL_FILE = 'board-journal.jsonl';
const TASK_EXECUTOR_LOG_FILE = 'task-executor.jsonl';
const INFERENCE_ADAPTER_LOG_FILE = 'inference-adapter.jsonl';
const INVENTORY_FILE = 'cards-inventory.jsonl';
const RUNTIME_OUT_FILE = '.runtime-out';
const DEFAULT_RUNTIME_OUT_DIR = 'runtime-out';
const RUNTIME_STATUS_FILE = 'board-livegraph-status.json';
const RUNTIME_CARDS_DIR = 'cards';
const RUNTIME_DATA_OBJECTS_DIR = 'data-objects';
const INFERENCE_ADAPTER_FILE = '.inference-adapter';
const TASK_EXECUTOR_FILE = '.task-executor';
/** Parsed content of a .task-executor file. command+args form preferred; legacy plain string also accepted. */
interface TaskExecutorConfig {
  command: string;
  args?: string[];
  extra?: Record<string, unknown>;
}

/**
 * Read and parse a .task-executor file.
 * Supports:
 *   { "command": "node", "args": ["executor.js"], "extra": {} }  ← preferred
 *   { "command": "node executor.js", "extra": {} }              ← legacy: command string parsed via splitCommandLine
 *   "node executor.js"                                           ← legacy: plain text
 * Returns a normalized config with command/args ready for execCommandSync.
 */
function readTaskExecutorConfig(boardDir: string): TaskExecutorConfig | undefined {
  const executorFile = path.join(boardDir, TASK_EXECUTOR_FILE);
  if (!fs.existsSync(executorFile)) return undefined;
  const raw = fs.readFileSync(executorFile, 'utf-8').trim();
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && typeof parsed.command === 'string') {
      const spec = parseCommandSpec({ command: parsed.command, args: parsed.args });
      return { command: spec.command, args: spec.args, extra: parsed.extra };
    }
  } catch { /* not JSON — treat as plain command */ }
  const spec = parseCommandSpec(raw);
  return { command: spec.command, args: spec.args };
}
const EMPTY_CONFIG: GraphConfig = { settings: { completion: 'manual', refreshStrategy: 'data-changed' }, tasks: {} } as GraphConfig;

/** Envelope stored in board-graph.json — wraps the LiveGraph snapshot with journal pointer. */
export interface BoardEnvelope {
  lastDrainedJournalId: string;
  graph: LiveGraphSnapshot;
}

const nodeStateSnapshotStore = createNodeStateSnapshotStoreSync({
  boardFileName: BOARD_FILE,
  writeJsonAtomic,
});

function boardEnvelopeToSnapshotEntries(envelope: BoardEnvelope): Record<string, unknown> {
  return {
    [BOARD_GRAPH_KEY]: envelope.graph,
    [BOARD_LAST_JOURNAL_PROCESSED_ID_KEY]: envelope.lastDrainedJournalId,
  };
}

function snapshotEntriesToBoardEnvelope(entries: Record<string, unknown>): BoardEnvelope {
  const graph = entries[BOARD_GRAPH_KEY] as LiveGraphSnapshot | undefined;
  const lastDrainedJournalId = entries[BOARD_LAST_JOURNAL_PROCESSED_ID_KEY] as string | undefined;
  if (!graph || typeof graph !== 'object') {
    throw new Error(`State snapshot is missing required key: ${BOARD_GRAPH_KEY}`);
  }
  return {
    graph,
    lastDrainedJournalId: typeof lastDrainedJournalId === 'string' ? lastDrainedJournalId : '',
  };
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

export interface CardInventoryIndex {
  byCardId: Map<string, CardInventoryEntry>;
  byCardPath: Map<string, CardInventoryEntry>;
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
  const normalized: CardInventoryEntry = { ...entry, cardFilePath: path.resolve(entry.cardFilePath) };
  fs.appendFileSync(inventoryPath, JSON.stringify(normalized) + '\n');
}

export function buildCardInventoryIndex(boardDir: string): CardInventoryIndex {
  const byCardId = new Map<string, CardInventoryEntry>();
  const byCardPath = new Map<string, CardInventoryEntry>();

  for (const entry of readCardInventory(boardDir)) {
    const normalizedPath = path.resolve(entry.cardFilePath);
    const normalizedEntry: CardInventoryEntry = {
      ...entry,
      cardFilePath: normalizedPath,
    };

    const existingById = byCardId.get(entry.cardId);
    if (existingById && existingById.cardFilePath !== normalizedPath) {
      throw new Error(
        `Inventory invariant violation: card id "${entry.cardId}" maps to multiple files: ` +
        `"${existingById.cardFilePath}" and "${normalizedPath}"`
      );
    }

    const existingByPath = byCardPath.get(normalizedPath);
    if (existingByPath && existingByPath.cardId !== entry.cardId) {
      throw new Error(
        `Inventory invariant violation: file "${normalizedPath}" maps to multiple ids: ` +
        `"${existingByPath.cardId}" and "${entry.cardId}"`
      );
    }

    byCardId.set(entry.cardId, normalizedEntry);
    byCardPath.set(normalizedPath, normalizedEntry);
  }

  return { byCardId, byCardPath };
}

// ============================================================================
// Library
// ============================================================================

/**
 * Initialize a board directory.
 * - Dir doesn't exist → create it, write empty board-graph.json
 * - Dir exists + valid board-graph.json → no-op, return 'exists'
/**
 * Initialize a new board or verify existing board in the given directory.
 *
 * INIT PHASE:
 * 1. Create empty LiveGraph with EMPTY_CONFIG
 * 2. Snapshot it and commit to snapshot-store (board/graph + board/lastJournalProcessedId keys only)
 * 3. Configuration state (CardsStore, ControlStore) is NOT persisted here.
 *    Card definitions are loaded from card-source-kinds.json files at runtime.
 *    Config files (.task-executor, .inference-adapter) are loaded from disk on demand.
 *
 * Returns 'created' if new board was created, 'exists' if board already existed.
 * Throws if directory exists but is non-empty and has no valid board-graph.json.
 */
export function initBoard(dir: string): 'created' | 'exists' {
  const boardPath = path.join(dir, BOARD_FILE);

  if (fs.existsSync(boardPath)) {
    // Validate it's a real board envelope
    const envelope = loadBoardEnvelope(dir);
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
  const current = nodeStateSnapshotStore.readSnapshot(dir);
  const commitResult = nodeStateSnapshotStore.commitSnapshot(dir, {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION_V1,
    expectedVersion: current.version,
    commitId: randomUUID(),
    committedAt: new Date().toISOString(),
    deleteKeys: [],
    shallowMerge: boardEnvelopeToSnapshotEntries(envelope),
  });
  if (!commitResult.ok) {
    throw new Error(
      `State snapshot init commit failed: expected=${current.version ?? 'null'} current=${commitResult.currentVersion ?? 'null'}`,
    );
  }
  return 'created';
}

/**
 * Load the board envelope (graph + drained cursor) from persistent snapshot store.
 *
 * LOAD PHASE:
 * 1. Read snapshot from disk (5 mutable keys: board/graph, board/lastJournalProcessedId, etc.)
 * 2. Configuration state (CardsStore, ControlStore) is NOT loaded here.
 *    Cards are loaded separately when needed (during upsert-card commands).
 *    Config files are read on demand (.task-executor, .inference-adapter).
 * 3. Restore the graph to verify integrity (no corruption detected during load).
 *
 * Falls back to direct board-graph.json read for compatibility with boards created before snapshot-store wiring.
 */
export function loadBoardEnvelope(dir: string): BoardEnvelope {
  const boardPath = path.join(dir, BOARD_FILE);
  if (!fs.existsSync(boardPath)) {
    throw new Error(`Missing board file: ${boardPath}`);
  }

  const snapshot = nodeStateSnapshotStore.readSnapshot(dir);
  if (snapshot.values[BOARD_GRAPH_KEY]) {
    return snapshotEntriesToBoardEnvelope(snapshot.values);
  }

  // Compatibility fallback for envelopes written before snapshot-store wiring.
  const raw = fs.readFileSync(boardPath, 'utf-8');
  return JSON.parse(raw) as BoardEnvelope;
}

export function loadBoard(dir: string): LiveGraph {
  const envelope = loadBoardEnvelope(dir);
  return restore(envelope.graph);
}

/**
 * Save board state to persistent snapshot store after drain cycle.
 *
 * SAVE PHASE (Drain Cycle):
 * 1. Serialize current ReactiveGraph to snapshot
 * 2. Commit to snapshot-store with optimistic concurrency check (expectedVersion)
 * 3. Snapshot persists only 5 mutable runtime keys:
 *    - board/graph, board/lastJournalProcessedId (in board-graph.json)
 *    - cards/<id>/runtime, cards/<id>/fetched-sources-manifest, outputStore (in .state-snapshot/ sidecars)
 * 4. Configuration state (CardsStore, ControlStore) is NOT persisted here.
 *    Config changes from upsert-card are written directly to card-source-kinds.json.
 *    Control config is persisted separately in .task-executor, .inference-adapter files.
 * 5. Publish status cache as best-effort (cache failures do not fail the commit).
 *
 * Throws if version mismatch detected (concurrent modification from another host/process).
 */
export function saveBoard(dir: string, rg: ReactiveGraph, journal: BoardJournal): void {
  const snap = rg.snapshot();
  const envelope: BoardEnvelope = {
    lastDrainedJournalId: journal.lastDrainedJournalId,
    graph: snap,
  };
  const current = nodeStateSnapshotStore.readSnapshot(dir);
  const commitResult = nodeStateSnapshotStore.commitSnapshot(dir, {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION_V1,
    expectedVersion: current.version,
    commitId: randomUUID(),
    committedAt: new Date().toISOString(),
    deleteKeys: [],
    shallowMerge: boardEnvelopeToSnapshotEntries(envelope),
  });
  if (!commitResult.ok) {
    throw new Error(
      `State snapshot commit failed: expected=${current.version ?? 'null'} current=${commitResult.currentVersion ?? 'null'}`,
    );
  }

  // Publish status snapshot in the same persistence path as board writes.
  // This is a read-model cache; cache failures must not fail authoritative commits.
  try {
    const live = restore(snap);
    const statusObject = buildBoardStatusObject(path.resolve(dir), live);
    writeJsonAtomic(resolveStatusSnapshotPath(dir), statusObject);
  } catch (err) {
    console.warn(
      `[board-live-cards] status cache publish failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function runtimeOutConfigPath(boardDir: string): string {
  return path.join(boardDir, RUNTIME_OUT_FILE);
}

function resolveConfiguredRuntimeOutDir(boardDir: string): string {
  const cfgPath = runtimeOutConfigPath(boardDir);
  if (fs.existsSync(cfgPath)) {
    const configured = fs.readFileSync(cfgPath, 'utf-8').trim();
    if (configured) {
      return path.isAbsolute(configured) ? configured : path.resolve(boardDir, configured);
    }
  }

  const defaultDir = path.join(boardDir, DEFAULT_RUNTIME_OUT_DIR);
  fs.writeFileSync(cfgPath, defaultDir, 'utf-8');
  return defaultDir;
}

function configureRuntimeOutDir(boardDir: string, runtimeOut?: string): string {
  let resolved: string;
  if (runtimeOut) {
    resolved = path.isAbsolute(runtimeOut) ? runtimeOut : path.resolve(boardDir, runtimeOut);
  } else {
    resolved = path.join(boardDir, DEFAULT_RUNTIME_OUT_DIR);
  }

  fs.mkdirSync(resolved, { recursive: true });
  fs.writeFileSync(runtimeOutConfigPath(boardDir), resolved, 'utf-8');
  return resolved;
}

function resolveStatusSnapshotPath(boardDir: string): string {
  return path.join(resolveConfiguredRuntimeOutDir(boardDir), RUNTIME_STATUS_FILE);
}

function resolveComputedValuesPath(boardDir: string, cardId: string): string {
  return path.join(resolveConfiguredRuntimeOutDir(boardDir), RUNTIME_CARDS_DIR, `${cardId}.computed.json`);
}

function resolveDataObjectsDirPath(boardDir: string): string {
  return path.join(resolveConfiguredRuntimeOutDir(boardDir), RUNTIME_DATA_OBJECTS_DIR);
}

function toDataObjectFileName(token: string): string {
  // Keep token recognizable in filenames while avoiding path traversal.
  return token.replace(/[\\/]/g, '__');
}

function writeRuntimeDataObjects(boardDir: string, data: Record<string, unknown>): void {
  for (const [token, payload] of Object.entries(data)) {
    if (!token) continue;
    const fileName = toDataObjectFileName(token);
    if (!fileName) continue;
    const filePath = path.join(resolveDataObjectsDirPath(boardDir), fileName);
    writeJsonAtomic(filePath, payload);
  }
}

function writeJsonAtomic(filePath: string, payload: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
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
// (SourceTokenPayload interface is re-exported from board-live-cards-lib-types)
// ============================================================================

import type { SourceTokenPayload } from './board-live-cards-lib-types.js';

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
// Runtime state — now managed exclusively by RuntimeInternalStore (node-adapters)
// The SourceRuntimeEntry, InferenceRuntimeEntry, FetchRuntimeEntry types and
// domain functions are re-exported from board-live-cards-lib-types.
// ============================================================================

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

function determineLatestPendingAccumulated(boardDir: string): number {
  const boardPath = path.join(boardDir, BOARD_FILE);
  if (!fs.existsSync(boardPath)) return 0;
  try {
    const envelope = loadBoardEnvelope(boardDir);
    return getUndrainedEntries(boardDir, envelope.lastDrainedJournalId).length;
  } catch {
    return 0;
  }
}

// Thin wrappers delegating to process-runner — no duplicate logic here.
function spawnDetachedCommand(cmd: string, args: string[]): void {
  runDetached({ command: cmd, args });
}

function execCommandSync(
  cmd: string,
  args: string[],
  options?: { shell?: boolean; timeout?: number; encoding?: BufferEncoding; cwd?: string; env?: NodeJS.ProcessEnv },
): string {
  return runSync({ command: cmd, args, cwd: options?.cwd, timeoutMs: options?.timeout, env: options?.env as Record<string, string> | undefined });
}

function execCommandAsync(
  cmd: string,
  args: string[],
  callback: (err: Error | null, stdout: string, stderr: string) => void,
): void {
  runAsync({ command: cmd, args }, callback);
}

function resolveCommandInvocation(rawCmd: string, rawArgs: string[]): { cmd: string; args: string[] } {
  const spec = parseCommandSpec({ command: rawCmd, args: rawArgs });
  return { cmd: spec.command, args: spec.args ?? [] };
}

function spawnDetachedProcessAccumulatedWorker(boardDir: string): boolean {
  const { cmd, args: cliArgs } = getCliInvocation('process-accumulated-events', ['--rg', boardDir, '--inline-loop']);
  try {
    spawnDetachedCommand(cmd, cliArgs);
    return true;
  } catch {
    return false;
  }
}

async function processAccumulatedEventsInlineLoop(boardDir: string, settleDelayMs = 50): Promise<boolean> {
  while (determineLatestPendingAccumulated(boardDir) > 0) {
    const ran = await processAccumulatedEvents(boardDir);
    if (!ran) return false;
    await new Promise<void>(resolve => setTimeout(resolve, settleDelayMs));
  }
  return true;
}

function shouldAvoidDetachedProcessSpawn(): boolean {
  return process.env.BOARD_LIVE_CARDS_NO_SPAWN === '1';
}

/**
 * Run one lock-guarded processing pass for this board.
 *
 * GUARANTEE (single-pass only):
 * - At most one process performs this pass at a time (board lock).
 * - If lock is acquired, exactly one drain/apply/save cycle is executed.
 * - If lock is busy, returns false immediately (no waiting).
 *
 * This function does NOT guarantee full settlement; it only advances the baton
 * by one cycle in the relay model.
 */
export async function processAccumulatedEvents(boardDir: string): Promise<boolean> {
  const boardPath = path.join(boardDir, BOARD_FILE);
  const cliDir = path.resolve(__dirname, '..', '..');
  let release: (() => void) | undefined;
  try {
    release = lockSync(boardPath, { retries: 0 });
  } catch {
    // Lock held by another process — it will drain our entries
    return false;
  }
  try {
    const cardHandlerAdapters = {
      cardStore: createNodeCardStore(lookupCardPath),
      runtimeStore: createNodeRuntimeStore(),
      outputStore: createNodeOutputStore(resolveComputedValuesPath, resolveDataObjectsDirPath, INFERENCE_ADAPTER_LOG_FILE),
      inputStore: createNodeInputStore(JOURNAL_FILE),
      invocationAdapter: createNodeInvocationAdapter(cliDir, encodeSourceToken),
    };
    const envelope = loadBoardEnvelope(boardDir);
    const live = restore(envelope.graph);
    const journal = new BoardJournal(path.join(boardDir, JOURNAL_FILE), envelope.lastDrainedJournalId);
    const rg = createReactiveGraph(live, { handlers: { 'card-handler': createCardHandlerFn(boardDir, cardHandlerAdapters) } });
    // Explicitly drain the external journal and push events into the reactive graph.
    // The engine never reads from external storage — the caller owns that boundary.
    const undrained = journal.drain();
    rg.pushAll(undrained);
    await rg.dispose({ wait: true });
    saveBoard(boardDir, rg, journal);
    return true;
  } finally {
    release!();
  }
}

/**
 * Schedule continued draining until the board eventually settles.
 *
 * GUARANTEE (system-level eventual progress):
 * - Default behavior launches a detached background worker process that runs
 *   `process-accumulated-events --inline-loop`.
 * - Returns quickly to caller; does not synchronously wait for settlement.
 * - Under relay assumptions, pending entries eventually drain to zero:
 *   1) at least one runner continues, 2) no crash/forced exit in relay window,
 *   3) lock remains healthy, 4) new events do not arrive forever.
 *
 * INTERNAL MODE:
 * - `inlineLoop: true` executes the while(pending) loop in the current process.
 * - Used by the worker command to avoid recursive worker spawning.
 */
export async function processAccumulatedEventsInfinitePass(
  boardDir: string,
  settleDelayMs = 50,
  options?: { inlineLoop?: boolean },
): Promise<boolean> {
  if (options?.inlineLoop || shouldAvoidDetachedProcessSpawn()) {
    return processAccumulatedEventsInlineLoop(boardDir, settleDelayMs);
  }
  return spawnDetachedProcessAccumulatedWorker(boardDir);
}

/**
 * Forced drain entrypoint: first run one immediate pass, then delegate to
 * infinite-pass continuation.
 *
 * GUARANTEE:
 * - In default mode, this guarantees immediate forward progress (single pass)
 *   and guaranteed scheduling of eventual continuation (background worker).
 * - In `inlineLoop` mode, this runs full in-process settle loop and returns
 *   only after pending reaches zero (or lock contention aborts loop).
 */
export async function processAccumulatedEventsForced(
  boardDir: string,
  options?: { inlineLoop?: boolean },
): Promise<void> {
  await processAccumulatedEvents(boardDir);
  await processAccumulatedEventsInfinitePass(boardDir, 50, options);
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
 * run compute, invoke source_defs.
 */
export function liveCardToTaskConfig(card: BoardLiveCard): TaskConfig {
  const requires = card.requires;
  const provides = card.provides?.map(p => p.bindTo) ?? [];

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
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const LOCAL_TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/**
 * Generalized CLI invocation: determines how to invoke this script in current environment.
 * Returns { cmd, args } suitable for execFile() or execFileSync().
 */
function getCliInvocation(command: string, args: string[]): { cmd: string; args: string[] } {
  const jsPath = path.join(__dirname, 'board-live-cards-cli.js');
  if (fs.existsSync(jsPath)) {
    return { cmd: process.execPath, args: [jsPath, command, ...args] };
  }

  const tsPath = path.join(__dirname, 'board-live-cards-cli.ts');
  if (fs.existsSync(tsPath) && fs.existsSync(LOCAL_TSX_CLI)) {
    return { cmd: process.execPath, args: [LOCAL_TSX_CLI, tsPath, command, ...args] };
  }

  const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  return { cmd: npxCmd, args: ['tsx', tsPath, command, ...args] };
}



function appendTaskExecutorLog(
  boardDir: string,
  hydratedSource: unknown,
  mode: 'external-task-executor' | 'built-in-run-source-fetch',
): void {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      mode,
      hydratedSource,
    };
    fs.appendFileSync(path.join(boardDir, TASK_EXECUTOR_LOG_FILE), JSON.stringify(entry) + '\n', 'utf-8');
  } catch (logErr) {
    console.error(`[task-executor-log] append failed: ${logErr instanceof Error ? logErr.message : String(logErr)}`);
  }
}


// ============================================================================
// CLI
// ============================================================================

/**
 * Helper function to add a single card from file.
 * Throws errors instead of calling process.exit() so it can be used in tests.
 */
function resolveCardGlobMatches(cardGlob: string): string[] {
  const patterns = cardGlob
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(p => p.replace(/\\/g, '/'));
  const matches = fg.sync(patterns, {
    absolute: true,
    onlyFiles: true,
    unique: true,
    dot: false,
  });
  // fast-glob returns forward-slash paths; normalise to native so comparisons
  // against inventory entries (which use path.resolve → backslash on Windows) match.
  return [...matches].map(m => path.resolve(m)).sort((a, b) => a.localeCompare(b));
}


export async function cli(argv: string[]): Promise<void> {
  const boardCommandHandlers = createBoardCommandHandlers({
    initBoard,
    configureRuntimeOutDir,
    loadBoard,
    writeJsonAtomic,
    resolveStatusSnapshotPath,
    buildBoardStatusObject: (dir: string, live: LiveGraph) => buildBoardStatusObject(path.resolve(dir), live),
    readTaskExecutorConfig,
    resolveCardGlobMatches,
    validateLiveCardDefinition,
    execCommandSync,
    appendEventToJournal,
    processAccumulatedEventsInfinitePass,
  });
  const callbackCommandHandlers = createCallbackCommandHandlers({
    decodeCallbackToken,
    decodeSourceToken,
    writeRuntimeDataObjects,
    appendEventToJournal,
    processAccumulatedEventsForced,
    processAccumulatedEventsInfinitePass,
  });
  const nonCoreCommandHandlers = createNonCoreCommandHandlers({
    readTaskExecutorConfig,
    execCommandSync,
    splitCommandLine,
    resolveCommandInvocation,
  });
  const cardCommandHandlers = createCardCommandHandlers({
    resolveCardGlobMatches,
    buildCardInventoryIndex,
    appendCardInventory,
    liveCardToTaskConfig,
    appendEventToJournal,
    processAccumulatedEventsInfinitePass,
  });
  const executionCommandHandlers = createExecutionCommandHandlers({
    INFERENCE_ADAPTER_FILE,
    readTaskExecutorConfig,
    execCommandSync,
    execCommandAsync,
    splitCommandLine,
    resolveCommandInvocation,
    encodeSourceToken,
    decodeSourceToken,
    decodeCallbackToken,
    spawnDetachedCommand,
    getCliInvocation,
    appendTaskExecutorLog,
    appendEventToJournal,
    processAccumulatedEventsInfinitePass,
    processAccumulatedEventsForced,
    lookupCardPath,
    nextEntryAfterFetchDelivery,
  });

  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':            return nonCoreCommandHandlers.cmdHelp();
    case 'init':           return boardCommandHandlers.cmdInit(rest);
    case 'status':         return boardCommandHandlers.cmdStatus(rest);
    case 'upsert-card':    return cardCommandHandlers.cmdUpsertCard(rest);
    case 'validate-card':  return boardCommandHandlers.cmdValidateCard(rest);
    case 'remove-card':              return boardCommandHandlers.cmdRemoveCard(rest);
    case 'retrigger':                 return boardCommandHandlers.cmdRetrigger(rest);
    case 'task-completed':            return callbackCommandHandlers.cmdTaskCompleted(rest);
    case 'task-failed':               return callbackCommandHandlers.cmdTaskFailed(rest);
    case 'task-progress':             return callbackCommandHandlers.cmdTaskProgress(rest);
    case 'source-data-fetched':       return callbackCommandHandlers.cmdSourceDataFetched(rest);
    case 'source-data-fetch-failure': return callbackCommandHandlers.cmdSourceDataFetchFailure(rest);
    case 'run-sourcedefs-internal':      return executionCommandHandlers.cmdRunSources(rest);
    case 'run-inference-internal':    return executionCommandHandlers.cmdRunInference(rest);
    case 'inference-done':            return executionCommandHandlers.cmdInferenceDone(rest);
    case 'run-source-fetch':          return nonCoreCommandHandlers.cmdRunSourceFetch(rest);
    case 'probe-source':               return await nonCoreCommandHandlers.cmdProbeSource(rest);
    case 'describe-task-executor-capabilities': return nonCoreCommandHandlers.cmdDescribeTaskExecutorCapabilities(rest);
    case 'process-accumulated-events': return await executionCommandHandlers.cmdTryDrain(rest);
    default:
      throw new Error(`Unknown command: ${cmd ?? '(none)'}`);
  }
}

// Run when invoked directly
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
if (isMain) {
  cli(process.argv.slice(2)).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  });
}
