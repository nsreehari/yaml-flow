/**
 * Board Live Cards — Disk persistence + CLI for ReactiveGraph.
 */

import {
  makeBoardTempFilePath,
  buildBoardCliInvocation,
  genUUID,
  resolveModuleDir,
  joinPath,
  resolvePath,
  dirnamePath,
  isAbsolutePath,
} from './process-runner.js';
import { withRelayLock, serializeRef, parseRef } from './storage-interface.js';
import type { KindValueRef } from './storage-interface.js';
import { dispatchTaskExecutorDetached, buildLocalBaseSpec, builtInSourceCliExecutorRef } from './execution-adapter.js';
import { blobStorageForRef } from './public-storage-adapter.js';
import { restore } from '../continuous-event-graph/core.js';
import type { LiveGraph } from '../continuous-event-graph/types.js';
import type { ReactiveGraph } from '../continuous-event-graph/reactive.js';
import { createReactiveGraph } from '../continuous-event-graph/reactive.js';
import { createLiveGraph, snapshot } from '../continuous-event-graph/core.js';
import type { GraphEvent } from '../event-graph/types.js';
import type { Journal } from '../continuous-event-graph/journal.js';
import { validateLiveCardDefinition } from '../card-compute/schema-validator.js';
import {
  createCardHandlerFn,
  buildBoardStatusObject,
  createCardStore, createJournalStore, createExecutionRequestStore,
  createStateSnapshotStore, createBoardConfigStore, createFetchedSourcesStore, createCardRuntimeStore,
  createPublishedOutputsStore,
  BOARD_GRAPH_KEY, SNAPSHOT_SCHEMA_VERSION_V1,
  EMPTY_CONFIG,
  boardEnvelopeToSnapshotEntries, snapshotEntriesToBoardEnvelope,
  type BoardEnvelope,
  type CardUpsertIndexEntry,
  type CardInventoryEntry, type CardInventoryIndex,
  type BoardConfigStore,
} from './board-live-cards-lib.js';
import {
  createFsKvStorage,
  createFsBlobStorage,
  createFsAbsolutePathBlobStorage,
  createFsAtomicRelayLock,
  createFsJournalStorageAdapter,
  createFsCardStorageAdapter,
  createFsStateSnapshotStorageAdapter,
} from './storage-fs-adapters.js';
import { createNodeInvocationAdapter, createNodeCommandExecutor } from './process-runner.js';
import type { InvocationAdapter } from './process-interface.js';
import type { BoardPlatformAdapter, BoardNonCorePlatformAdapter } from './board-live-cards-public.js';
import { createBoardLiveCardsPublic, createBoardLiveCardsNonCorePublic } from './board-live-cards-public.js';
export type { BoardPlatformAdapter, BoardNonCorePlatformAdapter } from './board-live-cards-public.js';
export { createBoardLiveCardsPublic, createBoardLiveCardsNonCorePublic } from './board-live-cards-public.js';
export type { SourceRuntimeEntry, FetchRuntimeEntry, SourceTokenPayload, CommandResponse } from './board-live-cards-lib.js';
export { isSourceInFlight, decideSourceAction, nextEntryAfterFetchDelivery, nextEntryAfterFetchFailure, Resp } from './board-live-cards-lib.js';

const BOARD_LOCK_FILE = '.board.lock';

const INVENTORY_FILE = 'cards-inventory.jsonl';
const RUNTIME_OUT_FILE = '.runtime-out';
const DEFAULT_RUNTIME_OUT_DIR = 'runtime-out';
function createBoardConfig(baseRef: KindValueRef): BoardConfigStore {
  return createBoardConfigStore(createFsKvStorage(joinPath(baseRef.value, '.config')));
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
      baseRef: KindValueRef,
      enrichedCard: Record<string, unknown>,
      callbackToken: string,
    ) {
      if (process.env.BOARD_LIVE_CARDS_NO_SPAWN === '1') return { dispatched: false, invocationId: undefined };
      try {
        const dir = baseRef.value;
        const executorRef = createBoardConfig(baseRef).readTaskExecutorRef() ?? builtInSourceCliExecutorRef();

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
            cbk: callbackToken, rg: dir, br: serializeRef(baseRef), cid: cardId,
            b: src.bindTo, d: src.outputFile, cs: undefined,
          });
          const inFile  = makeBoardTempFilePath(dir, `source-in-${src.bindTo}`);
          const outFile = makeBoardTempFilePath(dir, `source-out-${src.bindTo}`);
          const errFile = makeBoardTempFilePath(dir, `source-err-${src.bindTo}`, '.txt');
          const inEnvelope = {
            source_def: src,
            base_ref: serializeRef(baseRef),
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

const nodeStateSnapshotStore = createStateSnapshotStore(createFsStateSnapshotStorageAdapter());

// ============================================================================
// createFsBoardPlatformAdapter — wires FS adapters into BoardPlatformAdapter
//
// All platform-specific Node/FS concerns are encapsulated here.
// board-live-cards-public.ts depends only on BoardPlatformAdapter, never on
// Node built-ins or FS details.
//
// Usage:
//   const board = createBoardLiveCardsPublic(baseRef, createFsBoardPlatformAdapter(baseRef, cliDir));
// ============================================================================

export function createFsBoardPlatformAdapter(
  baseRef: KindValueRef,
  cliDir: string,
  opts?: { onWarn?: (msg: string) => void },
): BoardPlatformAdapter {
  const dir = baseRef.value;

  // Resolve selfRef once — the board CLI script path that executors call back to.
  const { cmd: _cliCmd, args: _cliArgs } = buildBoardCliInvocation(cliDir, '_', []);
  const boardCliScriptPath =
    (_cliCmd === process.execPath && _cliArgs[0]?.endsWith('.js'))
      ? _cliArgs[0]
      : (_cliArgs[1] ?? _cliArgs[0]);
  const selfRef = {
    meta: 'board-live-cards',
    howToRun: 'local-node' as const,
    whatToRun: serializeRef({ kind: 'fs-path', value: boardCliScriptPath }),
  };

  return {
    kvStorage: (namespace: string) =>
      createFsKvStorage(joinPath(dir, `.${namespace}`)),

    blobStorage: (namespace: string) =>
      namespace ? createFsBlobStorage(joinPath(dir, namespace)) : createFsBlobStorage(dir),

    journalAdapter: () => createFsJournalStorageAdapter(dir),

    lock: createFsAtomicRelayLock(joinPath(dir, BOARD_LOCK_FILE)),

    selfRef,

    async dispatchExecution(ref, args) {
      if (process.env.BOARD_LIVE_CARDS_NO_SPAWN === '1') return { dispatched: false };
      try {
        const label = (args['source_def'] as Record<string, unknown> | undefined)?.['bindTo'] as string | undefined
          ?? genUUID().slice(0, 8);
        const inFile  = makeBoardTempFilePath(dir, `exec-in-${label}`);
        const outFile = makeBoardTempFilePath(dir, `exec-out-${label}`);
        const errFile = makeBoardTempFilePath(dir, `exec-err-${label}`, '.txt');
        const inRef   = serializeRef({ kind: 'fs-path', value: inFile });
        const outRef  = serializeRef({ kind: 'fs-path', value: outFile });
        const errRef  = serializeRef({ kind: 'fs-path', value: errFile });
        blobStorageForRef({ kind: 'fs-path', value: inFile }).write(inFile, JSON.stringify(args, null, 2));
        dispatchTaskExecutorDetached(ref, { subcommand: 'run-source-fetch', inRef, outRef, errRef }, cliDir);
        return { dispatched: true };
      } catch (e) {
        return { dispatched: false, error: e instanceof Error ? e.message : String(e) };
      }
    },

    onWarn: opts?.onWarn,
  };
}

// ============================================================================
// createFsBoardNonCorePlatformAdapter — extends the FS adapter with synchronous
// executor dispatch, schema validation, temp file factory, and absolute blob I/O.
// Required for: validateCard, validateTmpCard, probeSource, probeTmpSource,
//               describeTaskExecutorCapabilities
// ============================================================================

export function createFsBoardNonCorePlatformAdapter(
  baseRef: KindValueRef,
  cliDir: string,
  opts?: { onWarn?: (msg: string) => void },
): BoardNonCorePlatformAdapter {
  const base = createFsBoardPlatformAdapter(baseRef, cliDir, opts);
  const executor = createNodeCommandExecutor();
  return {
    ...base,
    invokeExecutorSync(ref, subcommand, args, execOpts) {
      const { command, baseArgs } = buildLocalBaseSpec(ref, cliDir);
      return executor.executeSync(command, [...baseArgs, subcommand, ...args], {
        timeout: execOpts?.timeout ?? 30_000,
        encoding: 'utf-8',
      });
    },
    validateSchema(card) {
      const result = validateLiveCardDefinition(card);
      return { ok: result.errors.length === 0, errors: result.errors };
    },
    makeTempFilePath(label, ext) {
      return makeBoardTempFilePath(baseRef.value, label, ext);
    },
    absoluteBlob: createFsAbsolutePathBlobStorage(),
  };
}

export interface JournalEntry {
  id: string;
  event: GraphEvent;
}

export class BoardJournal implements Journal {
  private readonly adapter: ReturnType<typeof createFsJournalStorageAdapter>;
  private lastDrainedId: string;

  constructor(journalPath: string, lastDrainedJournalId: string) {
    // journalPath is the full path; derive boardDir by stripping the filename
    this.adapter = createFsJournalStorageAdapter(dirnamePath(journalPath));
    this.lastDrainedId = lastDrainedJournalId;
  }

  append(event: GraphEvent): void {
    this.adapter.appendEntry({ id: genUUID(), event });
  }

  drain(): GraphEvent[] {
    const all = this.adapter.readAllEntries();
    if (all.length === 0) return [];
    let startIdx = 0;
    if (this.lastDrainedId) {
      const drainedIdx = all.findIndex(e => e.id === this.lastDrainedId);
      if (drainedIdx !== -1) startIdx = drainedIdx + 1;
    }
    const undrained = all.slice(startIdx);
    if (undrained.length > 0) this.lastDrainedId = undrained[undrained.length - 1].id;
    return undrained.map(e => e.event);
  }

  get size(): number {
    const all = this.adapter.readAllEntries();
    if (!this.lastDrainedId) return all.length;
    const drainedIdx = all.findIndex(e => e.id === this.lastDrainedId);
    return drainedIdx === -1 ? all.length : all.length - drainedIdx - 1;
  }

  get lastDrainedJournalId(): string {
    return this.lastDrainedId;
  }
}

// ============================================================================
// Cards inventory
// ============================================================================

export function readCardInventory(baseRef: KindValueRef): CardInventoryEntry[] {
  const inventoryPath = joinPath(baseRef.value, INVENTORY_FILE);
  const raw = blobStorageForRef({ kind: 'fs-path', value: inventoryPath }).read(inventoryPath);
  if (!raw) return [];
  return raw.split('\n').filter(l => l.trim()).map(l => JSON.parse(l) as CardInventoryEntry);
}

export function lookupCardPath(baseRef: KindValueRef, cardId: string): string | null {
  // Check new KV store first
  const kv = createFsKvStorage(joinPath(baseRef.value, '.card-upsert-kv'));
  const kvEntry = kv.read(cardId) as CardUpsertIndexEntry | null;
  if (kvEntry?.blobRef) return kvEntry.blobRef;
  // Fall back to legacy inventory
  const entries = readCardInventory(baseRef);
  const entry = entries.find(e => e.cardId === cardId);
  return entry?.cardFilePath ?? null;
}

/** Read all entries from the card-upsert KV dedup cache. Keyed by cardId. */
export function readCardUpsertIndex(baseRef: KindValueRef): Record<string, CardUpsertIndexEntry> {
  const kv = createFsKvStorage(joinPath(baseRef.value, '.card-upsert-kv'));
  const result: Record<string, CardUpsertIndexEntry> = {};
  for (const cardId of kv.listKeys()) {
    const entry = kv.read(cardId) as CardUpsertIndexEntry | null;
    if (entry) result[cardId] = entry;
  }
  return result;
}

export function appendCardInventory(baseRef: KindValueRef, entry: CardInventoryEntry): void {
  const inventoryPath = joinPath(baseRef.value, INVENTORY_FILE);
  const storage = blobStorageForRef({ kind: 'fs-path', value: inventoryPath });
  const existing = storage.read(inventoryPath) ?? '';
  const normalized: CardInventoryEntry = { ...entry, cardFilePath: resolvePath(entry.cardFilePath) };
  storage.write(inventoryPath, existing + JSON.stringify(normalized) + '\n');
}

export function buildCardInventoryIndex(baseRef: KindValueRef): CardInventoryIndex {
  const byCardId = new Map<string, CardInventoryEntry>();
  const byCardPath = new Map<string, CardInventoryEntry>();

  for (const entry of readCardInventory(baseRef)) {
    const normalizedPath = resolvePath(entry.cardFilePath);
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
  const lockPath = joinPath(dir, BOARD_LOCK_FILE);
  const lockStorage = blobStorageForRef({ kind: 'fs-path', value: lockPath });

  if (lockStorage.read(lockPath) !== null) {
    // Validate it's a real board envelope
    const envelope = loadBoardEnvelope(baseRef);
    restore(envelope.graph);
    return 'exists';
  }

  // If dir exists and is non-empty with no lock file, refuse
  const existingKeys = createFsKvStorage(dir).listKeys();
  if (existingKeys.length > 0) {
    throw new Error(`Directory "${dir}" is not empty and has no valid board`);
  }

  // Create dir + lock marker file (required by proper-lockfile).
  lockStorage.write(lockPath, '{}');
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
export function loadBoardEnvelope(baseRef: KindValueRef): BoardEnvelope {
  const dir = baseRef.value;
  const snapshot = nodeStateSnapshotStore.readSnapshot(dir);
  if (!snapshot.values[BOARD_GRAPH_KEY]) {
    throw new Error(`Missing board state at: ${dir}`);
  }
  return snapshotEntriesToBoardEnvelope(snapshot.values);
}

export function loadBoard(baseRef: KindValueRef): LiveGraph {
  const envelope = loadBoardEnvelope(baseRef);
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
export function saveBoard(baseRef: KindValueRef, rg: ReactiveGraph, journalOrCursor: BoardJournal | string): void {
  const dir = baseRef.value;
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

function resolveConfiguredRuntimeOutDir(baseRef: KindValueRef): string {
  const dir = baseRef.value;
  const cfgPath = joinPath(dir, RUNTIME_OUT_FILE);
  const cfgStorage = blobStorageForRef({ kind: 'fs-path', value: cfgPath });
  const configured = cfgStorage.read(cfgPath)?.trim();
  if (configured) {
    return isAbsolutePath(configured) ? configured : resolvePath(dir, configured);
  }
  const defaultDir = joinPath(dir, DEFAULT_RUNTIME_OUT_DIR);
  cfgStorage.write(cfgPath, defaultDir);
  return defaultDir;
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

import type { SourceTokenPayload } from './board-live-cards-lib.js';

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
export function appendEventToJournal(baseRef: KindValueRef, event: GraphEvent): void {
  createJournalStore(createFsJournalStorageAdapter(baseRef.value)).appendEvent(event);
}

/**
 * Read journal entries after the given ID. Pure file read, no mutation.
 */
export function getUndrainedEntries(baseRef: KindValueRef, lastDrainedId: string): JournalEntry[] {
  const entries = createFsJournalStorageAdapter(baseRef.value).readAllEntries();
  if (!lastDrainedId) return entries;
  const idx = entries.findIndex(e => e.id === lastDrainedId);
  return idx === -1 ? entries : entries.slice(idx + 1);
}

function determineLatestPendingAccumulated(baseRef: KindValueRef): number {
  const dir = baseRef.value;
  const lockPath = joinPath(dir, BOARD_LOCK_FILE);
  if (blobStorageForRef({ kind: 'fs-path', value: lockPath }).read(lockPath) === null) return 0;
  try {
    const envelope = loadBoardEnvelope(baseRef);
    const journalStore = createJournalStore(createFsJournalStorageAdapter(dir));
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
export async function processAccumulatedEvents(baseRef: KindValueRef, continuation?: () => void): Promise<boolean> {
  const dir = baseRef.value;
  const lockPath = joinPath(dir, BOARD_LOCK_FILE);
  const cliDir = __dirname;
  const lock = createFsAtomicRelayLock(lockPath);
  return withRelayLock(lock, async () => {
    const journalStore = createJournalStore(createFsJournalStorageAdapter(dir));
    const taskCompletedFn = (taskName: string, data: Record<string, unknown>): void => {
      appendEventToJournal(baseRef, { type: 'task-completed', taskName, data, timestamp: new Date().toISOString() });
    };
    const taskFailedFn = (taskName: string, error: string): void => {
      appendEventToJournal(baseRef, { type: 'task-failed', taskName, error, timestamp: new Date().toISOString() });
    };
    const onDispatchFailed = (entry: import('./board-live-cards-lib.js').ExecutionRequestEntry, error: string): void => {
      const p = entry.payload as Record<string, unknown>;
      const taskName = (p?.enrichedCard as Record<string, unknown> | undefined)?.id as string | undefined
        ?? p?.cardId as string | undefined
        ?? 'unknown';
      taskFailedFn(taskName, error);
    };
    const executionRequestStore = createExecutionRequestStore(createFsKvStorage(joinPath(dir, '.execution-requests')), onDispatchFailed);
    const cardHandlerAdapters = {
      cardStore: createCardStore(createFsCardStorageAdapter(dir), console.warn),
      cardRuntimeStore: createCardRuntimeStore(createFsKvStorage(joinPath(dir, '.state-snapshot'))),
      fetchedSourcesStore: createFetchedSourcesStore(createFsBlobStorage(dir), resolveSourceDataRef),
      outputStore: createPublishedOutputsStore(createFsKvStorage(resolveConfiguredRuntimeOutDir(baseRef))),
      executionRequestStore,
    };
    const envelope = loadBoardEnvelope(baseRef);
    const live = restore(envelope.graph);
    const { events: undrained, newCursor } = journalStore.readEntriesAfterCursor(envelope.lastDrainedJournalId);
    const invocationAdapter = createBoardInvocationAdapter(cliDir);
    const rg = createReactiveGraph(live, { handlers: { 'card-handler': createCardHandlerFn(baseRef, newCursor, cardHandlerAdapters, taskCompletedFn, taskFailedFn) } });
    rg.pushAll(undrained);
    await rg.dispose({ wait: true });
    saveBoard(baseRef, rg, newCursor);
    try {
      cardHandlerAdapters.outputStore.writeStatusSnapshot(buildBoardStatusObject(serializeRef(baseRef), restore(rg.snapshot())));
    } catch (err) {
      console.warn(`[board-live-cards] status cache publish failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    executionRequestStore.dispatchEntriesForJournalId(newCursor, (entry) => {
      if (entry.taskKind === 'source-fetch') {
        const p = entry.payload as { boardRef: string; enrichedCard: Record<string, unknown>; callbackToken: string };
        invocationAdapter.requestSourceFetch(parseRef(p.boardRef), p.enrichedCard, p.callbackToken)
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
export async function processAccumulatedEventsInfinitePass(baseRef: KindValueRef, adapter: InvocationAdapter): Promise<boolean> {
  if (determineLatestPendingAccumulated(baseRef) === 0) return true;
  return processAccumulatedEvents(baseRef, () => { void adapter.requestProcessAccumulated(baseRef); });
}

/**
 * Run one immediate drain pass then schedule infinite-pass continuation.
 */
export async function processAccumulatedEventsForced(baseRef: KindValueRef, adapter: InvocationAdapter): Promise<void> {
  await processAccumulatedEvents(baseRef);
  await processAccumulatedEventsInfinitePass(baseRef, adapter);
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
// cli() — thin arg-parse → public layer → print JSON
// ============================================================================

/** Parse a required flag value, throws with usage message if missing. */
function requireFlag(args: string[], flag: string, usage: string): string {
  const idx = args.indexOf(flag);
  const val = idx !== -1 ? args[idx + 1] : undefined;
  if (!val) throw new Error(`Missing ${flag}\nUsage: ${usage}`);
  return val;
}

function optFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : undefined;
}

function printResult(result: unknown): void {
  console.log(JSON.stringify(result, null, 2));
}

export async function cli(argv: string[]): Promise<void> {
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('board-live-cards-cli — see board-live-cards-cli-PARAMS.md for command reference');
    return;
  }

  // ── Commands that need a baseRef ────────────────────────────────────────────
  const br = optFlag(rest, '--base-ref');
  const baseRef = br ? parseRef(br) : undefined;

  // ── Token-based callbacks (token encodes baseRef — no --base-ref needed) ───
  if (cmd === 'task-completed') {
    const token = requireFlag(rest, '--token', 'task-completed --token <token> [--data <json>]');
    const dataRaw = optFlag(rest, '--data');
    const data = dataRaw ? JSON.parse(dataRaw) as Record<string, unknown> : undefined;
    const payload = decodeCallbackToken(token);
    if (!payload) throw new Error('Invalid callback token');
    const br2 = parseRef(JSON.parse(Buffer.from(token, 'base64url').toString()).br as string);
    const board = createBoardLiveCardsPublic(br2, createFsBoardPlatformAdapter(br2, __dirname, { onWarn: console.warn }));
    printResult(board.taskCompleted(token, data));
    return;
  }
  if (cmd === 'task-failed') {
    const token = requireFlag(rest, '--token', 'task-failed --token <token> [--error <message>]');
    const br2 = parseRef(JSON.parse(Buffer.from(token, 'base64url').toString()).br as string);
    const board = createBoardLiveCardsPublic(br2, createFsBoardPlatformAdapter(br2, __dirname, { onWarn: console.warn }));
    printResult(board.taskFailed(token, optFlag(rest, '--error')));
    return;
  }
  if (cmd === 'task-progress') {
    const token = requireFlag(rest, '--token', 'task-progress --token <token> [--update <json>]');
    const updateRaw = optFlag(rest, '--update');
    const update = updateRaw ? JSON.parse(updateRaw) as Record<string, unknown> : undefined;
    const br2 = parseRef(JSON.parse(Buffer.from(token, 'base64url').toString()).br as string);
    const board = createBoardLiveCardsPublic(br2, createFsBoardPlatformAdapter(br2, __dirname, { onWarn: console.warn }));
    printResult(board.taskProgress(token, update));
    return;
  }
  if (cmd === 'source-data-fetched') {
    const token = requireFlag(rest, '--token', 'source-data-fetched --token <token> --ref <sourcefile>');
    const ref   = requireFlag(rest, '--ref',   'source-data-fetched --token <token> --ref <sourcefile>');
    const p = JSON.parse(Buffer.from(token, 'base64url').toString()) as Record<string, unknown>;
    const br2 = parseRef(p['br'] as string);
    const board = createBoardLiveCardsPublic(br2, createFsBoardPlatformAdapter(br2, __dirname, { onWarn: console.warn }));
    printResult(board.sourceDataFetched(token, ref));
    return;
  }
  if (cmd === 'source-data-fetch-failure') {
    const token = requireFlag(rest, '--token', 'source-data-fetch-failure --token <token> [--reason <message>]');
    const p = JSON.parse(Buffer.from(token, 'base64url').toString()) as Record<string, unknown>;
    const br2 = parseRef(p['br'] as string);
    const board = createBoardLiveCardsPublic(br2, createFsBoardPlatformAdapter(br2, __dirname, { onWarn: console.warn }));
    printResult(board.sourceDataFetchFailure(token, optFlag(rest, '--reason')));
    return;
  }

  // ── validate-tmp-card (no baseRef, uses --card-ref) ─────────────────────────
  if (cmd === 'validate-tmp-card') {
    const cardRef = requireFlag(rest, '--card-ref', 'validate-tmp-card --card-ref <::kind::value>');
    // For validate-tmp-card we still need a board context for the config store.
    // If --base-ref is provided use it; otherwise create a minimal adapter scoped to cwd.
    const tmpRef = baseRef ?? { kind: 'fs-path', value: resolvePath('.') };
    const nonCore = createBoardLiveCardsNonCorePublic(tmpRef, createFsBoardNonCorePlatformAdapter(tmpRef, __dirname, { onWarn: console.warn }));
    printResult(nonCore.validateTmpCard(cardRef));
    return;
  }

  // ── probe-tmp-source (no required baseRef) ──────────────────────────────────
  if (cmd === 'probe-tmp-source') {
    const sourceDefRaw = requireFlag(rest, '--source-def', 'probe-tmp-source --source-def <json> --mock-projections <json> --out-ref <ref>');
    const mockRaw      = requireFlag(rest, '--mock-projections', 'probe-tmp-source --source-def <json> --mock-projections <json> --out-ref <ref>');
    const outRef       = requireFlag(rest, '--out-ref', 'probe-tmp-source --source-def <json> --mock-projections <json> --out-ref <ref>');
    const tmpRef = baseRef ?? { kind: 'fs-path', value: resolvePath('.') };
    const nonCore = createBoardLiveCardsNonCorePublic(tmpRef, createFsBoardNonCorePlatformAdapter(tmpRef, __dirname, { onWarn: console.warn }));
    printResult(nonCore.probeTmpSource(JSON.parse(sourceDefRaw) as Record<string, unknown>, JSON.parse(mockRaw) as Record<string, unknown>, outRef));
    return;
  }

  // ── All remaining commands require --base-ref ────────────────────────────────
  if (!baseRef) throw new Error(`--base-ref is required for command "${cmd ?? '(none)'}"`);

  const board    = () => createBoardLiveCardsPublic(baseRef, createFsBoardPlatformAdapter(baseRef, __dirname, { onWarn: console.warn }));
  const nonCore  = () => createBoardLiveCardsNonCorePublic(baseRef, createFsBoardNonCorePlatformAdapter(baseRef, __dirname, { onWarn: console.warn }));

  switch (cmd) {
    case 'init': {
      printResult(board().init(optFlag(rest, '--task-executor'), optFlag(rest, '--chat-handler')));
      return;
    }
    case 'status': {
      printResult(board().status());
      return;
    }
    case 'remove-card': {
      const id = requireFlag(rest, '--id', 'remove-card --base-ref <ref> --id <card-id>');
      printResult(board().removeCard(id));
      return;
    }
    case 'retrigger': {
      const id = requireFlag(rest, '--id', 'retrigger --base-ref <ref> --id <card-id>');
      printResult(board().retrigger(id));
      return;
    }
    case 'process-accumulated-events': {
      printResult(await board().processAccumulatedEvents());
      return;
    }
    case 'upsert-card': {
      const cardId  = requireFlag(rest, '--card-id', 'upsert-card --base-ref <ref> --card-id <id> [--restart]');
      const restart = rest.includes('--restart');
      printResult(board().upsertCard(cardId, restart));
      return;
    }
    case 'validate-card': {
      const cardId = requireFlag(rest, '--card-id', 'validate-card --base-ref <ref> --card-id <id>');
      printResult(nonCore().validateCard(cardId));
      return;
    }
    case 'probe-source': {
      const cardId    = requireFlag(rest, '--card-id', 'probe-source --base-ref <ref> --card-id <id> --source-idx <n> --mock-projections <json> --out-ref <ref>');
      const idxRaw    = requireFlag(rest, '--source-idx', 'probe-source --base-ref <ref> --card-id <id> --source-idx <n> --mock-projections <json> --out-ref <ref>');
      const mockRaw   = requireFlag(rest, '--mock-projections', 'probe-source --base-ref <ref> --card-id <id> --source-idx <n> --mock-projections <json> --out-ref <ref>');
      const outRef    = requireFlag(rest, '--out-ref', 'probe-source --base-ref <ref> --card-id <id> --source-idx <n> --mock-projections <json> --out-ref <ref>');
      printResult(nonCore().probeSource(cardId, parseInt(idxRaw, 10), JSON.parse(mockRaw) as Record<string, unknown>, outRef));
      return;
    }
    case 'describe-task-executor-capabilities': {
      printResult(nonCore().describeTaskExecutorCapabilities());
      return;
    }
    default:
      throw new Error(`Unknown command: ${cmd ?? '(none)'}`);
  }
}

// Run when invoked directly
const isMain = process.argv[1] && resolvePath(process.argv[1]) === resolvePath(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
if (isMain) {
  cli(process.argv.slice(2)).catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    process.exit(1);
  });
}
