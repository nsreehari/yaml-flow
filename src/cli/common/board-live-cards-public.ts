/**
 * board-live-cards-public.ts
 *
 * Platform-free public API layer for the board-live-cards system.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER DIAGRAM
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   board-live-cards-cli.ts       (THIN — arg parse → call public → print JSON)
 *           ↓ calls
 *   board-live-cards-public.ts    (THIS FILE — facade, all logic, no platform code)
 *           ↓ depends on injected
 *   board-live-cards-lib.ts       (pure domain — stores, graph, codecs)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PLATFORM ADAPTERS  (injected into BoardPlatformAdapter)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Node/FS         createFsBoardPlatformAdapter(baseRef, cliDir)
 *   Azure Functions createAzureBoardPlatformAdapter(baseRef, containerClient, …)
 *   Firebase Fn     createFirebaseBoardPlatformAdapter(baseRef, firestoreDb, …)
 *   In-memory/test  createInMemoryBoardPlatformAdapter(baseRef)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   const board = createBoardLiveCardsPublic(baseRef, adapter);
 *   const result = await board.processAccumulatedEvents();
 *   const status = board.status();
 */

import type { KVStorage, BlobStorage, KindValueRef, AtomicRelayLock, ScratchStorage, ArchiveFactory } from './storage-interface.js';
import { withRelayLock, serializeRef, parseRef } from './storage-interface.js';
import type { ExecutionRef } from './execution-interface.js';
import { restore, createLiveGraph, snapshot } from '../../continuous-event-graph/core.js';
import { createReactiveGraph } from '../../continuous-event-graph/reactive.js';
import type { GraphEvent } from '../../event-graph/types.js';
import { CardCompute } from '../../card-compute/index.js';
import type { ComputeNode } from '../../card-compute/index.js';
import {
  createCardStore,
  createJournalStore,
  createExecutionRequestStore,
  createCardRuntimeStore,
  createFetchedSourcesStore,
  createPublishedOutputsStore,
  createBoardConfigStore,
  createStateSnapshotStore,
  buildBoardStatusObject,
  createCardHandlerFn,
  EMPTY_CONFIG,
  BOARD_GRAPH_KEY,
  SNAPSHOT_SCHEMA_VERSION_V1,
  boardEnvelopeToSnapshotEntries,
  snapshotEntriesToBoardEnvelope,
  liveCardToTaskConfig,
} from './board-live-cards-lib.js';
import type {
  JournalStorageAdapter,
  StateSnapshotStorageAdapter,
  CardStorageAdapter,
  StateSnapshotReadView,
  CardUpsertIndexEntry,
  ExecutionRequestEntry,
  BoardEnvelope,
  SourceTokenPayload,
  BoardStatusObject,
  LiveCard,
  CardIndex,
  CardRuntimeStore,
  CardRuntimeSnapshot,
  FetchedSourcesStore,
  OutputStoreEvent,
} from './board-live-cards-lib.js';

// Re-export constants so platform adapter files can import them without going through lib directly.
export { BOARD_GRAPH_KEY, SNAPSHOT_SCHEMA_VERSION_V1, EMPTY_CONFIG } from './board-live-cards-lib.js';

// ============================================================================
// CommandInput — uniform request envelope
//
//   params — scalar routing/identity args (cardId, token, restart, etc.)
//   body   — structured payload that arrives via stdin / HTTP body / in-process
//            (card JSON, source-def object, task data, mock-projections, ...)
//
// Transport adapters (CLI, Azure Fn, in-process) are responsible for reading
// the transport channel and building this shape before calling any method.
// The public layer never knows how data arrived.
// ============================================================================

export type CommandInput = {
  params?: Record<string, string | number | boolean>;
  body?:   unknown;
};

// ============================================================================
// CommandResult — uniform return envelope (success / fail / error)
//
//   success — operation completed normally
//   fail    — operation rejected due to caller input (card not found, bad token)
//   error   — unexpected internal error (exception caught)
// ============================================================================

export type CommandResult<T = undefined> =
  | (T extends undefined ? { status: 'success' } : { status: 'success'; data: T })
  | { status: 'fail'; error: string }
  | { status: 'error'; error: string };

// Internal helpers for building CommandResult values.
function ok(): CommandResult;
function ok<T>(data: T): CommandResult<T>;
function ok<T>(data?: T): CommandResult<T> {
  return (data !== undefined
    ? { status: 'success', data }
    : { status: 'success' }) as CommandResult<T>;
}
function fail(error: string): CommandResult { return { status: 'fail', error }; }
function err(e: unknown): CommandResult { return { status: 'error', error: e instanceof Error ? e.message : String(e) }; }

// ============================================================================
// BoardPlatformAdapter — the single injection point
// ============================================================================

export interface BoardPlatformAdapter {
  /**
   * KV storage factory — scoped by namespace.
   * Namespaces used by the public layer:
   *   'state-snapshot'     — board graph snapshot (StateSnapshotStorageAdapter, built internally)
   *   'config'             — board configuration (.task-executor, .chat-handler, .chat-handler-flow, .card-store-ref)
   *   'card-upsert'        — card upsert dedup index
   *   'execution-requests' — queued execution requests (keyed by journalId)
   *   'card-runtime'       — card runtime state snapshots
   *   'output'             — published board status + card computed outputs
   */
  kvStorage(namespace: string): KVStorage;

  /**
   * Build a KVStorage rooted at the given ref.
   * Used by the public layer for both card store and outputs store routing.
   *   FS:          createFsKvStorage(parseRef(ref).value)
   *   localStorage: createLocalStorageKvStorage(parseRef(ref).value)
   */
  kvStorageForRef(ref: string): KVStorage;

  /**
   * Blob storage factory — scoped by namespace.
   * Namespaces used by the public layer:
   *   'sources' — fetched source data files (keyed by cardId/outputFile)
   *   ''        — root-scoped blob access (for resolving arbitrary KindValueRef blobs)
   */
  blobStorage(namespace: string): BlobStorage;

  /**
   * Ephemeral scratch store for transient I/O staging (probe in/out/err,
   * dispatchExecution argv/out/err). Default scope is board-local; if the
   * config has a 'scratch-store-ref' set, scratchStorageForRef(ref) is used
   * instead.
   */
  scratchStorage(): ScratchStorage;
  scratchStorageForRef(ref: string): ScratchStorage;

  /**
   * Archive factory — long-lived tracking / audit store. Default scope is
   * board-local; if the config has an 'archive-store-ref' set,
   * archiveFactoryForRef(ref) is used instead so archives can live on a
   * different backend / path than the main board runtime.
   */
  archiveFactory(): ArchiveFactory;
  archiveFactoryForRef(ref: string): ArchiveFactory;

  /**
   * Journal storage adapter (append-only log).
   * Uses the lib's JournalStorageAdapter interface.
   * One journal per board — no namespace parameter needed.
   */
  journalAdapter(): JournalStorageAdapter;

  /**
   * AtomicRelayLock — non-blocking try-acquire with relay-on-busy semantics.
   * Guards processAccumulatedEvents drain cycle.
   *   FS:        proper-lockfile (createFsAtomicRelayLock)
   *   Azure:     blob lease
   *   Firestore: Firestore transaction + sentinel document
   */
  lock: AtomicRelayLock;

  /**
   * Self-identity ExecutionRef — how to invoke THIS board instance.
   * Embedded in source callback tokens so executors know where to report back.
  *   Node/FS:  { howToRun: 'local-node', whatToRun: 'b64:<base64url({"kind":"yaml-flow-cli","value":"board-live-cards-cli.js"})>' }
  *   Azure Fn: { howToRun: 'http:post',  whatToRun: 'b64:<base64url({"kind":"http-url","value":"https://…/api/board"})>' }
   */
  selfRef: ExecutionRef;

  /**
   * Generic execution dispatch — platform adapts ExecutionRef → actual transport.
   * Public layer constructs fully-formed semantic args (source def, base_ref,
   * callback token with selfRef baked in). Platform handles transport:
   *   Node: writes args to temp file, spawns detached process
   *   Azure: HTTP POST args as JSON body
   *   Firebase: publishes args as pubsub message
   */
  dispatchExecution(ref: ExecutionRef, args: Record<string, unknown>): Promise<{ dispatched: boolean; error?: string }>;

  /**
   * Resolve a blob ref to its string contents.
   * The adapter handles the platform-specific lookup (e.g. absolute FS path vs board-relative key).
   * Throws if the blob does not exist.
   */
  resolveBlob(ref: KindValueRef): string;

  /**
   * Compute a stable, deterministic content hash for any JSON-serializable value.
   * Used for dedup indexes and snapshot versioning.
   *   Node/FS: computeStableJsonHash (storage-fs-adapters)
   *   Browser: Web Crypto subtle.digest or equivalent
   */
  hashFn(value: unknown): string;

  /**
   * Generate a random short ID (32 hex chars).
   * Used for commit IDs and delivery tokens.
   *   Node/FS: getHash(`${Date.now()}-${Math.random()}`).slice(0, 32)
   *   Browser: crypto.randomUUID().replace(/-/g, '')
   */
  genId(): string;

  /**
   * Request an additional drain pass asynchronously (e.g. spawn a background process).
   * Called as the relay continuation after each drain cycle so that events written
   * during the cycle (e.g. task-completed appended by the card handler) are eventually
   * processed even when the current process exits immediately after returning.
   * Optional — if absent, no continuation is scheduled.
   */
  requestProcessAccumulated?(): void;

  /**
   * Optional cross-process board change notification publisher (named pipe, webhook, pubsub, etc.).
   * Called once per drain cycle with the complete batch of notifications produced in that cycle.
   */
  publishBoardChangeNotifications?(notifications: BoardChangeNotification[]): void | Promise<void>;

  /** Optional warn sink — defaults to no-op. */
  onWarn?(msg: string): void;
}

// ============================================================================
// BoardLiveCardsPublic — the public API surface
//
// All methods are scoped to the baseRef provided at construction time.
// ============================================================================

export interface BoardLiveCardsPublic {
  // Board management
  // body: task-executor-ref?, chat-handler-flow?
  init(input: CommandInput): CommandResult;
  // no params needed
  status(input: CommandInput): CommandResult<BoardStatusObject>;
  // no params needed
  getCardStoreRef(input: CommandInput): CommandResult<{ storeRef: string }>;
  getOutputsStoreRef(input: CommandInput): CommandResult<{ storeRef: string }>;
  getScratchStoreRef(input: CommandInput): CommandResult<{ storeRef: string | null }>;
  getArchiveStoreRef(input: CommandInput): CommandResult<{ storeRef: string | null }>;
  // params: key — one of: 'task-executor', 'chat-handler-flow', 'card-store-ref', 'outputs-store-ref', 'scratch-store-ref', 'archive-store-ref'
  getConfig(input: CommandInput): CommandResult<{ value: unknown }>;
  // params: key
  getOutputsDataObject(input: CommandInput): CommandResult;
  // no params needed
  getAllOutputsDataObjects(input: CommandInput): CommandResult<Record<string, unknown>>;
  // params: key
  getOutputsComputedValues(input: CommandInput): CommandResult;
  // no params needed
  getAllOutputsComputedValues(input: CommandInput): CommandResult<Record<string, unknown>>;
  // params: id
  removeCard(input: CommandInput): CommandResult;
  // params: id
  retrigger(input: CommandInput): CommandResult;
  // no params needed
  processAccumulatedEvents(input: CommandInput): Promise<CommandResult>;

  // Card management — params: cardId, restart?
  upsertCard(input: CommandInput): CommandResult;

  // Task callbacks — params.token encodes baseRef; body = task data payload
  // params: token, error?
  taskFailed(input: CommandInput): CommandResult;
  // params: token; body = update payload
  taskProgress(input: CommandInput): CommandResult;

  // Source callbacks — params: token, ref | token, reason?
  sourceDataFetched(input: CommandInput): CommandResult;
  sourceDataFetchFailure(input: CommandInput): CommandResult;
}

export type BoardChangeNotification =
  | OutputStoreEvent
  | { kind: 'card_refreshed'; cardId: string; card: LiveCard };

// ============================================================================
// Internal pure helpers — no platform deps
// ============================================================================

// Pure JS base64url encode/decode — no Node/Buffer dependency.
// TextEncoder/TextDecoder and btoa/atob are globally available in browsers and Node 16+.
function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binStr = Array.from(bytes, b => String.fromCharCode(b)).join('');
  return btoa(binStr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromBase64Url(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const binStr = atob(padded);
  const bytes = Uint8Array.from(binStr, c => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeCallbackToken(token: string): { taskName: string } | null {
  try {
    const p = JSON.parse(fromBase64Url(token));
    return typeof p?.t === 'string' ? { taskName: p.t } : null;
  } catch { return null; }
}

function encodeSourceToken(payload: SourceTokenPayload): string {
  return toBase64Url(JSON.stringify(payload));
}

function decodeSourceToken(token: string): SourceTokenPayload | null {
  try {
    const p = JSON.parse(fromBase64Url(token));
    if (typeof p?.cbk === 'string' && typeof p?.cid === 'string' &&
        typeof p?.b === 'string' && typeof p?.d === 'string') return p as SourceTokenPayload;
    return null;
  } catch { return null; }
}

function nowIso(): string { return new Date().toISOString(); }

// ============================================================================
// createBoardLiveCardsPublic — factory
// ============================================================================

export function createBoardLiveCardsPublic(
  baseRef: KindValueRef,
  adapter: BoardPlatformAdapter,
): BoardLiveCardsPublic {
  const warn = adapter.onWarn ?? (() => { /* no-op */ });
  const boardPath = serializeRef(baseRef);

  function flushBoardChangeNotifications(notifications: BoardChangeNotification[]): void {
    if (notifications.length === 0) return;
    try {
      const p = adapter.publishBoardChangeNotifications?.(notifications);
      if (p && typeof (p as Promise<void>).catch === 'function') {
        void (p as Promise<void>).catch((e: unknown) =>
          warn(`[board-live-cards-public] publishBoardChangeNotifications failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    } catch (e) {
      warn(`[board-live-cards-public] publishBoardChangeNotifications failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Inline storage adapters built from the three primitives ─────────────────
  //
  // Both CardStorageAdapter and StateSnapshotStorageAdapter are pure KV
  // compositions — no platform-specific atomicity needed at this layer.
  // The public layer builds them here so BoardPlatformAdapter stays minimal.

  function makeCardAdapter(): CardStorageAdapter {
    const storeRef = configStore().readCardStoreRef();
    if (!storeRef) throw new Error(`Board at ${baseRef.value} has no card store configured. Run: init --base-ref <ref> --store-ref <b64-ref>`);
    const kv = adapter.kvStorageForRef(storeRef);
    return {
      readIndex(): CardIndex | null { return kv.read('_index') as CardIndex | null; },
      writeIndex(index: CardIndex): void { kv.write('_index', index); },
      readCard(id: string): LiveCard | null { return kv.read(id) as LiveCard | null; },
      writeCard(id: string, card: LiveCard): string { kv.write(id, card); return adapter.hashFn(card); },
      removeCard(id: string): void { kv.delete(id); },
      cardExists(id: string): boolean { return kv.read(id) !== null; },
      defaultCardKey(cardId: string): string { return cardId; },
    };
  }

  // scopeId is intentionally ignored — the adapter is already board-scoped via
  // adapter.kvStorage('state-snapshot'), which closes over baseRef's directory.
  const snapshotAdapterImpl: StateSnapshotStorageAdapter = {
    readValues(_scopeId: string): StateSnapshotReadView {
      const kv = adapter.kvStorage('state-snapshot');
      const keys = kv.listKeys().sort();
      if (keys.length === 0) return { version: null, values: {} };
      const values: Record<string, unknown> = {};
      for (const key of keys) values[key] = kv.read(key);
      return { version: adapter.hashFn(values), values };
    },
    writeValues(_scopeId: string, nextValues: Record<string, unknown>, deletedKeys: string[]): string {
      const kv = adapter.kvStorage('state-snapshot');
      for (const key of deletedKeys) kv.delete(key);
      for (const [key, value] of Object.entries(nextValues)) kv.write(key, value);
      return adapter.hashFn(nextValues);
    },
  };

  // Store factory helpers — no long-lived singletons, created per call
  const configStore = () => createBoardConfigStore(adapter.kvStorage('config'));
  const snapshotStore = () => createStateSnapshotStore(snapshotAdapterImpl);
  const journalStore = () => createJournalStore(adapter.journalAdapter());
  const cardStore = () => createCardStore(makeCardAdapter(), warn);
  const outputStore = () => {
    const ref = configStore().readOutputsStoreRef();
    if (!ref) throw new Error(`Board at ${baseRef.value} has no outputs store configured. Run: init --outputs-store-ref <b64-ref>`);
    return createPublishedOutputsStore(adapter.kvStorageForRef(ref));
  };
  const archive = () => {
    const ref = configStore().readArchiveStoreRef();
    return ref ? adapter.archiveFactoryForRef(ref) : adapter.archiveFactory();
  };

  function boardExists(): boolean {
    return !!snapshotStore().readSnapshot(baseRef.value).values[BOARD_GRAPH_KEY];
  }

  function loadEnvelope(): BoardEnvelope {
    const snap = snapshotStore().readSnapshot(baseRef.value);
    if (!snap.values[BOARD_GRAPH_KEY]) throw new Error(`Board not initialized at ${baseRef.value}`);
    return snapshotEntriesToBoardEnvelope(snap.values);
  }

  function commitEnvelope(envelope: BoardEnvelope, expectedVersion: string | null): void {
    const result = snapshotStore().commitSnapshot(baseRef.value, {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION_V1,
      expectedVersion,
      commitId: adapter.genId(),
      committedAt: nowIso(),
      deleteKeys: [],
      shallowMerge: boardEnvelopeToSnapshotEntries(envelope),
    });
    if (!result.ok) {
      throw new Error(
        `Snapshot commit failed (version mismatch): expected=${expectedVersion ?? 'null'} current=${result.currentVersion ?? 'null'}`,
      );
    }
  }

  function appendJournalEvent(event: GraphEvent): void { journalStore().appendEvent(event); }

  // ── Drain cycle ─────────────────────────────────────────────────────────────

  async function drainCycle(): Promise<void> {
    const onDispatchFailed = (entry: ExecutionRequestEntry, error: string): void => {
      const p = entry.payload as Record<string, unknown>;
      const enriched = (p?.enrichedCard ?? {}) as Record<string, unknown>;
      const taskName = (enriched.id ?? p?.cardId ?? 'unknown') as string;
      appendJournalEvent({ type: 'task-failed', taskName, error, timestamp: nowIso() });
    };

    const executionRequestStore = createExecutionRequestStore(
      adapter.kvStorage('execution-requests'),
      onDispatchFailed,
    );

    const realCardRuntimeStore = createCardRuntimeStore(adapter.kvStorage('card-runtime'));
    const realFetchedSourcesStore = createFetchedSourcesStore(
      adapter.blobStorage('sources'),
      (ref) => adapter.resolveBlob(ref),
    );

    // RX: in-memory overlay for card runtime writes — reads check overlay first
    const RX = new Map<string, CardRuntimeSnapshot>();
    const overlayCardRuntimeStore: CardRuntimeStore = {
      readRuntime(cardId) {
        return RX.get(cardId) ?? realCardRuntimeStore.readRuntime(cardId);
      },
      writeRuntime(cardId, state) {
        RX.set(cardId, state);
      },
    };

    // SX: in-memory overlay for source commits — reads check overlay first
    const SX: { cardId: string; outputFile: string; deliveryToken: string }[] = [];
    const sxCache = new Map<string, unknown>();
    const overlayFetchedSourcesStore: FetchedSourcesStore = {
      readSourceData(cardId, outputFile) {
        const key = `${cardId}/${outputFile}`;
        if (sxCache.has(key)) return sxCache.get(key)!;
        return realFetchedSourcesStore.readSourceData(cardId, outputFile);
      },
      ingestSourceDataStaged(cardId, outputFile, ref, deliveryToken) {
        realFetchedSourcesStore.ingestSourceDataStaged(cardId, outputFile, ref, deliveryToken);
      },
      commitSourceData(cardId, outputFile, deliveryToken) {
        // Read staged content into overlay so readSourceData sees it immediately
        const stagedKey = `${cardId}/.staged/${deliveryToken}/${outputFile}`;
        const blob = adapter.blobStorage('sources');
        const content = blob.read(stagedKey);
        if (content == null) return false;
        const key = `${cardId}/${outputFile}`;
        const trimmed = content.trim();
        try { sxCache.set(key, JSON.parse(trimmed)); } catch { sxCache.set(key, trimmed); }
        SX.push({ cardId, outputFile, deliveryToken });
        return true;
      },
      hasSource(cardId, outputFile) {
        const key = `${cardId}/${outputFile}`;
        if (sxCache.has(key)) return true;
        return realFetchedSourcesStore.hasSource(cardId, outputFile);
      },
    };

    const cardHandlerAdapters = {
      cardStore: cardStore(),
      cardRuntimeStore: overlayCardRuntimeStore,
      fetchedSourcesStore: overlayFetchedSourcesStore,
      outputStore: outputStore(),
      executionRequestStore,
    };

    const envelope = loadEnvelope();
    const live = restore(envelope.graph);
    const { events: undrained, newCursor } = journalStore().readEntriesAfterCursor(envelope.lastDrainedJournalId);

    let TX: GraphEvent[] = [];
    const CX: { cardId: string; values: Record<string, unknown> }[] = [];
    const DX: Record<string, unknown>[] = [];
    // NX: card refreshes — Map so last write per cardId wins, deduplicating rapid updates.
    const NX = new Map<string, LiveCard>();

    const taskCompletedFn = (taskName: string, data: Record<string, unknown>): void => {
      TX.push({ type: 'task-completed', taskName, data, timestamp: nowIso() } as GraphEvent);
      try { archive().stream('exec-history').append({ taskName, status: 'completed', completedAt: nowIso() }); } catch { /* best-effort */ }
    };
    const taskFailedFn = (taskName: string, error: string): void => {
      appendJournalEvent({ type: 'task-failed', taskName, error, timestamp: nowIso() });
      try { archive().stream('exec-history').append({ taskName, status: 'failed', error, completedAt: nowIso() }); } catch { /* best-effort */ }
    };
    const writeComputedValuesFn = (cardId: string, values: Record<string, unknown>): void => {
      CX.push({ cardId, values });
    };
    const writeDataObjectsFn = (data: Record<string, unknown>): void => {
      DX.push(data);
    };
    // Wire output-store notifications for this drain cycle.
    // (notifications are batched and flushed at the end of the drain cycle)

    const rg = createReactiveGraph(live, {
      handlers: {
        'card-handler': createCardHandlerFn(baseRef, newCursor, cardHandlerAdapters, taskCompletedFn, taskFailedFn, writeComputedValuesFn, writeDataObjectsFn),
      },
    });

    TX = undrained;
    while (TX.length > 0) {
      const pending = TX;
      TX = [];
      // Populate NX for task-restart events before pushing to the reactive graph.
      for (const ev of pending) {
        if (ev.type === 'task-restart') {
          const card = cardHandlerAdapters.cardStore.readCard(ev.taskName as string);
          if (card) NX.set(ev.taskName as string, card as LiveCard);
        }
      }
      rg.pushAll(pending);
      await rg.waitForHandlers();
    }

    const finalLive = rg.getState();
    await rg.dispose({ wait: true });

    const currentVersion = snapshotStore().readSnapshot(baseRef.value).version;
    commitEnvelope({ lastDrainedJournalId: newCursor, graph: snapshot(finalLive) }, currentVersion);

    // Flush deferred output writes after board state is saved
    for (const { cardId, values } of CX) cardHandlerAdapters.outputStore.writeComputedValues(cardId, values);
    for (const data of DX) cardHandlerAdapters.outputStore.writeDataObjects(data);

    // Flush RX: card runtime overlay → real store
    for (const [cardId, state] of RX) realCardRuntimeStore.writeRuntime(cardId, state);

    // Flush SX: deferred source commits → real store
    for (const { cardId, outputFile, deliveryToken } of SX) realFetchedSourcesStore.commitSourceData(cardId, outputFile, deliveryToken);

    let statusObj: unknown;
    try {
      statusObj = buildBoardStatusObject(boardPath, finalLive);
      cardHandlerAdapters.outputStore.writeStatusSnapshot(statusObj);
    } catch (e) {
      warn(`[board-live-cards-public] status publish failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Batch all drain-cycle notifications and flush them atomically in one write
    const batch: BoardChangeNotification[] = [];
    for (const { cardId, values } of CX) batch.push({ kind: 'computed_values', cardId, values });
    for (const data of DX) {
      for (const [key, payload] of Object.entries(data)) {
        if (key) batch.push({ kind: 'data_object', key, payload });
      }
    }
    for (const [cardId, card] of NX) batch.push({ kind: 'card_refreshed', cardId, card });
    if (statusObj !== undefined) batch.push({ kind: 'status', status: statusObj });
    flushBoardChangeNotifications(batch);

    const executorRef = configStore().readTaskExecutorRef()
      ?? { howToRun: 'built-in' as const, whatToRun: serializeRef({ kind: 'built-in', value: 'source-cli-task-executor' }) };

    executionRequestStore.dispatchEntriesForJournalId(newCursor, (entry) => {
      if (entry.taskKind !== 'source-fetch') {
        warn(`[process-accumulated-events] unknown taskKind "${entry.taskKind}" — skipping`);
        return;
      }
      const p = entry.payload as { boardRef: string; enrichedCard: Record<string, unknown>; callbackToken: string; rqt: string };
      const cardId = (p.enrichedCard?.id as string | undefined) ?? 'unknown';
      const sourceDefs = (p.enrichedCard?.source_defs ?? []) as Array<{ bindTo: string; outputFile?: string; [k: string]: unknown }>;

      for (const src of sourceDefs) {
        if (!src.outputFile) { warn(`[dispatch] source "${src.bindTo}" has no outputFile — skipping`); continue; }
        const sourceToken = encodeSourceToken({
          cbk: p.callbackToken, rg: baseRef.value, br: serializeRef(baseRef),
          cid: cardId, b: src.bindTo, d: src.outputFile, cs: undefined, rqt: p.rqt,
        });
        adapter.dispatchExecution(executorRef, {
          source_def: src, base_ref: serializeRef(baseRef),
          callback: { token: sourceToken, via: adapter.selfRef },
        }).catch((e: unknown) => taskFailedFn(cardId, e instanceof Error ? e.message : String(e)));
      }
    });
  }

  // ── Public methods ──────────────────────────────────────────────────────────

  // Internal drain — called directly from within the factory (no CommandInput needed).
  async function drain(): Promise<CommandResult> {
    try {
      // After each drain cycle, check if new journal entries accumulated while we
      // held the lock (e.g. concurrent upsertCard calls). If so, run another cycle.
      // This is the in-process equivalent of requestProcessAccumulated (which spawns
      // a child process for the CLI case). The self-continuation runs after the lock
      // is released, so it re-acquires cleanly.
      const continuation = () => {
        const envelope = loadEnvelope();
        const { events } = journalStore().readEntriesAfterCursor(envelope.lastDrainedJournalId);
        if (events.length <= 0) {
          return;
        }
        void drain();
        // Also fire the platform continuation (e.g. detached process for source fetches)
        adapter.requestProcessAccumulated?.();
      };
      const ran = await withRelayLock(adapter.lock, drainCycle, continuation);
      return ok({ ran: ran !== false });
    } catch (e) { return err(e); }
  }

  function drainFireAndForget(): void {
    void drain();
    adapter.requestProcessAccumulated?.();
  }

  function init(input: CommandInput): CommandResult {
    try {
      // cardStoreRef is required — create a card store with card-store-cli first
      const storeRef = input.params?.['cardStoreRef'] as string | undefined;
      if (!storeRef) return fail('init requires params.cardStoreRef — create a card store with card-store-cli and pass its ref here');
      if (!boardExists()) {
        const live = createLiveGraph(EMPTY_CONFIG);
        commitEnvelope({ lastDrainedJournalId: '', graph: snapshot(live) }, null);
      }
      const outputsStoreRef = input.params?.['outputsStoreRef'] as string | undefined;
      if (!outputsStoreRef) return fail('init requires params.outputsStoreRef — pass the outputs store ref here');
      const scratchStoreRef = input.params?.['scratchStoreRef'] as string | undefined;
      const archiveStoreRef = input.params?.['archiveStoreRef'] as string | undefined;
      const cfg = configStore();
      cfg.writeCardStoreRef(storeRef);
      cfg.writeOutputsStoreRef(outputsStoreRef);
      if (scratchStoreRef) cfg.writeScratchStoreRef(scratchStoreRef);
      if (archiveStoreRef) cfg.writeArchiveStoreRef(archiveStoreRef);
      const body = (input.body ?? {}) as Record<string, unknown>;
      if (body['task-executor-ref']) cfg.writeTaskExecutorRef(body['task-executor-ref'] as ExecutionRef);
      if (Object.prototype.hasOwnProperty.call(body, 'chat-handler-flow')) cfg.writeChatHandlerFlow(body['chat-handler-flow']);
      try { outputStore().writeStatusSnapshot(buildBoardStatusObject(boardPath, restore(loadEnvelope().graph))); } catch { /* best-effort */ }
      return ok();
    } catch (e) { return err(e); }
  }

  function status(_input: CommandInput): CommandResult<BoardStatusObject> {
    try {
      let s = outputStore().readStatusSnapshot() as BoardStatusObject | null;
      if (!s) {
        s = buildBoardStatusObject(boardPath, restore(loadEnvelope().graph));
        try { outputStore().writeStatusSnapshot(s); } catch { /* best-effort */ }
      }
      return ok(s);
    } catch (e) { return err(e) as CommandResult<BoardStatusObject>; }
  }

  function removeCard(input: CommandInput): CommandResult {
    try {
      const id = input.params?.['id'] as string | undefined;
      if (!id) return fail('removeCard requires params.id');
      appendJournalEvent({ type: 'task-removal', taskName: id, timestamp: nowIso() });
      drainFireAndForget();
      return ok();
    } catch (e) { return err(e); }
  }

  function retrigger(input: CommandInput): CommandResult {
    try {
      const id = input.params?.['id'] as string | undefined;
      if (!id) return fail('retrigger requires params.id');
      appendJournalEvent({ type: 'task-restart', taskName: id, timestamp: nowIso() });
      drainFireAndForget();
      return ok();
    } catch (e) { return err(e); }
  }

  async function processAccumulatedEvents(_input: CommandInput): Promise<CommandResult> {
    return drain();
  }

  function upsertCard(input: CommandInput): CommandResult {
    try {
      const cardId  = input.params?.['cardId']  as string | undefined;
      const all     = input.params?.['all'];
      const restart = !!input.params?.['restart'];
      if (!cardId && !all) return fail('upsertCard requires --card-id <id> or --all');

      const ids = all ? cardStore().readAllCards().map(c => c.id) : [cardId as string];

      // Validate all cards exist before writing anything (atomicity)
      for (const id of ids) {
        if (!cardStore().readCard(id)) return fail(`Card "${id}" not found in board at ${baseRef.value}`);
      }

      for (const id of ids) {
        const card = cardStore().readCard(id)!;
        const taskConfig = liveCardToTaskConfig(card);
        const taskConfigHash = adapter.hashFn(taskConfig);
        const upsertKv = adapter.kvStorage('card-upsert');
        const existing = upsertKv.read(id) as CardUpsertIndexEntry | null;
        const taskConfigChanged = existing?.taskConfigHash !== taskConfigHash;

        if (!taskConfigChanged && !restart) continue;

        if (taskConfigChanged) {
          const blobRef = existing?.blobRef ?? cardStore().readCardKey(id) ?? id;
          appendJournalEvent({ type: 'task-upsert', taskName: id, taskConfig, timestamp: nowIso() });
          upsertKv.write(id, { blobRef, taskConfigHash, updatedAt: nowIso() } satisfies CardUpsertIndexEntry);
        }
        if (restart) appendJournalEvent({ type: 'task-restart', taskName: id, timestamp: nowIso() });
      }

      drainFireAndForget();
      return ok();
    } catch (e) { return err(e); }
  }

  function taskFailed(input: CommandInput): CommandResult {
    try {
      const token = input.params?.['token'] as string | undefined;
      if (!token) return fail('taskFailed requires params.token');
      const error = (input.params?.['error'] as string | undefined) ?? 'unknown error';
      const decoded = decodeCallbackToken(token);
      if (!decoded) return fail('Invalid callback token');
      appendJournalEvent({ type: 'task-failed', taskName: decoded.taskName, error, timestamp: nowIso() });
      try { archive().stream('exec-history').append({ taskName: decoded.taskName, status: 'failed', error, completedAt: nowIso() }); } catch { /* best-effort */ }
      drainFireAndForget();
      return ok();
    } catch (e) { return err(e); }
  }

  function taskProgress(input: CommandInput): CommandResult {
    try {
      const token = input.params?.['token'] as string | undefined;
      if (!token) return fail('taskProgress requires params.token');
      const b = (input.body ?? {}) as Record<string, unknown>;
      const update = (b['update'] ?? {}) as Record<string, unknown>;
      const decoded = decodeCallbackToken(token);
      if (!decoded) return fail('Invalid callback token');
      appendJournalEvent({ type: 'task-progress', taskName: decoded.taskName, update, timestamp: nowIso() });
      drainFireAndForget();
      return ok();
    } catch (e) { return err(e); }
  }

  function sourceDataFetched(input: CommandInput): CommandResult {
    try {
      const token = input.params?.['token'] as string | undefined;
      const ref   = input.params?.['ref']   as string | undefined;
      if (!token) return fail('sourceDataFetched requires params.token');
      if (!ref)   return fail('sourceDataFetched requires params.ref');
      const payload = decodeSourceToken(token);
      if (!payload) return fail('Invalid source token');
      const { cbk, cid, b, d, cs, rqt } = payload;

      const fetchedSourcesStore = createFetchedSourcesStore(
        adapter.blobStorage('sources'),
        (ref) => adapter.resolveBlob(ref),
      );

      const deliveryToken = adapter.genId();
      fetchedSourcesStore.ingestSourceDataStaged(cid, d, parseRef(ref), deliveryToken);

      const cbkDecoded = decodeCallbackToken(cbk);
      if (!cbkDecoded) return fail('Invalid callback token embedded in source token');

      const fetchedAt = nowIso();
      appendJournalEvent({
        type: 'task-progress',
        taskName: cbkDecoded.taskName,
        update: { bindTo: b, outputFile: d, fetchedAt, deliveryToken, sourceChecksum: cs, rqt },
        timestamp: fetchedAt,
      });
      drainFireAndForget();
      return ok();
    } catch (e) { return err(e); }
  }

  function sourceDataFetchFailure(input: CommandInput): CommandResult {
    try {
      const token  = input.params?.['token']  as string | undefined;
      const reason = (input.params?.['reason'] as string | undefined) ?? 'unknown';
      if (!token) return fail('sourceDataFetchFailure requires params.token');
      const payload = decodeSourceToken(token);
      if (!payload) return fail('Invalid source token');
      const { cbk, b, d, cs, rqt } = payload;

      const cbkDecoded = decodeCallbackToken(cbk);
      if (!cbkDecoded) return fail('Invalid callback token embedded in source token');

      appendJournalEvent({
        type: 'task-progress',
        taskName: cbkDecoded.taskName,
        update: { bindTo: b, outputFile: d, failure: true, reason, sourceChecksum: cs, rqt },
        timestamp: nowIso(),
      });
      drainFireAndForget();
      return ok();
    } catch (e) { return err(e); }
  }

  function getCardStoreRef(_input: CommandInput): CommandResult<{ storeRef: string }> {
    try {
      const storeRef = configStore().readCardStoreRef();
      if (!storeRef) return fail(`Board at ${baseRef.value} has no card store configured`) as CommandResult<{ storeRef: string }>;
      return ok({ storeRef });
    } catch (e) { return err(e) as CommandResult<{ storeRef: string }>; }
  }

  function getOutputsStoreRef(_input: CommandInput): CommandResult<{ storeRef: string }> {
    try {
      const storeRef = configStore().readOutputsStoreRef();
      if (!storeRef) return fail(`Board at ${baseRef.value} has no outputs store configured`) as CommandResult<{ storeRef: string }>;
      return ok({ storeRef });
    } catch (e) { return err(e) as CommandResult<{ storeRef: string }>; }
  }

  function getScratchStoreRef(_input: CommandInput): CommandResult<{ storeRef: string | null }> {
    try {
      const storeRef = configStore().readScratchStoreRef();
      return ok({ storeRef }) as CommandResult<{ storeRef: string | null }>;
    } catch (e) { return err(e) as CommandResult<{ storeRef: string | null }>; }
  }

  function getArchiveStoreRef(_input: CommandInput): CommandResult<{ storeRef: string | null }> {
    try {
      const storeRef = configStore().readArchiveStoreRef();
      return ok({ storeRef }) as CommandResult<{ storeRef: string | null }>;
    } catch (e) { return err(e) as CommandResult<{ storeRef: string | null }>; }
  }

  function getConfig(input: CommandInput): CommandResult<{ value: unknown }> {
    try {
      const key = input.params?.['key'] as string | undefined;
      if (!key) return fail('getConfig requires params.key') as CommandResult<{ value: unknown }>;
      const cfg = configStore();
      let value: unknown;
      switch (key) {
        case 'task-executor':     value = cfg.readTaskExecutorRef() ?? null; break;
        case 'chat-handler-flow': value = cfg.readChatHandlerFlow() ?? null; break;
        case 'card-store-ref':    value = cfg.readCardStoreRef(); break;
        case 'outputs-store-ref': value = cfg.readOutputsStoreRef(); break;
        case 'scratch-store-ref': value = cfg.readScratchStoreRef(); break;
        case 'archive-store-ref': value = cfg.readArchiveStoreRef(); break;
        default: return fail(`getConfig: unknown key "${key}"`) as CommandResult<{ value: unknown }>;
      }
      return ok({ value }) as CommandResult<{ value: unknown }>;
    } catch (e) { return err(e) as CommandResult<{ value: unknown }>; }
  }

  function getOutputsDataObject(input: CommandInput): CommandResult {
    try {
      const key = input.params?.['key'] as string | undefined;
      if (!key) return fail('getOutputsDataObject requires params.key');
      const value = outputStore().readDataObject(key);
      return ok(value);
    } catch (e) { return err(e); }
  }

  function getAllOutputsDataObjects(_input: CommandInput): CommandResult<Record<string, unknown>> {
    try {
      return ok(outputStore().readAllDataObjects()) as CommandResult<Record<string, unknown>>;
    } catch (e) { return err(e) as CommandResult<Record<string, unknown>>; }
  }

  function getOutputsComputedValues(input: CommandInput): CommandResult {
    try {
      const key = input.params?.['key'] as string | undefined;
      if (!key) return fail('getOutputsComputedValues requires params.key');
      const value = outputStore().readComputedValues(key);
      return ok(value);
    } catch (e) { return err(e); }
  }

  function getAllOutputsComputedValues(_input: CommandInput): CommandResult<Record<string, unknown>> {
    try {
      return ok(outputStore().readAllComputedValues()) as CommandResult<Record<string, unknown>>;
    } catch (e) { return err(e) as CommandResult<Record<string, unknown>>; }
  }

  return {
    init, status, getCardStoreRef, getOutputsStoreRef, getScratchStoreRef, getArchiveStoreRef, getConfig,
    getOutputsDataObject, getAllOutputsDataObjects,
    getOutputsComputedValues, getAllOutputsComputedValues,
    removeCard, retrigger, processAccumulatedEvents,
    upsertCard,
    taskFailed, taskProgress,
    sourceDataFetched, sourceDataFetchFailure,
  };
}

// ============================================================================
// BoardNonCorePlatformAdapter — extends the base adapter with synchronous
// executor dispatch and schema validation.
//
// The 5 non-core commands all require blocking sub-process invocation which
// is not available in fire-and-forget async dispatch contexts (Azure Fn, etc.)
// so they live in a separate interface and factory.
// ============================================================================

export interface BoardNonCorePlatformAdapter extends BoardPlatformAdapter {
  /**
   * Synchronously invoke a task executor subcommand and return stdout.
   * Throws on non-zero exit or timeout.
   */
  invokeExecutorSync(
    ref: ExecutionRef,
    subcommand: string,
    args: string[],
    opts?: { timeout?: number; input?: string },
  ): string;

  /** Schema-only card validator (no executor invocation). */
  validateSchema(card: Record<string, unknown>): { ok: boolean; errors: string[] };

  /** Absolute-path blob I/O for resolving arbitrary KindValueRef blobs. */
  absoluteBlob: BlobStorage;

  /**
   * Default timeouts (ms) for synchronous executor invocations.
   * Each field can also be overridden per-source via source_def.timeout.
   *
   *   validationMs — validate-source-def, validate-card-preflight (structural, fast). Default: 10_000.
  *   preflightMs  — source preflight executor hooks (probe-source-preflight / run-source-preflight). Default: 60_000.
   *   probeMs      — run-source-fetch in probe/simulation paths. Default: 60_000.
   *   describeMs   — describe-capabilities introspection. Default: 10_000.
   */
  executorTimeouts?: {
    validationMs?: number;
    preflightMs?: number;
    probeMs?: number;
    describeMs?: number;
  };
}

// ============================================================================
// BoardLiveCardsNonCorePublic — 5 commands requiring synchronous dispatch
// ============================================================================

export interface BoardLiveCardsNonCorePublic {
  /** params: cardId? or all?; returns array even for single card */
  validateCard(input: CommandInput): CommandResult<Array<{ cardId: string; isValid: boolean; issues: string[] }>>;

  /** body: { "card-content": <card> } — card JSON arrives via stdin; validates schema + JSONata + provides refs + source_defs (executor, if configured) */
  validateCardPreflight(input: CommandInput): CommandResult<{ cardId: string; isValid: boolean; issues: string[] }>;

  /** params: cardId, sourceIdx, outRef?; body — mockProjections object */
  probeSource(input: CommandInput): CommandResult;

  /** body: { sourceDef, mockProjections }; params: outRef? */
  probeTmpSource(input: CommandInput): CommandResult;

  /** body: { "card-content": <card>, "mock-projections"?: {} }; params: sourceIdx, outRef? — card JSON arrives via stdin; no board state needed */
  probeSourcePreflight(input: CommandInput): CommandResult;

  /** body: { "card-content": <card>, "mock-projections"?: {} }; params: sourceIdx, outRef? — runs the real source fetch flow as a preflight */
  runSourcePreflight(input: CommandInput): CommandResult;

  /** body: { "card-content": <card>, "mock-fetched-sources"?: {}, "mock-requires"?: {} } — evaluates compute expressions with supplied data; no board state needed */
  evalCardCompute(input: CommandInput): CommandResult<{ cardId: string; ok: boolean; computed_values: Record<string, unknown>; errors: Array<{ bindTo: string; error: string }> }>;

  /** body: { "card-content": <card>, "mock-fetched-sources"?: {}, "mock-requires"?: {} } — full cycle: validate → resolve projections → probe sources → compute */
  simulateCardCycle(input: CommandInput): CommandResult;

  /** no params needed */
  describeTaskExecutorCapabilities(input: CommandInput): CommandResult;

  /**
   * Write/update cards in the configured card store.
   * body: { ops: Array<{ op: 'update', id: string, 'card-content': LiveCard }> }
   */
  updatesInCardStore(input: CommandInput): CommandResult;

  /**
   * Read cards from the configured card store by id.
   * body: { ids: string[] }
   */
  readFromCardStore(input: CommandInput): CommandResult<{ cards: Array<{ id: string; 'card-content': LiveCard | null }> }>;
}

// ============================================================================
// createBoardLiveCardsNonCorePublic — factory
// ============================================================================

export function createBoardLiveCardsNonCorePublic(
  baseRef: KindValueRef,
  adapter: BoardNonCorePlatformAdapter,
): BoardLiveCardsNonCorePublic {
  // Mirror the same internal helpers as the core factory.
  const configStore = () => createBoardConfigStore(adapter.kvStorage('config'));
  function makeCardAdapterNC(): CardStorageAdapter {
    const storeRef = configStore().readCardStoreRef();
    if (!storeRef) throw new Error(`Board at ${baseRef.value} has no card store configured. Run: init --base-ref <ref> --store-ref <b64-ref>`);
    const kv = adapter.kvStorageForRef(storeRef);
    return {
      readIndex(): CardIndex | null { return kv.read('_index') as CardIndex | null; },
      writeIndex(index: CardIndex): void { kv.write('_index', index); },
      readCard(id: string): LiveCard | null { return kv.read(id) as LiveCard | null; },
      writeCard(id: string, card: LiveCard): string { kv.write(id, card); return adapter.hashFn(card); },
      removeCard(id: string): void { kv.delete(id); },
      cardExists(id: string): boolean { return kv.read(id) !== null; },
      defaultCardKey(cardId: string): string { return cardId; },
    };
  }
  const cardStore = () => createCardStore(makeCardAdapterNC(), adapter.onWarn ?? (() => { /* no-op */ }));

  const scratchStore = () => {
    const ref = configStore().readScratchStoreRef();
    return ref ? adapter.scratchStorageForRef(ref) : adapter.scratchStorage();
  };

  // ── Shared validation helper ───────────────────────────────────────────────

  function validateCardObject(
    cardId: string,
    card: Record<string, unknown>,
  ): CommandResult<{ cardId: string; isValid: boolean; issues: string[] }> {
    const schemaResult = adapter.validateSchema(card);
    const sourceErrors: string[] = [];

    const teRef = configStore().readTaskExecutorRef();
    if (teRef && Array.isArray(card['source_defs'])) {
      for (const src of card['source_defs'] as Array<Record<string, unknown>>) {
        const bindTo = typeof src['bindTo'] === 'string' ? src['bindTo'] : '(unknown)';
        try {
          let stdout: string;
          try {
            // Pass source_def JSON via stdin; executor reads stdin, writes { ok, errors } to stdout.
            stdout = adapter.invokeExecutorSync(teRef, 'validate-source-def', [], { timeout: adapter.executorTimeouts?.validationMs ?? 10_000, input: JSON.stringify(src) });
          } catch (execErr: unknown) {
            const se = execErr as { stdout?: unknown };
            stdout = typeof se?.stdout === 'string' ? se.stdout : '';
            if (!stdout.trim()) {
              sourceErrors.push(`source "${bindTo}": executor validate-source-def failed — ${execErr instanceof Error ? execErr.message : String(execErr)}`);
              continue;
            }
          }
          const parsed = JSON.parse(stdout.trim()) as { ok?: boolean; errors?: string[] };
          if (!parsed.ok && Array.isArray(parsed.errors)) {
            for (const e of parsed.errors) sourceErrors.push(`source "${bindTo}": ${e}`);
          }
        } catch (e) {
          sourceErrors.push(`source "${bindTo}": executor validate-source-def failed — ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    const allErrors = [...schemaResult.errors, ...sourceErrors];
    return ok({ cardId, isValid: allErrors.length === 0, issues: allErrors }) as CommandResult<{ cardId: string; isValid: boolean; issues: string[] }>;
  }

  // ── Shared probe helper ────────────────────────────────────────────────────

  function executeSourceProbe(
    src: Record<string, unknown>,
    mockProjections: Record<string, unknown>,
  ): { bindTo: string; result: string } {
    const teRef = configStore().readTaskExecutorRef();
    if (!teRef) throw new Error('No task-executor registered for this board');

    const bindTo = typeof src['bindTo'] === 'string' ? src['bindTo'] : 'source';
    const scratch = scratchStore();

    const inPayload: Record<string, unknown> = {
      ...src,
      boardDir: baseRef.value,
      _projections: mockProjections,
    };

    const inFile  = scratch.create(JSON.stringify(inPayload, null, 2), `probe-in-${bindTo}`, '.json');
    const outFile = scratch.getUniqueKey(`probe-out-${bindTo}`, '.json');
    const errFile = scratch.getUniqueKey(`probe-err-${bindTo}`, '.txt');

    const inRefStr  = serializeRef(scratch.keyRef(inFile));
    const outRefStr = serializeRef(scratch.keyRef(outFile));
    const errRefStr = serializeRef(scratch.keyRef(errFile));

    let result: string | null = null;
    try {
      adapter.invokeExecutorSync(teRef, 'run-source-fetch',
        ['--in-ref', inRefStr, '--out-ref', outRefStr, '--err-ref', errRefStr],
        { timeout: (src['timeout'] as number | undefined) ?? adapter.executorTimeouts?.probeMs ?? 60_000 },
      );
      result = scratch.read(outFile);
      if (result === null) throw new Error('Executor produced no output file');
    } catch (e) {
      const errMsg = scratch.read(errFile)?.trim()
        ?? (e instanceof Error ? e.message : String(e));
      throw new Error(`Probe failed: ${errMsg}`);
    } finally {
      try { scratch.remove(inFile); } catch { /* best-effort */ }
      try { scratch.remove(errFile); } catch { /* best-effort */ }
    }

    return { bindTo, result };
  }

  function runSourceProbe(
    src: Record<string, unknown>,
    mockProjections: Record<string, unknown>,
    outRef?: string,
  ): CommandResult {
    let executed: { bindTo: string; result: string };
    try {
      executed = executeSourceProbe(src, mockProjections);
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e));
    }

    if (outRef) {
      const parsed = parseRef(outRef);
      adapter.absoluteBlob.write(parsed.value, executed.result);
    }

    return ok({ bindTo: executed.bindTo, resultSizeBytes: executed.result.length });
  }

  function resolvePreflightSource(
    input: CommandInput,
    methodName: string,
  ): { src: Record<string, unknown>; bindTo: string; outRef?: string; mockProjections: Record<string, unknown> } | CommandResult {
    const sourceIdx = input.params?.['sourceIdx'] as number | undefined;
    const outRef = input.params?.['outRef'] as string | undefined;
    if (sourceIdx === undefined) return fail(`${methodName} requires params.sourceIdx`);
    if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
      return fail(`${methodName} requires card JSON object in body`);
    }
    const body = input.body as Record<string, unknown>;
    const card = (body['card-content'] ?? body) as Record<string, unknown>;
    const mockProjections = (body['mock-projections'] ?? {}) as Record<string, unknown>;
    const sourceDefs = (card['source_defs'] ?? []) as Array<Record<string, unknown>>;
    if (sourceIdx < 0 || sourceIdx >= sourceDefs.length) {
      return fail(`sourceIdx ${sourceIdx} out of range (card has ${sourceDefs.length} source(s))`);
    }
    const src = sourceDefs[sourceIdx];
    const bindTo = typeof src['bindTo'] === 'string' ? src['bindTo'] : 'source';
    return { src, bindTo, outRef, mockProjections };
  }

  // ── Public methods ─────────────────────────────────────────────────────────

  function validateCard(input: CommandInput): CommandResult<Array<{ cardId: string; isValid: boolean; issues: string[] }>> {
    try {
      const cardId = input.params?.['cardId'] as string | undefined;
      const all    = input.params?.['all'];
      if (!cardId && !all) return fail('validateCard requires --card-id <id> or --all') as CommandResult<Array<{ cardId: string; isValid: boolean; issues: string[] }>>;
      const ids = all ? cardStore().readAllCards().map(c => c.id) : [cardId as string];
      const results: Array<{ cardId: string; isValid: boolean; issues: string[] }> = [];
      for (const id of ids) {
        const card = cardStore().readCard(id);
        if (!card) { results.push({ cardId: id, isValid: false, issues: [`Card "${id}" not found`] }); continue; }
        const r = validateCardObject(id, card as Record<string, unknown>);
        if (r.status !== 'success') return r as unknown as CommandResult<Array<{ cardId: string; isValid: boolean; issues: string[] }>>;
        results.push(r.data!);
      }
      return ok(results) as CommandResult<Array<{ cardId: string; isValid: boolean; issues: string[] }>>;
    } catch (e) { return err(e) as CommandResult<Array<{ cardId: string; isValid: boolean; issues: string[] }>>; }
  }

  function validateCardPreflight(input: CommandInput): CommandResult<{ cardId: string; isValid: boolean; issues: string[] }> {
    try {
      if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
        return fail('validateCardPreflight requires card JSON object in body') as CommandResult<{ cardId: string; isValid: boolean; issues: string[] }>;
      }
      const body = input.body as Record<string, unknown>;
      const card = (body['card-content'] ?? body) as Record<string, unknown>;
      const cardId = typeof card['id'] === 'string' ? card['id'] : '(unknown)';

      // Structural validation (always runs inline).
      const structResult = validateCardObject(cardId, card);

      // Pluggable executor hook: if a task-executor is registered and supports
      // validate-card-preflight, call it and merge any additional issues.
      const teRef = configStore().readTaskExecutorRef();
      if (teRef) {
        try {
          const stdout = adapter.invokeExecutorSync(teRef, 'validate-card-preflight', [],
            { timeout: adapter.executorTimeouts?.validationMs ?? 10_000, input: JSON.stringify(card) });
          const execResult = JSON.parse(stdout.trim()) as { ok: boolean; errors: string[] };
          if (!execResult.ok && Array.isArray(execResult.errors) && execResult.errors.length > 0) {
            const mergedIssues = [
              ...(structResult.status === 'success' ? structResult.data.issues : []),
              ...execResult.errors,
            ];
            return ok({ cardId, isValid: false, issues: mergedIssues }) as CommandResult<{ cardId: string; isValid: boolean; issues: string[] }>;
          }
        } catch { /* executor doesn't support subcommand or isn't available — use structural result */ }
      }

      return structResult;
    } catch (e) { return err(e) as CommandResult<{ cardId: string; isValid: boolean; issues: string[] }>; }
  }

  function probeSource(input: CommandInput): CommandResult {
    try {
      const cardId    = input.params?.['cardId']    as string | undefined;
      const sourceIdx = input.params?.['sourceIdx'] as number | undefined;
      const outRef    = input.params?.['outRef']    as string | undefined;
      if (!cardId) return fail('probeSource requires params.cardId');
      if (sourceIdx === undefined) return fail('probeSource requires params.sourceIdx');
      const b = (input.body ?? {}) as Record<string, unknown>;
      const mockProjections = (b['mock-projections'] ?? {}) as Record<string, unknown>;

      const card = cardStore().readCard(cardId) as Record<string, unknown> | null;
      if (!card) return fail(`Card "${cardId}" not found`);
      const sourceDefs = (card['source_defs'] ?? []) as Array<Record<string, unknown>>;
      if (sourceIdx < 0 || sourceIdx >= sourceDefs.length) {
        return fail(`sourceIdx ${sourceIdx} out of range (card has ${sourceDefs.length} source(s))`);
      }
      return runSourceProbe(sourceDefs[sourceIdx], mockProjections, outRef);
    } catch (e) { return err(e); }
  }

  function probeTmpSource(input: CommandInput): CommandResult {
    try {
      const outRef = input.params?.['outRef'] as string | undefined;
      const b = input.body as Record<string, unknown> | undefined;
      if (!b) return fail('probeTmpSource requires body with "source-def" and "mock-projections"');
      const sourceDef = b['source-def'] as Record<string, unknown> | undefined;
      const mockProjections = (b['mock-projections'] ?? {}) as Record<string, unknown>;
      if (!sourceDef) return fail('probeTmpSource body requires "source-def"');
      return runSourceProbe(sourceDef, mockProjections, outRef);
    } catch (e) { return err(e); }
  }

  function probeSourcePreflight(input: CommandInput): CommandResult {
    try {
      const resolved = resolvePreflightSource(input, 'probeSourcePreflight');
      if ('status' in resolved) return resolved;

      // Lightweight probe only. Do not silently degrade into a real fetch path.
      const teRef = configStore().readTaskExecutorRef();
      if (!teRef) return fail('No task-executor registered for this board');
      try {
        const inPayload = { ...resolved.src, _projections: resolved.mockProjections };
        const stdout = adapter.invokeExecutorSync(teRef, 'probe-source-preflight', [],
          { timeout: (resolved.src['timeout'] as number | undefined) ?? adapter.executorTimeouts?.preflightMs ?? 60_000, input: JSON.stringify(inPayload) });
        const result = JSON.parse(stdout.trim()) as { ok: boolean; reachable: boolean; latencyMs?: number; error?: string; note?: string };
        if (!result.ok) return fail(result.error ?? 'Preflight probe failed');
        return ok({ bindTo: resolved.bindTo, reachable: result.reachable, latencyMs: result.latencyMs, note: result.note });
      } catch {
        return fail('Executor does not support probe-source-preflight');
      }
    } catch (e) { return err(e); }
  }

  function runSourcePreflight(input: CommandInput): CommandResult {
    try {
      const resolved = resolvePreflightSource(input, 'runSourcePreflight');
      if ('status' in resolved) return resolved;

      const teRef = configStore().readTaskExecutorRef();
      if (teRef) {
        try {
          const inPayload = { ...resolved.src, _projections: resolved.mockProjections };
          const stdout = adapter.invokeExecutorSync(teRef, 'run-source-preflight', [],
            { timeout: (resolved.src['timeout'] as number | undefined) ?? adapter.executorTimeouts?.preflightMs ?? 60_000, input: JSON.stringify(inPayload) });
          const result = JSON.parse(stdout.trim()) as {
            ok: boolean;
            reachable: boolean;
            latencyMs?: number;
            bindTo?: string;
            kind?: string;
            resultValue?: unknown;
            note?: string;
            error?: string;
          };
          if (!result.ok) return fail(result.error ?? 'Source preflight failed');
          return ok({
            bindTo: result.bindTo ?? resolved.bindTo,
            reachable: result.reachable,
            latencyMs: result.latencyMs,
            kind: result.kind,
            resultValue: result.resultValue,
            note: result.note,
          });
        } catch {
          /* executor doesn't support run-source-preflight — fall back to real fetch execution */
        }
      }

      const startedAt = Date.now();
      const executed = executeSourceProbe(resolved.src, resolved.mockProjections);
      if (resolved.outRef) {
        const parsed = parseRef(resolved.outRef);
        adapter.absoluteBlob.write(parsed.value, executed.result);
      }

      let resultValue: unknown = executed.result;
      try { resultValue = JSON.parse(executed.result); } catch { /* keep raw string result */ }

      return ok({
        bindTo: executed.bindTo,
        reachable: true,
        latencyMs: Date.now() - startedAt,
        resultValue,
        note: 'Actual fetch preflight passed',
      });
    } catch (e) { return err(e); }
  }

  function describeTaskExecutorCapabilities(_input: CommandInput): CommandResult {
    try {
      const teRef = configStore().readTaskExecutorRef();
      if (!teRef) return fail('No task-executor registered for this board');
      const stdout = adapter.invokeExecutorSync(teRef, 'describe-capabilities', [], { timeout: adapter.executorTimeouts?.describeMs ?? 10_000 });
      return ok(JSON.parse(stdout.trim()) as Record<string, unknown>);
    } catch (e) { return err(e); }
  }

  function updatesInCardStore(input: CommandInput): CommandResult {
    try {
      const b = input.body as Record<string, unknown> | undefined;
      if (!b || !Array.isArray(b['ops'])) return fail('updatesInCardStore requires body.ops array');
      const ops = b['ops'] as Array<Record<string, unknown>>;
      const store = cardStore();
      for (const op of ops) {
        const opType = op['op'] as string | undefined;
        const id = op['id'] as string | undefined;
        if (!id) return fail('op is missing "id"');
        if (opType === 'update') {
          const cardContent = op['card-content'] as LiveCard | undefined;
          if (!cardContent) return fail(`update op for "${id}" is missing "card-content"`);
          store.writeCard(id, cardContent);
        } else {
          return fail(`Unknown op type: "${opType ?? '(none)'}"`);
        }
      }
      return ok();
    } catch (e) { return err(e); }
  }

  function readFromCardStore(input: CommandInput): CommandResult<{ cards: Array<{ id: string; 'card-content': LiveCard | null }> }> {
    try {
      const b = input.body as Record<string, unknown> | undefined;
      if (!b || !Array.isArray(b['ids'])) {
        return fail('readFromCardStore requires body.ids array') as CommandResult<{ cards: Array<{ id: string; 'card-content': LiveCard | null }> }>;
      }
      const ids = b['ids'] as string[];
      const store = cardStore();
      const cards = ids.map(id => ({ id, 'card-content': store.readCard(id) }));
      return ok({ cards }) as CommandResult<{ cards: Array<{ id: string; 'card-content': LiveCard | null }> }>;
    } catch (e) { return err(e) as CommandResult<{ cards: Array<{ id: string; 'card-content': LiveCard | null }> }>; }
  }

  type EvalComputeResult = { cardId: string; ok: boolean; computed_values: Record<string, unknown>; errors: Array<{ bindTo: string; error: string }> };

  function evalCardCompute(input: CommandInput): CommandResult<EvalComputeResult> {
    try {
      if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
        return fail('evalCardCompute requires a JSON object in body') as CommandResult<EvalComputeResult>;
      }
      const body = input.body as Record<string, unknown>;
      const card = (body['card-content'] ?? body) as Record<string, unknown>;
      const cardId = typeof card['id'] === 'string' ? card['id'] : '(unknown)';
      const mockFetchedSources = (body['mock-fetched-sources'] ?? {}) as Record<string, unknown>;
      const mockRequires = (body['mock-requires'] ?? {}) as Record<string, unknown>;

      const computeSteps = card['compute'] as Array<{ bindTo: string; expr: string }> | undefined;
      if (!computeSteps || !Array.isArray(computeSteps) || computeSteps.length === 0) {
        return ok({ cardId, ok: true, computed_values: {}, errors: [] }) as CommandResult<EvalComputeResult>;
      }

      const node: ComputeNode = {
        id: cardId,
        card_data: (card['card_data'] ?? {}) as Record<string, unknown>,
        requires: mockRequires,
        source_defs: card['source_defs'] as ComputeNode['source_defs'],
        compute: computeSteps,
      };

      const result = CardCompute.runSync(node, { sourcesData: mockFetchedSources });
      const computed = result.node.computed_values ?? {};
      const errors = result.errors ?? [];
      return ok({ cardId, ok: errors.length === 0, computed_values: computed, errors }) as CommandResult<EvalComputeResult>;
    } catch (e) { return err(e) as CommandResult<EvalComputeResult>; }
  }

  // ---------------------------------------------------------------------------
  // simulateCardCycle — full pipeline simulation with mock data
  //
  // 1. Structural validation (validateCardObject)
  // 2. Resolve projections from card_data + mock-requires via enrichSourcesSync
  // 3. Probe each source (probeSourcePreflight with resolved projections)
  // 4. Run compute expressions with mock-fetched-sources via CardCompute.runSync
  // ---------------------------------------------------------------------------
  type SimulateResult = {
    cardId: string;
    ok: boolean;
    validation: { isValid: boolean; issues: string[] };
    source_probes: Array<{ bindTo: string; reachable?: boolean; latencyMs?: number; error?: string; skipped?: boolean }>;
    projection_errors: Array<{ bindTo: string; key: string; error: string }>;
    computed_values: Record<string, unknown>;
    compute_errors: Array<{ bindTo: string; error: string }>;
  };

  function simulateCardCycle(input: CommandInput): CommandResult<SimulateResult> {
    try {
      if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
        return fail('simulateCardCycle requires a JSON object in body') as CommandResult<SimulateResult>;
      }
      const body = input.body as Record<string, unknown>;
      const card = (body['card-content'] ?? body) as Record<string, unknown>;
      const cardId = typeof card['id'] === 'string' ? card['id'] : '(unknown)';
      const mockFetchedSources = (body['mock-fetched-sources'] ?? {}) as Record<string, unknown>;
      const mockRequires = (body['mock-requires'] ?? {}) as Record<string, unknown>;

      // 1. Structural validation
      const structResult = validateCardObject(cardId, card);
      const validation = structResult.status === 'success'
        ? { isValid: structResult.data.isValid, issues: structResult.data.issues }
        : { isValid: false, issues: [structResult.status === 'fail' ? structResult.error : 'internal error'] };

      // 2. Resolve projections via enrichSourcesSync
      const sourceDefs = (card['source_defs'] ?? []) as Array<Record<string, unknown>>;
      const cardData = (card['card_data'] ?? {}) as Record<string, unknown>;
      let enrichedSources: Array<Record<string, unknown>> = [];
      const projectionErrors: Array<{ bindTo: string; key: string; error: string }> = [];
      if (sourceDefs.length > 0) {
        enrichedSources = CardCompute.enrichSourcesSync(
          sourceDefs as any,
          { card_data: cardData, requires: mockRequires },
        );
        // Detect projection resolution failures (undefined values for declared projections)
        for (const src of enrichedSources) {
          const projections = src['projections'] as Record<string, string> | undefined;
          const resolved = src['_projections'] as Record<string, unknown> | undefined;
          if (projections && resolved) {
            for (const key of Object.keys(projections)) {
              if (resolved[key] === undefined) {
                const bindTo = typeof src['bindTo'] === 'string' ? src['bindTo'] : '(unknown)';
                projectionErrors.push({ bindTo, key, error: `Projection "${key}" resolved to undefined` });
              }
            }
          }
        }
      }

      // 3. Run each source through the real preflight executor hook when available.
      //    Resolved from (in priority order):
      //      a) body['task-executor-ref']  — passed inline by the caller
      //      b) configStore()              — written when --base-ref points at an
      //                                     initialised board runtime directory
      //    If no executor is available, probes are marked as skipped.
      const sourceProbes: SimulateResult['source_probes'] = [];
      const bodyTeRef = body['task-executor-ref'] as ExecutionRef | undefined;
      const teRef = (bodyTeRef?.howToRun && bodyTeRef?.whatToRun ? bodyTeRef : undefined)
        ?? configStore().readTaskExecutorRef();
      for (let i = 0; i < enrichedSources.length; i++) {
        const src = enrichedSources[i];
        const bindTo = typeof src['bindTo'] === 'string' ? src['bindTo'] : `source_${i}`;
        if (!teRef) {
          sourceProbes.push({ bindTo, skipped: true, error: 'No task executor configured' });
          continue;
        }
        try {
          const inPayload = { ...src };
          const stdout = adapter.invokeExecutorSync(teRef!, 'run-source-preflight', [],
            { timeout: (src['timeout'] as number | undefined) ?? adapter.executorTimeouts?.preflightMs ?? 60_000, input: JSON.stringify(inPayload) });
          const result = JSON.parse(stdout.trim()) as { ok: boolean; reachable: boolean; latencyMs?: number; error?: string };
          sourceProbes.push({ bindTo, reachable: result.reachable, latencyMs: result.latencyMs, error: result.ok ? undefined : result.error });
        } catch {
          sourceProbes.push({ bindTo, skipped: true, error: 'Executor does not support run-source-preflight' });
        }
      }

      // 4. Run compute expressions
      const computeSteps = card['compute'] as Array<{ bindTo: string; expr: string }> | undefined;
      let computedValues: Record<string, unknown> = {};
      let computeErrors: Array<{ bindTo: string; error: string }> = [];
      if (computeSteps && Array.isArray(computeSteps) && computeSteps.length > 0) {
        const node: ComputeNode = {
          id: cardId,
          card_data: cardData,
          requires: mockRequires,
          source_defs: card['source_defs'] as ComputeNode['source_defs'],
          compute: computeSteps,
        };
        const result = CardCompute.runSync(node, { sourcesData: mockFetchedSources });
        computedValues = result.node.computed_values ?? {};
        computeErrors = result.errors ?? [];
      }

      const allOk = validation.isValid
        && projectionErrors.length === 0
        && computeErrors.length === 0
        && sourceProbes.every(p => p.reachable !== false);

      return ok({
        cardId,
        ok: allOk,
        validation,
        source_probes: sourceProbes,
        projection_errors: projectionErrors,
        computed_values: computedValues,
        compute_errors: computeErrors,
      }) as CommandResult<SimulateResult>;
    } catch (e) { return err(e) as CommandResult<SimulateResult>; }
  }

  return {
    validateCard, validateCardPreflight,
    probeSource, probeTmpSource, probeSourcePreflight, runSourcePreflight,
    evalCardCompute,
    simulateCardCycle,
    describeTaskExecutorCapabilities,
    updatesInCardStore,
    readFromCardStore,
  };
}
