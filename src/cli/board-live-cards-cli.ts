/**
 * Board Live Cards — Disk persistence + CLI for ReactiveGraph.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  makeBoardTempFilePath,
  buildBoardCliInvocation,
  genUUID,
  resolveModuleDir,
} from './process-runner.js';
import { withRelayLock, serializeRef, parseRef } from './storage-interface.js';
import type { KindValueRef } from './storage-interface.js';
import { dispatchTaskExecutorDetached, buildLocalBaseSpec, builtInSourceCliExecutorRef } from './execution-adapter.js';
import { blobStorageForRef } from './public-storage-adapter.js';
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
import { createCardCommandHandlers } from './board-live-cards-cli-card-commands.js';
import { createCompatCommandHandlers } from './board-live-cards-cli-compat.js';
import type { CardUpsertIndexEntry } from './board-live-cards-all-stores.js';
import { createCardHandlerFn } from './board-live-cards-lib-card-handler.js';
import { buildBoardStatusObject } from './board-live-cards-lib-board-status.js';
import {
  computeStableJsonHash,
  createFsKvStorage,
  createFsBlobStorage,
  createFsAtomicRelayLock,
  createFsJournalStorageAdapter,
  createFsCardStorageAdapter,
  createFsStateSnapshotStorageAdapter,
} from './storage-fs-adapters.js';
import { createNodeInvocationAdapter, createNodeCommandExecutor } from './process-runner.js';
import {
  createCardStore, createJournalStore, createExecutionRequestStore,
  createStateSnapshotStore, createBoardConfigStore, createFetchedSourcesStore, createCardRuntimeStore,
  createPublishedOutputsStore,
  BOARD_GRAPH_KEY, BOARD_LAST_JOURNAL_PROCESSED_ID_KEY, SNAPSHOT_SCHEMA_VERSION_V1,
  type BoardConfigStore, type CardStore,
} from './board-live-cards-all-stores.js';
// Re-export domain types and functions for backward compatibility
import { Resp, type CommandResponse } from './board-live-cards-lib-types.js';
import type { InvocationAdapter, CommandExecutor } from './process-interface.js';
export type { SourceRuntimeEntry, FetchRuntimeEntry, SourceTokenPayload, CommandResponse } from './board-live-cards-lib-types.js';
export { isSourceInFlight, decideSourceAction, nextEntryAfterFetchDelivery, nextEntryAfterFetchFailure, Resp } from './board-live-cards-lib-types.js';

const BOARD_LOCK_FILE = '.board.lock';

const INVENTORY_FILE = 'cards-inventory.jsonl';
const RUNTIME_OUT_FILE = '.runtime-out';
const DEFAULT_RUNTIME_OUT_DIR = 'runtime-out';
function createBoardConfig(boardDir: string): BoardConfigStore {
  return createBoardConfigStore(createFsKvStorage(path.join(boardDir, '.config')));
}

function createBoardInvocationAdapter(cliDir: string): InvocationAdapter {
  const base = createNodeInvocationAdapter(cliDir);
  // Board CLI script path — used as the back-channel `via` for reportComplete() callbacks.
  const { cmd: _cliCmd, args: _cliArgs } = buildBoardCliInvocation(cliDir, '_', []);
  const boardCliScriptPath = (_cliCmd === process.execPath && _cliArgs[0]?.endsWith('.js'))
    ? _cliArgs[0]
    : (_cliArgs[1] ?? _cliArgs[0]);

  return {
    requestProcessAccumulated: base.requestProcessAccumulated.bind(base),
    async requestSourceFetch(
      boardDir: string,
      enrichedCard: Record<string, unknown>,
      callbackToken: string,
    ) {
      if (process.env.BOARD_LIVE_CARDS_NO_SPAWN === '1') return { dispatched: false, invocationId: undefined };
      try {
        const executorRef = createBoardConfig(boardDir).readTaskExecutorRef() ?? builtInSourceCliExecutorRef();

        const cardId = (enrichedCard.id as string | undefined) ?? 'unknown';
        type SourceDef = { bindTo: string; outputFile?: string; [k: string]: unknown };
        const sourceDefs = (enrichedCard.source_defs ?? []) as SourceDef[];
        let dispatched = false;
        for (const src of sourceDefs) {
          if (!src.outputFile) {
            console.warn(`[request-source-fetch] source "${src.bindTo}" has no outputFile — skipping`);
            continue;
          }
          const sourceToken = encodeSourceToken({
            cbk: callbackToken, rg: boardDir, br: serializeRef({ kind: 'fs-path', value: boardDir }), cid: cardId,
            b: src.bindTo, d: src.outputFile, cs: undefined,
          });
          const inFile  = makeBoardTempFilePath(boardDir, `source-in-${src.bindTo}`);
          const outFile = makeBoardTempFilePath(boardDir, `source-out-${src.bindTo}`);
          const errFile = makeBoardTempFilePath(boardDir, `source-err-${src.bindTo}`, '.txt');
          const inEnvelope = {
            source_def: src,
            base_ref: serializeRef({ kind: 'fs-path', value: boardDir }),
            callback: {
              token: sourceToken,
              via: { howToRun: 'local-node' as const, whatToRun: serializeRef({ kind: 'fs-path', value: boardCliScriptPath }) },
            },
          };
          const inRef  = serializeRef({ kind: 'fs-path', value: inFile });
          const outRef = serializeRef({ kind: 'fs-path', value: outFile });
          const errRef = serializeRef({ kind: 'fs-path', value: errFile });
          blobStorageForRef({ kind: 'fs-path', value: inFile }).write(inFile, JSON.stringify(inEnvelope, null, 2));
          console.log(`[request-source-fetch] ${executorRef.meta ?? executorRef.howToRun}: ${executorRef.whatToRun}`);
          dispatchTaskExecutorDetached(executorRef, { subcommand: 'run-source-fetch', inRef, outRef, errRef }, cliDir);
          dispatched = true;
        }
        return { dispatched, invocationId: dispatched ? genUUID() : undefined };
      } catch (err) {
        return { dispatched: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

const EMPTY_CONFIG: GraphConfig = { settings: { completion: 'manual', refreshStrategy: 'data-changed' }, tasks: {} } as GraphConfig;

/** Envelope stored in board-graph.json — wraps the LiveGraph snapshot with journal pointer. */
export interface BoardEnvelope {
  lastDrainedJournalId: string;
  graph: LiveGraphSnapshot;
}

const nodeStateSnapshotStore = createStateSnapshotStore(createFsStateSnapshotStorageAdapter());

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
    const entry: JournalEntry = { id: genUUID(), event };
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
  // Check new KV store first
  const kv = createFsKvStorage(path.join(boardDir, '.card-upsert-kv'));
  const kvEntry = kv.read(cardId) as CardUpsertIndexEntry | null;
  if (kvEntry?.blobRef) return kvEntry.blobRef;
  // Fall back to legacy inventory
  const entries = readCardInventory(boardDir);
  const entry = entries.find(e => e.cardId === cardId);
  return entry?.cardFilePath ?? null;
}

/** Read all entries from the card-upsert KV dedup cache. Keyed by cardId. */
export function readCardUpsertIndex(boardDir: string): Record<string, CardUpsertIndexEntry> {
  const kv = createFsKvStorage(path.join(boardDir, '.card-upsert-kv'));
  const result: Record<string, CardUpsertIndexEntry> = {};
  for (const cardId of kv.listKeys()) {
    const entry = kv.read(cardId) as CardUpsertIndexEntry | null;
    if (entry) result[cardId] = entry;
  }
  return result;
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
export function initBoard(baseRef: KindValueRef): 'created' | 'exists' {
  if (baseRef.kind !== 'fs-path') {
    throw new Error(`initBoard: unsupported board ref kind "${baseRef.kind}" — only fs-path is supported`);
  }
  const dir = baseRef.value;
  const lockPath = path.join(dir, BOARD_LOCK_FILE);

  if (fs.existsSync(lockPath)) {
    // Validate it's a real board envelope
    const envelope = loadBoardEnvelope(dir);
    restore(envelope.graph);
    return 'exists';
  }

  if (fs.existsSync(dir)) {
    const entries = fs.readdirSync(dir);
    if (entries.length > 0) {
      throw new Error(`Directory "${dir}" is not empty and has no valid board`);
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  // Create lock marker file (required by proper-lockfile).
  fs.writeFileSync(lockPath, '{}', 'utf-8');
  const live = createLiveGraph(EMPTY_CONFIG);
  const snap = snapshot(live);
  const envelope: BoardEnvelope = { lastDrainedJournalId: '', graph: snap };
  const current = nodeStateSnapshotStore.readSnapshot(dir);
  const commitResult = nodeStateSnapshotStore.commitSnapshot(dir, {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION_V1,
    expectedVersion: current.version,
    commitId: genUUID(),
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
  const snapshot = nodeStateSnapshotStore.readSnapshot(dir);
  if (!snapshot.values[BOARD_GRAPH_KEY]) {
    throw new Error(`Missing board state at: ${dir}`);
  }
  return snapshotEntriesToBoardEnvelope(snapshot.values);
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
export function saveBoard(dir: string, rg: ReactiveGraph, journalOrCursor: BoardJournal | string): void {
  const newCursor = typeof journalOrCursor === 'string' ? journalOrCursor : journalOrCursor.lastDrainedJournalId;
  const snap = rg.snapshot();
  const envelope: BoardEnvelope = {
    lastDrainedJournalId: newCursor,
    graph: snap,
  };
  const current = nodeStateSnapshotStore.readSnapshot(dir);
  const commitResult = nodeStateSnapshotStore.commitSnapshot(dir, {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION_V1,
    expectedVersion: current.version,
    commitId: genUUID(),
    committedAt: new Date().toISOString(),
    deleteKeys: [],
    shallowMerge: boardEnvelopeToSnapshotEntries(envelope),
  });
  if (!commitResult.ok) {
    throw new Error(
      `State snapshot commit failed: expected=${current.version ?? 'null'} current=${commitResult.currentVersion ?? 'null'}`,
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
  createJournalStore(createFsJournalStorageAdapter(boardDir)).appendEvent(event);
}

/**
 * Read journal entries after the given ID. Pure file read, no mutation.
 */
export function getUndrainedEntries(boardDir: string, lastDrainedId: string): JournalEntry[] {
  const journalPath = path.join(boardDir, 'board-journal.jsonl');
  if (!fs.existsSync(journalPath)) return [];
  const content = fs.readFileSync(journalPath, 'utf-8').trim();
  if (!content) return [];
  const entries: JournalEntry[] = content.split('\n').map(l => JSON.parse(l));
  if (!lastDrainedId) return entries;
  const idx = entries.findIndex(e => e.id === lastDrainedId);
  return idx === -1 ? entries : entries.slice(idx + 1);
}

function determineLatestPendingAccumulated(boardDir: string): number {
  if (!fs.existsSync(path.join(boardDir, BOARD_LOCK_FILE))) return 0;
  try {
    const envelope = loadBoardEnvelope(boardDir);
    const journalStore = createJournalStore(createFsJournalStorageAdapter(boardDir));
    return journalStore.pendingCount(envelope.lastDrainedJournalId);
  } catch {
    return 0;
  }
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
export async function processAccumulatedEvents(boardDir: string, continuation?: () => void): Promise<boolean> {
  const lockPath = path.join(boardDir, BOARD_LOCK_FILE);
  const cliDir = __dirname;
  const lock = createFsAtomicRelayLock(lockPath);
  return withRelayLock(lock, async () => {
    const journalStore = createJournalStore(createFsJournalStorageAdapter(boardDir));
    const taskCompletedFn = (taskName: string, data: Record<string, unknown>): void => {
      appendEventToJournal(boardDir, { type: 'task-completed', taskName, data, timestamp: new Date().toISOString() });
    };
    const taskFailedFn = (taskName: string, error: string): void => {
      appendEventToJournal(boardDir, { type: 'task-failed', taskName, error, timestamp: new Date().toISOString() });
    };
    const onDispatchFailed = (entry: import('./board-live-cards-all-stores.js').ExecutionRequestEntry, error: string): void => {
      const p = entry.payload as Record<string, unknown>;
      const taskName = (p?.enrichedCard as Record<string, unknown> | undefined)?.id as string | undefined
        ?? p?.cardId as string | undefined
        ?? 'unknown';
      taskFailedFn(taskName, error);
    };
    const executionRequestStore = createExecutionRequestStore(createFsKvStorage(path.join(boardDir, '.execution-requests')), onDispatchFailed);
    const cardHandlerAdapters = {
      cardStore: createCardStore(createFsCardStorageAdapter(boardDir)),
      cardRuntimeStore: createCardRuntimeStore(createFsKvStorage(path.join(boardDir, '.state-snapshot'))),
      fetchedSourcesStore: createFetchedSourcesStore(createFsBlobStorage(boardDir), resolveSourceDataRef),
      outputStore: createPublishedOutputsStore(createFsKvStorage(resolveConfiguredRuntimeOutDir(boardDir))),
      executionRequestStore,
    };
    const envelope = loadBoardEnvelope(boardDir);
    const live = restore(envelope.graph);
    const { events: undrained, newCursor } = journalStore.readEntriesAfterCursor(envelope.lastDrainedJournalId);
    const invocationAdapter = createBoardInvocationAdapter(cliDir);
    const rg = createReactiveGraph(live, { handlers: { 'card-handler': createCardHandlerFn(boardDir, newCursor, cardHandlerAdapters, taskCompletedFn, taskFailedFn) } });
    rg.pushAll(undrained);
    await rg.dispose({ wait: true });
    saveBoard(boardDir, rg, newCursor);
    try {
      cardHandlerAdapters.outputStore.writeStatusSnapshot(buildBoardStatusObject(path.resolve(boardDir), restore(rg.snapshot())));
    } catch (err) {
      console.warn(`[board-live-cards] status cache publish failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    executionRequestStore.dispatchEntriesForJournalId(newCursor, (entry) => {
      if (entry.taskKind === 'source-fetch') {
        const p = entry.payload as { boardDir: string; enrichedCard: Record<string, unknown>; callbackToken: string };
        invocationAdapter.requestSourceFetch(p.boardDir, p.enrichedCard, p.callbackToken)
          .catch((err: unknown) => taskFailedFn(
            (p.enrichedCard?.id as string | undefined) ?? 'unknown',
            err instanceof Error ? err.message : String(err),
          ));
      } else {
        console.warn(`[process-accumulated-events] unknown taskKind "${entry.taskKind}" — skipping`);
      }
    });
  }, continuation);
}

/**
 * If there are pending events, run one drain pass then dispatch a new process
 * via the adapter to continue — allowing the current process to exit immediately after.
 * If nothing is pending, returns without doing anything.
 */
export async function processAccumulatedEventsInfinitePass(boardDir: string, adapter: InvocationAdapter): Promise<boolean> {
  if (determineLatestPendingAccumulated(boardDir) === 0) return true;
  return processAccumulatedEvents(boardDir, () => { void adapter.requestProcessAccumulated(boardDir); });
}

/**
 * Run one immediate drain pass then schedule infinite-pass continuation.
 */
export async function processAccumulatedEventsForced(boardDir: string, adapter: InvocationAdapter): Promise<void> {
  await processAccumulatedEvents(boardDir);
  await processAccumulatedEventsInfinitePass(boardDir, adapter);
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

const __dirname = resolveModuleDir(import.meta.url);

/**
 * Generalized CLI invocation: determines how to invoke this script in current environment.
 * Returns { cmd, args } suitable for execFile() or execFileSync().
 */
// ============================================================================
// CLI
// ============================================================================

/**
 * Resolve a KindValueRef to its content string.
 * Delegates to blobStorageForRef so all storage kinds are supported uniformly.
 */
function resolveSourceDataRef(ref: { kind: string; value: string }): string {
  const storage = blobStorageForRef(ref);
  const content = storage.read(ref.value);
  if (content === null) throw new Error(`resolveSourceDataRef: not found: ::${ref.kind}::${ref.value}`);
  return content;
}

// ============================================================================
// Non-core command handlers (inlined from board-live-cards-cli-noncore.ts)
// ============================================================================

interface ValidateResultLike {
  errors: string[];
}

interface NonCoreCommandDeps {
  getConfigStore: (boardDir: string) => BoardConfigStore;
  getCardStore: (boardDir: string) => CardStore;
  executor: CommandExecutor;
  makeTempFilePath: (boardDir: string, label: string, ext?: string) => string;
  validateLiveCardDefinition: (card: Record<string, unknown>) => ValidateResultLike;
  readStdin: () => string;
  cliDir: string;
}

interface NonCoreCommandHandlers {
  cmdHelp: () => void;
  cmdProbeSource: (args: string[]) => Promise<void>;
  cmdDescribeTaskExecutorCapabilities: (args: string[]) => void;
  cmdValidateCard: (args: string[]) => void;
  /** Direct validate — used by compat layer to avoid stdin coupling. */
  validateCards: (cards: Record<string, unknown>[], boardDir: string | undefined) => CommandResponse<{ cardId: string; errors: string[] }>[];
}

function createNonCoreCommandHandlers(deps: NonCoreCommandDeps): NonCoreCommandHandlers {
  async function cmdProbeSource(args: string[]): Promise<void> {
    const cardIdx = args.indexOf('--card');
    const sourceIdxArg = args.indexOf('--source-idx');
    const sourceBindArg = args.indexOf('--source-bind');
    const mockProjectionsIdx = args.indexOf('--mock-projections');
    const brIdx = args.indexOf('--base-ref');
    const outIdx = args.indexOf('--out');

    const cardFilePath = cardIdx !== -1 ? args[cardIdx + 1] : undefined;
    const sourceIdxVal = sourceIdxArg !== -1 ? parseInt(args[sourceIdxArg + 1], 10) : 0;
    const sourceBindVal = sourceBindArg !== -1 ? args[sourceBindArg + 1] : undefined;
    const mockProjectionsRaw = mockProjectionsIdx !== -1 ? args[mockProjectionsIdx + 1] : undefined;
    const boardDirArg = brIdx !== -1 ? parseRef(args[brIdx + 1]).value : undefined;
    const outFile = outIdx !== -1 ? args[outIdx + 1] : undefined;

    if (!cardFilePath) {
      console.error('Usage: board-live-cards probe-source --card <card.json> [--source-idx <n>] [--source-bind <name>] [--mock-projections <json>] [--base-ref <::kind::value>] [--out <result.json>]');
      process.exit(1);
    }

    // Read card
    let card: any;
    try {
      card = JSON.parse(fs.readFileSync(path.resolve(cardFilePath), 'utf-8'));
    } catch (e) {
      console.error(`[probe-source] Cannot read card: ${(e as Error).message}`);
      process.exit(1);
    }

    const source_defs: any[] = card.source_defs ?? [];
    if (source_defs.length === 0) {
      console.error(`[probe-source] Card "${card.id}" has no source_defs`);
      process.exit(1);
    }

    // Select source by index or bindTo name
    let sourceIdx: number;
    if (sourceBindVal) {
      sourceIdx = source_defs.findIndex((s: any) => s.bindTo === sourceBindVal);
      if (sourceIdx === -1) {
        console.error(`[probe-source] No source with bindTo="${sourceBindVal}" in card "${card.id}"`);
        process.exit(1);
      }
    } else {
      sourceIdx = sourceIdxVal;
      if (isNaN(sourceIdx) || sourceIdx < 0 || sourceIdx >= source_defs.length) {
        console.error(`[probe-source] --source-idx ${sourceIdxVal} out of range (card has ${source_defs.length} source(s))`);
        process.exit(1);
      }
    }

    const sourceDef = source_defs[sourceIdx];
    const cardDir = path.resolve(path.dirname(cardFilePath));
    const boardDir = boardDirArg ?? cardDir;

    // Parse --mock-projections (JSON string or @file.json) — pre-resolved _projections values for testing
    let mockProjections: Record<string, unknown> = {};
    if (mockProjectionsRaw) {
      const raw = mockProjectionsRaw.startsWith('@')
        ? fs.readFileSync(path.resolve(mockProjectionsRaw.slice(1)), 'utf-8')
        : mockProjectionsRaw;
      try {
        mockProjections = JSON.parse(raw);
      } catch (e) {
        console.error(`[probe-source] --mock-projections is not valid JSON: ${(e as Error).message}`);
        process.exit(1);
      }
    }

    // Detect registered task-executor
    const teRef = deps.getConfigStore(boardDir).readTaskExecutorRef();
    const teSpec = teRef ? buildLocalBaseSpec(teRef, deps.cliDir) : undefined;
    const taskExecutorCmd = teSpec?.command;
    const taskExecutorBaseArgs = teSpec?.baseArgs ?? [];
    const taskExecutorExtraB64 = teRef?.extra
      ? Buffer.from(JSON.stringify(teRef.extra)).toString('base64')
      : undefined;

    // Build --in payload — mirrors exactly what run-sourcedefs-internal passes to the executor
    const inPayload: Record<string, unknown> = {
      ...sourceDef,
      cwd: typeof sourceDef.cwd === 'string' && sourceDef.cwd ? sourceDef.cwd : cardDir,
      boardDir: typeof sourceDef.boardDir === 'string' && sourceDef.boardDir ? sourceDef.boardDir : boardDir,
      _projections: mockProjections,
    };

    // Derive sourceKind from executor's describe-capabilities rather than hardcoding.
    // Call describe-capabilities, get sourceKinds keys, find which one appears in sourceDef.
    // Falls back to 'unknown' if executor is unavailable or call fails.
    let sourceKind = 'unknown';
    if (taskExecutorCmd) {
      try {
        const capRaw = deps.executor.executeSync(taskExecutorCmd, [...taskExecutorBaseArgs, 'describe-capabilities'], {
          timeout: 8_000, encoding: 'utf-8',
        });
        const caps = JSON.parse(String(capRaw));
        const knownKinds: string[] = caps?.sourceKinds ? Object.keys(caps.sourceKinds) : [];
        const defKeys = new Set(Object.keys(sourceDef));
        sourceKind = knownKinds.find(k => defKeys.has(k)) ?? 'unknown';
      } catch {
        // describe-capabilities failed — fall back to 'unknown'; probe execution still proceeds
      }
    }

    console.log(`[probe-source] card:        ${card.id}`);
    console.log(`[probe-source] source[${sourceIdx}]:  bindTo="${sourceDef.bindTo}" kind=${sourceKind}`);
    console.log(`[probe-source] _projections:       ${JSON.stringify(mockProjections)}`);
    console.log(`[probe-source] executor:    ${taskExecutorCmd ?? 'built-in (source.cli only)'}`);
    console.log('[probe-source] running fetch...');

    const inFile = deps.makeTempFilePath(boardDir, `probe-in-${sourceDef.bindTo}`);
    const tmpOut = deps.makeTempFilePath(boardDir, `probe-out-${sourceDef.bindTo}`);
    const errFile = deps.makeTempFilePath(boardDir, `probe-err-${sourceDef.bindTo}`, '.txt');

    fs.writeFileSync(inFile, JSON.stringify(inPayload, null, 2), 'utf-8');

    const inRef  = serializeRef({ kind: 'fs-path', value: inFile });
    const outRef = serializeRef({ kind: 'fs-path', value: tmpOut });
    const errRef = serializeRef({ kind: 'fs-path', value: errFile });

    let passed = false;
    let errorMsg: string | undefined;
    let resultRaw: string | undefined;

    try {
      if (taskExecutorCmd) {
        const executorArgs = [...taskExecutorBaseArgs, 'run-source-fetch',
          '--in-ref', inRef, '--out-ref', outRef, '--err-ref', errRef,
        ];
        if (taskExecutorExtraB64) executorArgs.push('--extra', taskExecutorExtraB64);
        deps.executor.executeSync(taskExecutorCmd, executorArgs, {
          timeout: (sourceDef.timeout as number) ?? 30_000,
        });
      } else {
        // Built-in path: only source.cli is supported
        if (!inPayload.cli) {
          throw new Error('No task-executor registered and source has no cli field — cannot probe with built-in executor');
        }
        const cmdParts = deps.executor.splitCommand(inPayload.cli as string);
        const rawCmd = cmdParts[0];
        const { cmd, args: cliArgs } = deps.executor.resolveInvocation(rawCmd, cmdParts.slice(1));
        const stdout = deps.executor.executeSync(cmd, cliArgs, {
          shell: false,
          encoding: 'utf-8',
          timeout: (sourceDef.timeout as number) ?? 30_000,
          cwd: inPayload.cwd as string,
        });
        fs.writeFileSync(tmpOut, String(stdout).trim(), 'utf-8');
      }

      passed = fs.existsSync(tmpOut);
      if (passed) {
        resultRaw = fs.readFileSync(tmpOut, 'utf-8');
      } else {
        errorMsg = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf-8').trim() : 'executor produced no output file';
      }
    } catch (e) {
      errorMsg = (e as Error).message ?? String(e);
      if (!errorMsg && fs.existsSync(errFile)) {
        errorMsg = fs.readFileSync(errFile, 'utf-8').trim();
      }
    }

    // Cleanup temp inputs
    for (const f of [inFile, errFile]) {
      try { fs.unlinkSync(f); } catch { /* best-effort */ }
    }

    // Report
    if (passed && resultRaw !== undefined) {
      const resultSize = resultRaw.length;
      const sample = resultRaw.slice(0, 300);
      console.log('[probe-source] STATUS:      PROBE_PASS');
      console.log(`[probe-source] result size: ${resultSize} bytes`);
      console.log(`[probe-source] sample:      ${sample}${resultSize > 300 ? '...' : ''}`);
      if (outFile) {
        fs.writeFileSync(path.resolve(outFile), resultRaw);
        console.log(`[probe-source] result written to: ${outFile}`);
      } else {
        try { fs.unlinkSync(tmpOut); } catch { /* best-effort */ }
      }
    } else {
      console.log('[probe-source] STATUS:      PROBE_FAIL');
      if (errorMsg) console.log(`[probe-source] error:       ${errorMsg}`);
      try { if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut); } catch { /* best-effort */ }
    }

    // Machine-readable summary line — agents parse this
    const summary = {
      status: passed ? 'PROBE_PASS' : 'PROBE_FAIL',
      cardId: card.id as string,
      sourceIdx,
      bindTo: sourceDef.bindTo as string,
      sourceKind,
      mockProjectionsKeys: Object.keys(mockProjections),
      resultSizeBytes: resultRaw !== undefined ? resultRaw.length : 0,
      error: errorMsg ?? undefined,
    };
    console.log(`[probe-source:result] ${JSON.stringify(summary)}`);

    process.exit(passed ? 0 : 1);
  }

  function cmdDescribeTaskExecutorCapabilities(args: string[]): void {
    const brIdx = args.indexOf('--base-ref');
    const boardDir = brIdx !== -1 ? parseRef(args[brIdx + 1]).value : undefined;
    if (!boardDir) {
      console.error('Usage: board-live-cards describe-task-executor-capabilities --base-ref <::kind::value>');
      process.exit(1);
    }

    const teRef = deps.getConfigStore(boardDir).readTaskExecutorRef();
    if (!teRef) {
      console.error(`[describe-task-executor-capabilities] No .task-executor registered in ${boardDir}`);
      process.exit(1);
    }

    try {
      const { command, baseArgs } = buildLocalBaseSpec(teRef, deps.cliDir);
      const stdout = deps.executor.executeSync(command, [...baseArgs, 'describe-capabilities'], {
        timeout: 10_000,
        encoding: 'utf-8',
      });
      // Pass through the executor's JSON output directly
      process.stdout.write(String(stdout));
      if (!String(stdout).endsWith('\n')) process.stdout.write('\n');
    } catch (e) {
      console.error(`[describe-task-executor-capabilities] Executor failed: ${(e as Error).message ?? e}`);
      process.exit(1);
    }
  }

  function cmdHelp(): void {
    console.log(`
board-live-cards-cli — LiveCards board CLI

USAGE
  board-live-cards-cli <command> [options]

BOARD MANAGEMENT
  init --base-ref <::kind::value> [--task-executor <script>] [--chat-handler <script>] [--runtime-out <dir>]
    Create a new board at the location identified by <::kind::value>.
    If --task-executor is given, registers the script as the board's task executor.
    If --chat-handler is given, registers the script as the board's chat handler.
    Writes runtime-out config (default: <board-dir>/runtime-out).
    Published runtime files:
      <runtime-out>/board-livegraph-status.json
      <runtime-out>/cards/<card-id>.computed.json
    Re-running init on an existing board is safe; handler registrations are updated.

  status --base-ref <::kind::value> [--json]
    Read and print the published status snapshot from <runtime-out>/board-livegraph-status.json.
    --json emits the stable machine-readable status object.

CARD MANAGEMENT
  upsert-card --base-ref <::kind::value> (--card <card.json> | --card-glob <glob>) [--card-id <card-id>] [--restart]
    Insert or update one or many cards.
    Enforces strict one-to-one mapping between card id and file path:
      - same id + same file path: update
      - new id + new file path: insert
      - id remap or file remap: rejected
    If --card-id is provided, it must match the id inside the file.
    --card-id is valid only with --card (single file), not with --card-glob.
    --restart clears the task so it re-triggers from scratch.

  validate-card (--card <card.json> | --card-glob <glob>) [--base-ref <::kind::value>]
    Validate one or many card JSON files without adding them to a board.
    Checks JSON Schema structure, runtime expression syntax, and provides.ref namespaces.
    When --base-ref is provided, also invokes the board's task executor validate-source-def
    subcommand to structurally validate each source definition against supported kinds.
    Exits with code 1 if any card fails validation.

  remove-card --base-ref <::kind::value> --id <card-id>
    Remove a card and its task from the board.

  retrigger --base-ref <::kind::value> --task <task-name>
    Mark a task not-started and drain to re-trigger it.

TASK CALLBACKS  (called by task executor scripts)
  task-completed --token <callbackToken> [--data <json>]
    Signal successful task completion with optional JSON result data.

  task-failed --token <callbackToken> [--error <message>]
    Signal task failure with an optional error message.

  task-progress --base-ref <::kind::value> --token <callbackToken> [--update <json>]
    Signal task progress with optional update payload (for waiting on more evidence, etc.).

SOURCE CALLBACKS  (called internally by run-sourcedefs-internal)
  source-data-fetched --tmp <file> --token <sourceToken>
    Atomically rename <file> into the outputFile destination and record delivery
    via journal events. Appends a task-progress event to re-invoke the card handler.

  source-data-fetch-failure --token <sourceToken> [--reason <message>]
    Record a source fetch failure via journal events and append a task-progress event.

INTERNAL COMMANDS
  process-accumulated-events --base-ref <::kind::value>
    Executes forced drain for this board.
    This command is also used as the background relay worker.
    By default it schedules a detached worker and returns quickly.
    Internal workers run with --inline-loop to perform the settle loop.

    Eventual-progress guarantee is relay-based (not per-call blocking guarantee):
    1) at least one runner continues processing,
    2) no crash/forced exit in relay window,
    3) lock stays healthy,
    4) event production eventually quiesces.

  run-sourcedefs-internal --card <card.json> --token <callbackToken> --base-ref <::kind::value>
    Execute all source[] entries for a card, then report delivery or failure.
    (Internal command — invoked by the card-handler. Not intended for direct use.)

    If <dir>/.task-executor exists, invokes it with run-source-fetch subcommand:
      <executor> run-source-fetch --in <source_json> --out <outfile> --err <errfile>

    If no .task-executor is registered, uses board-live-cards built-in run-source-fetch.

  run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]
    Execute a source definition. Board-live-cards reads source.cli and executes it.
    Writes result to --out. Presence of --out after exit indicates success.

  describe-task-executor-capabilities --base-ref <::kind::value>
    Invoke the registered task-executor's describe-capabilities subcommand and
    print its capabilities JSON to stdout.  Requires a .task-executor file in <::kind::value>.

  probe-source --card <card.json> [--source-idx <n>] [--source-bind <name>]
               [--mock-projections <json>] [--base-ref <::kind::value>] [--out <result.json>]
    Validate that a card source can be fetched successfully.
    Reads the card file, extracts the chosen source (default: index 0), builds the
    run-source-fetch --in payload with the supplied _projections data, invokes the
    registered task-executor (or built-in executor for source.cli), and reports pass/fail.
    --mock-projections:     JSON string (or @file.json) providing pre-resolved _projections values
                     the source needs.  Craft the minimal payload that exercises the
                     source — e.g. '{"holdings":[{"ticker":"AAPL","quantity":10}]}'.
                     If omitted, _projections is passed as empty ({}).
    --source-idx:    0-based index into card.source_defs[]. Default: 0.
    --source-bind:   Select source by its bindTo name instead of index.
    --base-ref:      Board directory used to find .task-executor. Defaults to the
                     directory containing the card file.
    --out:           Optional path to write the raw fetch result JSON.
    Prints a structured report ending with a [probe-source:result] JSON line.
    Exits 0 on PROBE_PASS, 1 on PROBE_FAIL.

RUN-SOURCE-FETCH PROTOCOL
  External task-executors implement:
    <executor> run-source-fetch --in <source.json> --out <result.json> [--err <error.txt>]

  INPUT:   --in file contains the full source_defs[x] definition object
  OUTPUT:  --out file is written with the result to signal success.
           --err file may be written to explain failure.

  Exit code and --out presence determine success:
    Exit 0 + --out file present → source delivery recorded, card re-evaluated.
    Exit non-zero OR --out absent → source-data-fetch-failure recorded.

BOARD-LIVE-CARDS BUILT-IN EXECUTOR
  Understands source.cli field only:
    "source_defs": [{ "cli": "node ../fetch-prices.js", "bindTo": "prices", "outputFile": "prices.json" }]

  The source.cli command is executed with:
    - Direct command invocation (no shell; quote-aware argument parsing)
    - Stdout is captured and delivered to the card as-is
    - Timeout from source.timeout (default 120s)

  The source.cli command must:
    - Execute successfully (exit 0)
    - Write output to stdout
    - Complete within the timeout

  The output format is the concern of the card's compute function to interpret.

  External task-executors can interpret source definitions however they want.

EXAMPLES
  board-live-cards-cli init ./my-board
  board-live-cards-cli init ./my-board --task-executor ./executors/my-runner.py
  board-live-cards-cli upsert-card --base-ref ::fs-path::./my-board --card cards/prices.json
  board-live-cards-cli status --base-ref ::fs-path::./my-board
  board-live-cards-cli retrigger --base-ref ::fs-path::./my-board --task price-fetch
  board-live-cards-cli probe-source --card cards/card-market-prices.json --source-idx 0 --base-ref ::fs-path::./my-board --mock-projections '{"holdings":[{"ticker":"AAPL","quantity":10}]}'
`.trimStart());
  }

  function validateCardObjects(
    cards: Record<string, unknown>[],
    boardDir: string | undefined,
  ): CommandResponse<{ cardId: string; errors: string[] }>[] {
    const teRef = boardDir ? deps.getConfigStore(boardDir).readTaskExecutorRef() : undefined;
    const teSpec = teRef ? buildLocalBaseSpec(teRef, deps.cliDir) : undefined;

    return cards.map((card) => {
      const cardId = typeof card.id === 'string' ? card.id : '(unknown)';
      const schemaErrors = deps.validateLiveCardDefinition(card).errors;
      const sourceErrors: string[] = [];

      if (teSpec && Array.isArray(card.source_defs)) {
        for (const src of card.source_defs as Array<Record<string, unknown>>) {
          const bindTo = typeof src.bindTo === 'string' ? src.bindTo : '(unknown)';
          const tmpFile = deps.makeTempFilePath(boardDir!, `validate-src-${bindTo}`);
          try {
            fs.writeFileSync(tmpFile, JSON.stringify(src), 'utf-8');
            let stdout: string;
            try {
              stdout = deps.executor.executeSync(
                teSpec.command,
                [...teSpec.baseArgs, 'validate-source-def', '--in', tmpFile],
                { timeout: 10_000 },
              );
            } catch (execErr: any) {
              stdout = typeof execErr?.stdout === 'string' ? execErr.stdout
                : Buffer.isBuffer(execErr?.stdout) ? execErr.stdout.toString('utf-8')
                : '';
              if (!stdout.trim()) {
                sourceErrors.push(`source "${bindTo}": executor validate-source-def failed — ${execErr instanceof Error ? execErr.message : String(execErr)}`);
                continue;
              }
            }
            const parsed = JSON.parse(stdout.trim());
            if (!parsed.ok && Array.isArray(parsed.errors)) {
              for (const error of parsed.errors) {
                sourceErrors.push(`source "${bindTo}": ${error}`);
              }
            }
          } catch (err) {
            sourceErrors.push(`source "${bindTo}": executor validate-source-def failed — ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
          }
        }
      }

      const allErrors = [...schemaErrors, ...sourceErrors];
      if (allErrors.length === 0) {
        return Resp.success({ cardId, errors: [] as string[] });
      }
      return Resp.error(allErrors.join('; '), { cardId, errors: allErrors }) as CommandResponse<{ cardId: string; errors: string[] }>;
    });
  }

  function cmdValidateCard(args: string[]): void {
    const brIdx = args.indexOf('--base-ref');
    const cardIdIdx = args.indexOf('--card-id');
    const stdioMode = args.includes('--cards-stdio');
    const boardDir = brIdx !== -1 ? parseRef(args[brIdx + 1]).value : undefined;

    if (stdioMode) {
      // --cards-stdio: read JSON array of card objects from stdin, write results to stdout
      let cards: Record<string, unknown>[];
      try {
        const raw = deps.readStdin();
        cards = JSON.parse(raw) as Record<string, unknown>[];
        if (!Array.isArray(cards)) throw new Error('stdin must be a JSON array');
      } catch (err) {
        const resp = Resp.error(`Failed to parse stdin: ${err instanceof Error ? err.message : String(err)}`);
        console.log(JSON.stringify([resp]));
        return;
      }
      const results = validateCardObjects(cards, boardDir);
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    if (cardIdIdx !== -1) {
      // --card-id: read from CardStore
      const cardId = args[cardIdIdx + 1];
      if (!cardId || !boardDir) {
        throw new Error('Usage: board-live-cards validate-card --base-ref <::kind::value> --card-id <id>');
      }
      const card = deps.getCardStore(boardDir).readCard(cardId);
      if (!card) {
        throw new Error(`Card "${cardId}" not found in board at ${boardDir}`);
      }
      const [result] = validateCardObjects([card as Record<string, unknown>], boardDir);
      if (result.status === 'error') {
        for (const err of result.data.errors) console.error(`  ${err}`);
        throw new Error(`Card "${cardId}" failed validation.`);
      }
      console.log(`OK    ${cardId}`);
      return;
    }

    throw new Error('Usage: board-live-cards validate-card (--card-id <id> --base-ref <::kind::value>) | (--cards-stdio [--base-ref <::kind::value>])');
  }

  return {
    cmdHelp,
    cmdProbeSource,
    cmdDescribeTaskExecutorCapabilities,
    cmdValidateCard,
    validateCards: validateCardObjects,
  };
}

// ============================================================================
// Execution command handlers (inlined from board-live-cards-cli-execution-commands.ts)
// ============================================================================

interface ExecutionCommandDeps {
  processAccumulatedEventsForced: (boardDir: string) => Promise<void>;
}

interface ExecutionCommandHandlers {
  cmdTryDrain: (args: string[]) => Promise<void>;
}

function createExecutionCommandHandlers(deps: ExecutionCommandDeps): ExecutionCommandHandlers {
  async function cmdTryDrain(args: string[]): Promise<void> {
    const brIdx = args.indexOf('--base-ref');
    const boardDir = brIdx !== -1 ? parseRef(args[brIdx + 1]).value : undefined;
    if (!boardDir) {
      console.error('Usage: board-live-cards process-accumulated-events --base-ref <::kind::value>');
      process.exit(1);
    }
    await deps.processAccumulatedEventsForced(boardDir);
  }

  return { cmdTryDrain };
}

export async function cli(argv: string[]): Promise<void> {
  const processAccumulatedAdapter = createBoardInvocationAdapter(__dirname);
  const executor = createNodeCommandExecutor();
  const scheduleInfinitePass = (boardDir: string) => processAccumulatedEventsInfinitePass(boardDir, processAccumulatedAdapter);
  const scheduleForced = (boardDir: string) => processAccumulatedEventsForced(boardDir, processAccumulatedAdapter);
  const boardCommandHandlers = createBoardCommandHandlers({
    initBoard,
    configureRuntimeOutDir,
    loadBoard,
    getOutputStore: (dir: string) => createPublishedOutputsStore(createFsKvStorage(resolveConfiguredRuntimeOutDir(dir))),
    buildBoardStatusObject: (dir: string, live: LiveGraph) => buildBoardStatusObject(path.resolve(dir), live),
    getConfigStore: createBoardConfig,
    appendEventToJournal,
    processAccumulatedEventsInfinitePass: scheduleInfinitePass,
  });
  const callbackCommandHandlers = createCallbackCommandHandlers({
    decodeCallbackToken,
    decodeSourceToken,
    getFetchedSourcesStore: (boardDir: string) => createFetchedSourcesStore(createFsBlobStorage(boardDir), resolveSourceDataRef),
    generateId: genUUID,
    writeRuntimeDataObjects: (boardDir: string, data: Record<string, unknown>) => createPublishedOutputsStore(createFsKvStorage(resolveConfiguredRuntimeOutDir(boardDir))).writeDataObjects(data),
    appendEventToJournal,
    processAccumulatedEventsForced: scheduleForced,
    processAccumulatedEventsInfinitePass: scheduleInfinitePass,
  });
  const nonCoreCommandHandlers = createNonCoreCommandHandlers({
    getConfigStore: createBoardConfig,
    getCardStore: (boardDir: string) => createCardStore(createFsCardStorageAdapter(boardDir)),
    executor,
    makeTempFilePath: makeBoardTempFilePath,
    validateLiveCardDefinition,
    readStdin: () => fs.readFileSync('/dev/stdin', 'utf-8'),
    cliDir: __dirname,
  });
  const cardCommandHandlers = createCardCommandHandlers({
    getCardStore: (boardDir: string) => createCardStore(createFsCardStorageAdapter(boardDir)),
    readCardUpsertEntry: (boardDir: string, cardId: string): CardUpsertIndexEntry | null => {
      const kv = createFsKvStorage(path.join(boardDir, '.card-upsert-kv'));
      return kv.read(cardId) as CardUpsertIndexEntry | null;
    },
    writeCardUpsertEntry: (boardDir: string, cardId: string, entry: CardUpsertIndexEntry): void => {
      const kv = createFsKvStorage(path.join(boardDir, '.card-upsert-kv'));
      kv.write(cardId, entry);
    },
    liveCardToTaskConfig,
    hashTaskConfig: computeStableJsonHash,
    appendEventToJournal,
    processAccumulatedEventsInfinitePass: scheduleInfinitePass,
  });
  const compatCommandHandlers = createCompatCommandHandlers({
    getCardAdminStore: (boardDir: string) => createCardStore(createFsCardStorageAdapter(boardDir)),
    upsertCardById: cardCommandHandlers.upsertCardById,
    validateCards: nonCoreCommandHandlers.validateCards,
    processAccumulatedEventsInfinitePass: scheduleInfinitePass,
    cmdSourceDataFetched: (args: string[]) => callbackCommandHandlers.cmdSourceDataFetched(args),
  });

  const executionCommandHandlers = createExecutionCommandHandlers({
    processAccumulatedEventsForced: scheduleForced,
  });

  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':            return nonCoreCommandHandlers.cmdHelp();
    case 'init':           return boardCommandHandlers.cmdInit(rest);
    case 'status':         return boardCommandHandlers.cmdStatus(rest);
    case 'upsert-card':    return rest.some((a: string) => a === '--card' || a === '--card-glob')
      ? compatCommandHandlers.compatUpsertCard(rest)
      : cardCommandHandlers.cmdUpsertCard(rest);
    case 'validate-card':  return rest.some((a: string) => a === '--card' || a === '--card-glob')
      ? compatCommandHandlers.compatValidateCard(rest)
      : nonCoreCommandHandlers.cmdValidateCard(rest);
    case 'remove-card':              return boardCommandHandlers.cmdRemoveCard(rest);
    case 'retrigger':                 return boardCommandHandlers.cmdRetrigger(rest);
    case 'task-completed':            return callbackCommandHandlers.cmdTaskCompleted(rest);
    case 'task-failed':               return callbackCommandHandlers.cmdTaskFailed(rest);
    case 'task-progress':             return callbackCommandHandlers.cmdTaskProgress(rest);
    case 'source-data-fetched':       return rest.some((a: string) => a === '--tmp')
      ? compatCommandHandlers.compatSourceDataFetchedTmp(rest)
      : callbackCommandHandlers.cmdSourceDataFetched(rest);
    case 'source-data-fetch-failure': return callbackCommandHandlers.cmdSourceDataFetchFailure(rest);
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
