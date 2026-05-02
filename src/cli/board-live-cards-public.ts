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

import { createHash } from 'node:crypto';
import type { KVStorage, BlobStorage, KindValueRef, AtomicRelayLock } from './storage-interface.js';
import { withRelayLock, serializeRef, parseRef } from './storage-interface.js';
import type { ExecutionRef } from './execution-interface.js';
import { restore, createLiveGraph, snapshot } from '../continuous-event-graph/core.js';
import { createReactiveGraph } from '../continuous-event-graph/reactive.js';
import type { GraphEvent } from '../event-graph/types.js';
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
  CardIndex,
  StateSnapshotReadView,
  CardUpsertIndexEntry,
  ExecutionRequestEntry,
  BoardEnvelope,
  SourceTokenPayload,
  BoardStatusObject,
  LiveCard,
} from './board-live-cards-lib.js';

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
   *   'cards'              — card index + card content (CardStorageAdapter, built internally)
   *   'state-snapshot'     — board graph snapshot (StateSnapshotStorageAdapter, built internally)
   *   'config'             — board configuration (.task-executor, .chat-handler)
   *   'card-upsert'        — card upsert dedup index
   *   'execution-requests' — queued execution requests (keyed by journalId)
   *   'card-runtime'       — card runtime state snapshots
   *   'output'             — published board status + card computed outputs
   */
  kvStorage(namespace: string): KVStorage;

  /**
   * Blob storage factory — scoped by namespace.
   * Namespaces used by the public layer:
   *   'sources' — fetched source data files (keyed by cardId/outputFile)
   *   ''        — root-scoped blob access (for resolving arbitrary KindValueRef blobs)
   */
  blobStorage(namespace: string): BlobStorage;

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
   *   Node/FS:  { howToRun: 'local-node', whatToRun: '::fs-path::/path/to/cli.js' }
   *   Azure Fn: { howToRun: 'http:post',  whatToRun: '::http-url::https://…/api/board' }
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
  // params: taskExecutor?, chatHandler?
  init(input: CommandInput): CommandResult;
  // no params needed
  status(input: CommandInput): CommandResult<BoardStatusObject>;
  // params: id
  removeCard(input: CommandInput): CommandResult;
  // params: id
  retrigger(input: CommandInput): CommandResult;
  // no params needed
  processAccumulatedEvents(input: CommandInput): Promise<CommandResult>;

  // Card management — params: cardId, restart?
  upsertCard(input: CommandInput): CommandResult;

  // Task callbacks — params.token encodes baseRef; body = task data payload
  taskCompleted(input: CommandInput): CommandResult;
  // params: token, error?
  taskFailed(input: CommandInput): CommandResult;
  // params: token; body = update payload
  taskProgress(input: CommandInput): CommandResult;

  // Source callbacks — params: token, ref | token, reason?
  sourceDataFetched(input: CommandInput): CommandResult;
  sourceDataFetchFailure(input: CommandInput): CommandResult;
}

// ============================================================================
// Internal pure helpers — no platform deps
// ============================================================================

function stableJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${(value as unknown[]).map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map(k => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function decodeCallbackToken(token: string): { taskName: string } | null {
  try {
    const p = JSON.parse(Buffer.from(token, 'base64url').toString());
    return typeof p?.t === 'string' ? { taskName: p.t } : null;
  } catch { return null; }
}

function encodeSourceToken(payload: SourceTokenPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

function decodeSourceToken(token: string): SourceTokenPayload | null {
  try {
    const p = JSON.parse(Buffer.from(token, 'base64url').toString());
    if (typeof p?.cbk === 'string' && typeof p?.cid === 'string' &&
        typeof p?.b === 'string' && typeof p?.d === 'string') return p as SourceTokenPayload;
    return null;
  } catch { return null; }
}

function genId(): string {
  return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 32);
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

  // ── Inline storage adapters built from the three primitives ─────────────────
  //
  // Both CardStorageAdapter and StateSnapshotStorageAdapter are pure KV
  // compositions — no platform-specific atomicity needed at this layer.
  // The public layer builds them here so BoardPlatformAdapter stays minimal.

  function makeCardAdapter(): CardStorageAdapter {
    const kv = adapter.kvStorage('cards');
    return {
      readIndex: () => kv.read('_index') as CardIndex | null,
      writeIndex: (index: CardIndex) => kv.write('_index', index),
      readCard: (key) => kv.read(key) as LiveCard | null,
      writeCard: (key, card) => { kv.write(key, card); return stableHash(card); },
      cardExists: (key) => kv.read(key) !== null,
      defaultCardKey: (cardId) => cardId,
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
      return { version: stableHash(values), values };
    },
    writeValues(_scopeId: string, nextValues: Record<string, unknown>, deletedKeys: string[]): string {
      const kv = adapter.kvStorage('state-snapshot');
      for (const key of deletedKeys) kv.delete(key);
      for (const [key, value] of Object.entries(nextValues)) kv.write(key, value);
      return stableHash(nextValues);
    },
  };

  // Store factory helpers — no long-lived singletons, created per call
  const configStore = () => createBoardConfigStore(adapter.kvStorage('config'));
  const snapshotStore = () => createStateSnapshotStore(snapshotAdapterImpl);
  const journalStore = () => createJournalStore(adapter.journalAdapter());
  const cardStore = () => createCardStore(makeCardAdapter(), warn);
  const outputStore = () => createPublishedOutputsStore(adapter.kvStorage('output'));

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
      commitId: genId(),
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

    const cardHandlerAdapters = {
      cardStore: cardStore(),
      cardRuntimeStore: createCardRuntimeStore(adapter.kvStorage('card-runtime')),
      fetchedSourcesStore: createFetchedSourcesStore(
        adapter.blobStorage('sources'),
        (ref) => {
          const content = adapter.blobStorage('').read(ref.value);
          if (content === null) throw new Error(`resolveBlobRef: not found: ::${ref.kind}::${ref.value}`);
          return content;
        },
      ),
      outputStore: outputStore(),
      executionRequestStore,
    };

    const envelope = loadEnvelope();
    const live = restore(envelope.graph);
    const { events: undrained, newCursor } = journalStore().readEntriesAfterCursor(envelope.lastDrainedJournalId);

    const taskCompletedFn = (taskName: string, data: Record<string, unknown>): void =>
      appendJournalEvent({ type: 'task-completed', taskName, data, timestamp: nowIso() });
    const taskFailedFn = (taskName: string, error: string): void =>
      appendJournalEvent({ type: 'task-failed', taskName, error, timestamp: nowIso() });

    const rg = createReactiveGraph(live, {
      handlers: {
        'card-handler': createCardHandlerFn(baseRef, newCursor, cardHandlerAdapters, taskCompletedFn, taskFailedFn),
      },
    });

    rg.pushAll(undrained);
    await rg.dispose({ wait: true });

    const currentVersion = snapshotStore().readSnapshot(baseRef.value).version;
    commitEnvelope({ lastDrainedJournalId: newCursor, graph: rg.snapshot() }, currentVersion);

    try {
      cardHandlerAdapters.outputStore.writeStatusSnapshot(
        buildBoardStatusObject(boardPath, restore(rg.snapshot())),
      );
    } catch (e) {
      warn(`[board-live-cards-public] status publish failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    const executorRef = configStore().readTaskExecutorRef()
      ?? { howToRun: 'built-in' as const, whatToRun: '::built-in::source-cli-task-executor' };

    executionRequestStore.dispatchEntriesForJournalId(newCursor, (entry) => {
      if (entry.taskKind !== 'source-fetch') {
        warn(`[process-accumulated-events] unknown taskKind "${entry.taskKind}" — skipping`);
        return;
      }
      const p = entry.payload as { boardRef: string; enrichedCard: Record<string, unknown>; callbackToken: string };
      const cardId = (p.enrichedCard?.id as string | undefined) ?? 'unknown';
      const sourceDefs = (p.enrichedCard?.source_defs ?? []) as Array<{ bindTo: string; outputFile?: string; [k: string]: unknown }>;

      for (const src of sourceDefs) {
        if (!src.outputFile) { warn(`[dispatch] source "${src.bindTo}" has no outputFile — skipping`); continue; }
        const sourceToken = encodeSourceToken({
          cbk: p.callbackToken, rg: baseRef.value, br: serializeRef(baseRef),
          cid: cardId, b: src.bindTo, d: src.outputFile, cs: undefined,
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
      const ran = await withRelayLock(adapter.lock, drainCycle);
      return ok({ ran: ran !== false });
    } catch (e) { return err(e); }
  }

  function init(input: CommandInput): CommandResult {
    try {
      const taskExecutor = input.params?.['taskExecutor'] as string | undefined;
      const chatHandler  = input.params?.['chatHandler']  as string | undefined;
      if (!boardExists()) {
        const live = createLiveGraph(EMPTY_CONFIG);
        commitEnvelope({ lastDrainedJournalId: '', graph: snapshot(live) }, null);
      }
      const cfg = configStore();
      if (taskExecutor) cfg.writeTaskExecutorRef({ howToRun: 'local-node', whatToRun: `::fs-path::${taskExecutor}` });
      if (chatHandler) cfg.writeChatHandler(chatHandler);
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
      void drain();
      return ok();
    } catch (e) { return err(e); }
  }

  function retrigger(input: CommandInput): CommandResult {
    try {
      const id = input.params?.['id'] as string | undefined;
      if (!id) return fail('retrigger requires params.id');
      appendJournalEvent({ type: 'task-restart', taskName: id, timestamp: nowIso() });
      void drain();
      return ok();
    } catch (e) { return err(e); }
  }

  async function processAccumulatedEvents(_input: CommandInput): Promise<CommandResult> {
    return drain();
  }

  function upsertCard(input: CommandInput): CommandResult {
    try {
      const cardId  = input.params?.['cardId']  as string | undefined;
      const restart = !!input.params?.['restart'];
      if (!cardId) return fail('upsertCard requires params.cardId');

      const card = cardStore().readCard(cardId);
      if (!card) return fail(`Card "${cardId}" not found in board at ${baseRef.value}`);

      const taskConfig = liveCardToTaskConfig(card);
      const taskConfigHash = stableHash(taskConfig);
      const upsertKv = adapter.kvStorage('card-upsert');
      const existing = upsertKv.read(cardId) as CardUpsertIndexEntry | null;
      const taskConfigChanged = existing?.taskConfigHash !== taskConfigHash;

      if (!taskConfigChanged && !restart) return ok({ message: `Card "${cardId}" unchanged — skipped.` });

      if (taskConfigChanged) {
        const blobRef = existing?.blobRef ?? cardStore().readCardKey(cardId) ?? cardId;
        appendJournalEvent({ type: 'task-upsert', taskName: cardId, taskConfig, timestamp: nowIso() });
        upsertKv.write(cardId, { blobRef, taskConfigHash, updatedAt: nowIso() } satisfies CardUpsertIndexEntry);
      }
      if (restart) appendJournalEvent({ type: 'task-restart', taskName: cardId, timestamp: nowIso() });

      void drain();
      return ok({ message: `Card "${cardId}" ${existing ? 'updated' : 'inserted'}${restart ? ' (restarted)' : ''}.` });
    } catch (e) { return err(e); }
  }

  function taskCompleted(input: CommandInput): CommandResult {
    try {
      const token = input.params?.['token'] as string | undefined;
      if (!token) return fail('taskCompleted requires params.token');
      const data = (input.body ?? {}) as Record<string, unknown>;
      const decoded = decodeCallbackToken(token);
      if (!decoded) return fail('Invalid callback token');
      try { outputStore().writeDataObjects(data); } catch { /* best-effort */ }
      appendJournalEvent({ type: 'task-completed', taskName: decoded.taskName, data, timestamp: nowIso() });
      void drain();
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
      void drain();
      return ok();
    } catch (e) { return err(e); }
  }

  function taskProgress(input: CommandInput): CommandResult {
    try {
      const token = input.params?.['token'] as string | undefined;
      if (!token) return fail('taskProgress requires params.token');
      const update = (input.body ?? {}) as Record<string, unknown>;
      const decoded = decodeCallbackToken(token);
      if (!decoded) return fail('Invalid callback token');
      appendJournalEvent({ type: 'task-progress', taskName: decoded.taskName, update, timestamp: nowIso() });
      void drain();
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
      const { cbk, cid, b, d, cs } = payload;

      const fetchedSourcesStore = createFetchedSourcesStore(
        adapter.blobStorage('sources'),
        (r) => {
          const content = adapter.blobStorage('').read(r.value);
          if (content === null) throw new Error(`resolveBlobRef: not found: ::${r.kind}::${r.value}`);
          return content;
        },
      );

      const deliveryToken = genId();
      fetchedSourcesStore.ingestSourceDataStaged(cid, d, parseRef(ref), deliveryToken);

      const cbkDecoded = decodeCallbackToken(cbk);
      if (!cbkDecoded) return fail('Invalid callback token embedded in source token');

      const fetchedAt = nowIso();
      appendJournalEvent({
        type: 'task-progress',
        taskName: cbkDecoded.taskName,
        update: { bindTo: b, outputFile: d, fetchedAt, deliveryToken, sourceChecksum: cs },
        timestamp: fetchedAt,
      });
      void drain();
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
      const { cbk, b, d, cs } = payload;

      const cbkDecoded = decodeCallbackToken(cbk);
      if (!cbkDecoded) return fail('Invalid callback token embedded in source token');

      appendJournalEvent({
        type: 'task-progress',
        taskName: cbkDecoded.taskName,
        update: { bindTo: b, outputFile: d, failure: true, reason, sourceChecksum: cs },
        timestamp: nowIso(),
      });
      void drain();
      return ok();
    } catch (e) { return err(e); }
  }

  return {
    init, status, removeCard, retrigger, processAccumulatedEvents,
    upsertCard,
    taskCompleted, taskFailed, taskProgress,
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
    opts?: { timeout?: number },
  ): string;

  /** Schema-only card validator (no executor invocation). */
  validateSchema(card: Record<string, unknown>): { ok: boolean; errors: string[] };

  /** Create a temp file path for I/O staging — absolute, board-scoped. */
  makeTempFilePath(label: string, ext?: string): string;

  /** Absolute-path blob I/O for temp files and card file references. */
  absoluteBlob: BlobStorage;
}

// ============================================================================
// BoardLiveCardsNonCorePublic — 5 commands requiring synchronous dispatch
// ============================================================================

export interface BoardLiveCardsNonCorePublic {
  /** params.cardId — card already in the board */
  validateCard(input: CommandInput): CommandResult<{ cardId: string; errors: string[] }>;

  /** body — card JSON object (arrives via stdin / HTTP body / in-process) */
  validateTmpCard(input: CommandInput): CommandResult<{ cardId: string; errors: string[] }>;

  /** params: cardId, sourceIdx, outRef?; body — mockProjections object */
  probeSource(input: CommandInput): CommandResult;

  /** body: { sourceDef, mockProjections }; params: outRef? */
  probeTmpSource(input: CommandInput): CommandResult;

  /** no params needed */
  describeTaskExecutorCapabilities(input: CommandInput): CommandResult;

  /** params.cardId; body — card JSON object */
  updateInCardStore(input: CommandInput): CommandResult;

  /** params.cardId */
  readFromCardStore(input: CommandInput): CommandResult<{ card: unknown }>;
}

// ============================================================================
// createBoardLiveCardsNonCorePublic — factory
// ============================================================================

export function createBoardLiveCardsNonCorePublic(
  baseRef: KindValueRef,
  adapter: BoardNonCorePlatformAdapter,
): BoardLiveCardsNonCorePublic {
  // Mirror the same internal helpers as the core factory.
  function makeCardAdapterNC(): CardStorageAdapter {
    const kv = adapter.kvStorage('cards');
    return {
      readIndex: () => kv.read('_index') as CardIndex | null,
      writeIndex: (index: CardIndex) => kv.write('_index', index),
      readCard: (key) => kv.read(key) as LiveCard | null,
      writeCard: (key, card) => { kv.write(key, card); return stableHash(card); },
      cardExists: (key) => kv.read(key) !== null,
      defaultCardKey: (cardId) => cardId,
    };
  }
  const configStore = () => createBoardConfigStore(adapter.kvStorage('config'));
  const cardStore = () => createCardStore(makeCardAdapterNC(), adapter.onWarn ?? (() => { /* no-op */ }));

  // ── Shared validation helper ───────────────────────────────────────────────

  function validateCardObject(
    cardId: string,
    card: Record<string, unknown>,
  ): CommandResult<{ cardId: string; errors: string[] }> {
    const schemaResult = adapter.validateSchema(card);
    const sourceErrors: string[] = [];

    const teRef = configStore().readTaskExecutorRef();
    if (teRef && Array.isArray(card['source_defs'])) {
      for (const src of card['source_defs'] as Array<Record<string, unknown>>) {
        const bindTo = typeof src['bindTo'] === 'string' ? src['bindTo'] : '(unknown)';
        const tmpFile = adapter.makeTempFilePath(`validate-src-${bindTo}`);
        try {
          adapter.absoluteBlob.write(tmpFile, JSON.stringify(src));
          let stdout: string;
          try {
            stdout = adapter.invokeExecutorSync(teRef, 'validate-source-def', ['--in', tmpFile], { timeout: 10_000 });
          } catch (execErr: unknown) {
            const se = execErr as { stdout?: string | Buffer };
            stdout = typeof se?.stdout === 'string' ? se.stdout
              : Buffer.isBuffer(se?.stdout) ? se.stdout.toString('utf-8')
              : '';
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
        } finally {
          try { adapter.absoluteBlob.remove(tmpFile); } catch { /* best-effort */ }
        }
      }
    }

    const allErrors = [...schemaResult.errors, ...sourceErrors];
    return ok({ cardId, errors: allErrors }) as CommandResult<{ cardId: string; errors: string[] }>;
  }

  // ── Shared probe helper ────────────────────────────────────────────────────

  function runSourceProbe(
    src: Record<string, unknown>,
    mockProjections: Record<string, unknown>,
    cardDir: string,
    outRef?: string,
  ): CommandResult {
    const teRef = configStore().readTaskExecutorRef();
    if (!teRef) return fail('No task-executor registered for this board');

    const bindTo = typeof src['bindTo'] === 'string' ? src['bindTo'] : 'source';
    const inFile  = adapter.makeTempFilePath(`probe-in-${bindTo}`);
    const outFile = adapter.makeTempFilePath(`probe-out-${bindTo}`);
    const errFile = adapter.makeTempFilePath(`probe-err-${bindTo}`, '.txt');

    const inPayload: Record<string, unknown> = {
      ...src,
      cwd: typeof src['cwd'] === 'string' && src['cwd'] ? src['cwd'] : cardDir,
      boardDir: baseRef.value,
      _projections: mockProjections,
    };

    const inRefStr  = serializeRef({ kind: 'fs-path', value: inFile });
    const outRefStr = serializeRef({ kind: 'fs-path', value: outFile });
    const errRefStr = serializeRef({ kind: 'fs-path', value: errFile });

    adapter.absoluteBlob.write(inFile, JSON.stringify(inPayload, null, 2));

    let result: string | null = null;
    try {
      adapter.invokeExecutorSync(teRef, 'run-source-fetch',
        ['--in-ref', inRefStr, '--out-ref', outRefStr, '--err-ref', errRefStr],
        { timeout: (src['timeout'] as number | undefined) ?? 30_000 },
      );
      result = adapter.absoluteBlob.read(outFile);
      if (result === null) return fail('Executor produced no output file');
    } catch (e) {
      const errMsg = adapter.absoluteBlob.read(errFile)?.trim()
        ?? (e instanceof Error ? e.message : String(e));
      return fail(`Probe failed: ${errMsg}`);
    } finally {
      try { adapter.absoluteBlob.remove(inFile); } catch { /* best-effort */ }
      try { adapter.absoluteBlob.remove(errFile); } catch { /* best-effort */ }
    }

    if (outRef) {
      const parsed = parseRef(outRef);
      adapter.absoluteBlob.write(parsed.value, result);
    } else {
      try { adapter.absoluteBlob.remove(outFile); } catch { /* best-effort */ }
    }

    return ok({ bindTo, resultSizeBytes: result.length });
  }

  // ── Public methods ─────────────────────────────────────────────────────────

  function validateCard(input: CommandInput): CommandResult<{ cardId: string; errors: string[] }> {
    try {
      const cardId = input.params?.['cardId'] as string | undefined;
      if (!cardId) return fail('validateCard requires params.cardId') as CommandResult<{ cardId: string; errors: string[] }>;
      const card = cardStore().readCard(cardId);
      if (!card) return fail(`Card "${cardId}" not found`) as CommandResult<{ cardId: string; errors: string[] }>;
      return validateCardObject(cardId, card as Record<string, unknown>);
    } catch (e) { return err(e) as CommandResult<{ cardId: string; errors: string[] }>; }
  }

  function validateTmpCard(input: CommandInput): CommandResult<{ cardId: string; errors: string[] }> {
    try {
      if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
        return fail('validateTmpCard requires card JSON object in body') as CommandResult<{ cardId: string; errors: string[] }>;
      }
      const card = input.body as Record<string, unknown>;
      const cardId = typeof card['id'] === 'string' ? card['id'] : '(unknown)';
      return validateCardObject(cardId, card);
    } catch (e) { return err(e) as CommandResult<{ cardId: string; errors: string[] }>; }
  }

  function probeSource(input: CommandInput): CommandResult {
    try {
      const cardId    = input.params?.['cardId']    as string | undefined;
      const sourceIdx = input.params?.['sourceIdx'] as number | undefined;
      const outRef    = input.params?.['outRef']    as string | undefined;
      if (!cardId) return fail('probeSource requires params.cardId');
      if (sourceIdx === undefined) return fail('probeSource requires params.sourceIdx');
      const mockProjections = (input.body ?? {}) as Record<string, unknown>;

      const card = cardStore().readCard(cardId) as Record<string, unknown> | null;
      if (!card) return fail(`Card "${cardId}" not found`);
      const sourceDefs = (card['source_defs'] ?? []) as Array<Record<string, unknown>>;
      if (sourceIdx < 0 || sourceIdx >= sourceDefs.length) {
        return fail(`sourceIdx ${sourceIdx} out of range (card has ${sourceDefs.length} source(s))`);
      }
      return runSourceProbe(sourceDefs[sourceIdx], mockProjections, baseRef.value, outRef);
    } catch (e) { return err(e); }
  }

  function probeTmpSource(input: CommandInput): CommandResult {
    try {
      const outRef = input.params?.['outRef'] as string | undefined;
      const b = input.body as Record<string, unknown> | undefined;
      if (!b) return fail('probeTmpSource requires body with sourceDef and mockProjections');
      const sourceDef = b['sourceDef'] as Record<string, unknown> | undefined;
      const mockProjections = (b['mockProjections'] ?? {}) as Record<string, unknown>;
      if (!sourceDef) return fail('probeTmpSource body requires sourceDef');
      return runSourceProbe(sourceDef, mockProjections, baseRef.value, outRef);
    } catch (e) { return err(e); }
  }

  function describeTaskExecutorCapabilities(_input: CommandInput): CommandResult {
    try {
      const teRef = configStore().readTaskExecutorRef();
      if (!teRef) return fail('No task-executor registered for this board');
      const stdout = adapter.invokeExecutorSync(teRef, 'describe-capabilities', [], { timeout: 10_000 });
      return ok(JSON.parse(stdout.trim()) as Record<string, unknown>);
    } catch (e) { return err(e); }
  }

  function updateInCardStore(input: CommandInput): CommandResult {
    try {
      const cardId = input.params?.['cardId'] as string | undefined;
      if (!cardId) return fail('updateInCardStore requires params.cardId');
      if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
        return fail('updateInCardStore requires card JSON object in body');
      }
      const card = input.body as LiveCard;
      if (typeof card.id !== 'string') return fail('Card body must have a string id field');
      if (card.id !== cardId) return fail(`Card body id "${card.id}" does not match params.cardId "${cardId}"`);
      cardStore().writeCard(cardId, card);
      return ok({ cardId, message: `Card "${cardId}" written to store.` });
    } catch (e) { return err(e); }
  }

  function readFromCardStore(input: CommandInput): CommandResult<{ card: unknown }> {
    try {
      const cardId = input.params?.['cardId'] as string | undefined;
      if (!cardId) return fail('readFromCardStore requires params.cardId') as CommandResult<{ card: unknown }>;
      const card = cardStore().readCard(cardId);
      if (!card) return fail(`Card "${cardId}" not found`) as CommandResult<{ card: unknown }>;
      return ok({ card }) as CommandResult<{ card: unknown }>;
    } catch (e) { return err(e) as CommandResult<{ card: unknown }>; }
  }

  return {
    validateCard, validateTmpCard,
    probeSource, probeTmpSource,
    describeTaskExecutorCapabilities,
    updateInCardStore, readFromCardStore,
  };
}
