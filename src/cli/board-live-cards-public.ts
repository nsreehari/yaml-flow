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
  CardUpsertIndexEntry,
  ExecutionRequestEntry,
  BoardEnvelope,
  SourceTokenPayload,
  BoardStatusObject,
} from './board-live-cards-lib.js';

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
   * Namespaces used:
   *   'config'             — board configuration (.task-executor, .chat-handler)
   *   'card-upsert'        — card upsert dedup index
   *   'execution-requests' — queued execution requests (keyed by journalId)
   *   'card-runtime'       — card runtime state snapshots
   *   'output'             — published board status + card computed outputs
   */
  kvStorage(namespace: string): KVStorage;

  /**
   * Blob storage factory — scoped by namespace.
   * Namespaces used:
   *   'cards'   — card JSON definition files
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
   * Card storage adapter — composes kv index + card blobs.
   * Injected directly because the composition is domain-specific.
   */
  cardAdapter(): CardStorageAdapter;

  /**
   * State snapshot adapter — platform provides this because atomic multi-key
   * commit semantics are platform-specific:
   *   FS:        atomic file writes with version checksum
   *   Azure:     Cosmos DB ETags / optimistic concurrency
   *   Firestore: Firestore transactions
   */
  snapshotAdapter: StateSnapshotStorageAdapter;

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
  init(taskExecutor?: string, chatHandler?: string): CommandResult;
  status(): CommandResult<BoardStatusObject>;
  removeCard(id: string): CommandResult;
  retrigger(id: string): CommandResult;
  processAccumulatedEvents(): Promise<CommandResult>;

  // Card management
  upsertCard(cardId: string, restart?: boolean): CommandResult;
  validateCard(cardId: string): CommandResult;

  // Task callbacks — token encodes the baseRef, no separate baseRef param
  taskCompleted(token: string, data?: Record<string, unknown>): CommandResult;
  taskFailed(token: string, error?: string): CommandResult;
  taskProgress(token: string, update?: Record<string, unknown>): CommandResult;

  // Source callbacks — token encodes the baseRef, no separate baseRef param
  sourceDataFetched(token: string, ref: string): CommandResult;
  sourceDataFetchFailure(token: string, reason?: string): CommandResult;
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

  // Store factory helpers — no long-lived singletons, created per call
  const configStore = () => createBoardConfigStore(adapter.kvStorage('config'));
  const snapshotStore = () => createStateSnapshotStore(adapter.snapshotAdapter);
  const journalStore = () => createJournalStore(adapter.journalAdapter());
  const cardStore = () => createCardStore(adapter.cardAdapter(), warn);
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

  function init(taskExecutor?: string, chatHandler?: string): CommandResult {
    try {
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

  function status(): CommandResult<BoardStatusObject> {
    try {
      let s = outputStore().readStatusSnapshot() as BoardStatusObject | null;
      if (!s) {
        s = buildBoardStatusObject(boardPath, restore(loadEnvelope().graph));
        try { outputStore().writeStatusSnapshot(s); } catch { /* best-effort */ }
      }
      return ok(s);
    } catch (e) { return err(e) as CommandResult<BoardStatusObject>; }
  }

  function removeCard(id: string): CommandResult {
    try {
      appendJournalEvent({ type: 'task-removal', taskName: id, timestamp: nowIso() });
      void processAccumulatedEvents();
      return ok();
    } catch (e) { return err(e); }
  }

  function retrigger(id: string): CommandResult {
    try {
      appendJournalEvent({ type: 'task-restart', taskName: id, timestamp: nowIso() });
      void processAccumulatedEvents();
      return ok();
    } catch (e) { return err(e); }
  }

  async function processAccumulatedEvents(): Promise<CommandResult> {
    try {
      const ran = await withRelayLock(adapter.lock, drainCycle);
      return ok({ ran: ran !== false });
    } catch (e) { return err(e); }
  }

  function upsertCard(cardId: string, restart = false): CommandResult {
    try {
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

      void processAccumulatedEvents();
      return ok({ message: `Card "${cardId}" ${existing ? 'updated' : 'inserted'}${restart ? ' (restarted)' : ''}.` });
    } catch (e) { return err(e); }
  }

  function validateCard(cardId: string): CommandResult {
    try {
      const card = cardStore().readCard(cardId);
      if (!card) return fail(`Card "${cardId}" not found`);
      // Schema validation only — executor-based source validation is a future extension.
      return ok({ cardId, errors: [] as string[] });
    } catch (e) { return err(e); }
  }

  function taskCompleted(token: string, data: Record<string, unknown> = {}): CommandResult {
    try {
      const decoded = decodeCallbackToken(token);
      if (!decoded) return fail('Invalid callback token');
      try { outputStore().writeDataObjects(data); } catch { /* best-effort */ }
      appendJournalEvent({ type: 'task-completed', taskName: decoded.taskName, data, timestamp: nowIso() });
      void processAccumulatedEvents();
      return ok();
    } catch (e) { return err(e); }
  }

  function taskFailed(token: string, error = 'unknown error'): CommandResult {
    try {
      const decoded = decodeCallbackToken(token);
      if (!decoded) return fail('Invalid callback token');
      appendJournalEvent({ type: 'task-failed', taskName: decoded.taskName, error, timestamp: nowIso() });
      void processAccumulatedEvents();
      return ok();
    } catch (e) { return err(e); }
  }

  function taskProgress(token: string, update: Record<string, unknown> = {}): CommandResult {
    try {
      const decoded = decodeCallbackToken(token);
      if (!decoded) return fail('Invalid callback token');
      appendJournalEvent({ type: 'task-progress', taskName: decoded.taskName, update, timestamp: nowIso() });
      void processAccumulatedEvents();
      return ok();
    } catch (e) { return err(e); }
  }

  function sourceDataFetched(token: string, ref: string): CommandResult {
    try {
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
      void processAccumulatedEvents();
      return ok();
    } catch (e) { return err(e); }
  }

  function sourceDataFetchFailure(token: string, reason = 'unknown'): CommandResult {
    try {
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
      void processAccumulatedEvents();
      return ok();
    } catch (e) { return err(e); }
  }

  return {
    init, status, removeCard, retrigger, processAccumulatedEvents,
    upsertCard, validateCard,
    taskCompleted, taskFailed, taskProgress,
    sourceDataFetched, sourceDataFetchFailure,
  };
}
