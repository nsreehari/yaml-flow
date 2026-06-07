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
 *   const status = board.status();
 */

import type { KVStorage, BlobStorage, KindValueRef, AtomicRelayLock, ScratchStorage, ArchiveFactory, QueueStorage } from './storage-interface.js';
import { withRelayLock, serializeRef, parseRef } from './storage-interface.js';
import type { ChatStorage } from './chat-storage-lib.js';
import type { BoardCallbackTransport } from './board-callback-transport.js';
import { assertBoardCallbackTransport } from './board-callback-transport.js';
import type { ExecutionRef } from './execution-interface.js';
import {
  type BoardChangeNotification,
  type NotificationEmitter,
  type RuntimeNotification,
  withRuntimeNotificationBatchCategories,
  withRuntimeNotificationCategories,
} from './notification-interface.js';
import { restore, createLiveGraph, snapshot } from '../../continuous-event-graph/core.js';
import { createReactiveGraph } from '../../continuous-event-graph/reactive.js';
import type { GraphEvent } from '../../event-graph/types.js';
import { CardCompute } from '../../card-compute/index.js';
import type { ComputeNode } from '../../card-compute/index.js';
import {
  createCardStore,
  createJournalStore,
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
  ExecutionRequestStore,
  BoardEnvelope,
  SourceTokenPayload,
  BoardStatusObject,
  LiveCard,
  CardIndex,
  CardRuntimeStore,
  CardRuntimeSnapshot,
  FetchedSourcesStore,
} from './board-live-cards-lib.js';
import { createCardStorePublic } from './card-store-lib-public.js';

// Re-export constants so platform adapter files can import them without going through lib directly.
export { BOARD_GRAPH_KEY, SNAPSHOT_SCHEMA_VERSION_V1, EMPTY_CONFIG } from './board-live-cards-lib.js';
export type { BoardChangeNotification } from './notification-interface.js';

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
   *   ''        — root-scoped blob access (for resolving arbitrary KindValueRef blobs)
   */
  blobStorage(namespace: string): BlobStorage;
  blobStorageForRef(ref: string): BlobStorage;
  chatStorageForRef(ref: string): ChatStorage;

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
  journalAdapterForRef(ref: string): JournalStorageAdapter;

  /**
   * Queue storage lane resolved from an explicit queue store ref.
   * The adapter chooses the backend from the ref; lane chooses the internal queue.
   */
  queueStorageForRef(ref: string, lane: string): QueueStorage;

  /**
   * AtomicRelayLock — non-blocking try-acquire with relay-on-busy semantics.
   * Guards processAccumulatedEvents drain cycle.
   *   FS:        proper-lockfile (createFsAtomicRelayLock)
   *   Azure:     blob lease
   *   Firestore: Firestore transaction + sentinel document
   */
  lock: AtomicRelayLock;

  /**
   * Adapter-owned callback transport used to build worker callback payloads.
   * The board core treats callback delivery as a platform concern.
   */
  callbackTransport?: BoardCallbackTransport;

  /**
   * Generic execution dispatch — platform adapts ExecutionRef → actual transport.
   * Public layer constructs fully-formed semantic args (source def, base_ref,
   * callback token with selfRef baked in). Platform handles transport:
    *   Node host adapter: may write args to temp file and may spawn a detached process
   *   Azure: HTTP POST args as JSON body
   *   Firebase: publishes args as pubsub message
   */
  dispatchExecution(ref: ExecutionRef, args: Record<string, unknown>): Promise<{ dispatched: boolean; error?: string }>;

  /**
   * Whether dispatchExecution can accept a board-owned staged source output ref
   * for this executor. When false/absent, the adapter keeps its legacy staging
   * protocol such as scratch in/out refs for local process launch.
   */
  supportsDirectSourceOutput?(ref: ExecutionRef): boolean;

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
  getBoardRuntimeStoreRef(input: CommandInput): CommandResult<{ storeRef: string | null }>;
  // no params needed
  getCardStoreRef(input: CommandInput): CommandResult<{ storeRef: string }>;
  getOutputsStoreRef(input: CommandInput): CommandResult<{ storeRef: string }>;
  getScratchStoreRef(input: CommandInput): CommandResult<{ storeRef: string | null }>;
  getChatStoreRef(input: CommandInput): CommandResult<{ storeRef: string | null }>;
  getArtifactsStoreRef(input: CommandInput): CommandResult<{ storeRef: string | null }>;
  getFetchedSourcesStoreRef(input: CommandInput): CommandResult<{ storeRef: string | null }>;
  // params: key — one of: 'task-executor', 'chat-handler-flow', 'board-runtime-store-ref', 'card-store-ref', 'outputs-store-ref', 'scratch-store-ref', 'chat-store-ref', 'artifacts-store-ref', 'fetched-sources-store-ref'
  getConfig(input: CommandInput): CommandResult<{ value: unknown }>;
  // params: key
  getOutputsDataObject(input: CommandInput): CommandResult;
  // no params needed
  getAllOutputsDataObjects(input: CommandInput): CommandResult<Record<string, unknown>>;
  // params: key
  getOutputsComputedValues(input: CommandInput): CommandResult;
  // no params needed
  getAllOutputsComputedValues(input: CommandInput): CommandResult<Record<string, unknown>>;
  // params: key (card-id)
  getOutputsFetchedSources(input: CommandInput): CommandResult<Record<string, string>>;
  // no params needed
  getAllOutputsFetchedSources(input: CommandInput): CommandResult<Record<string, Record<string, string>>>;
  // params: id
  removeCard(input: CommandInput): CommandResult;
  // params: cardId; body matches card-store appendFiles input
  addCardFiles(input: CommandInput): CommandResult<{ cardId: string; files_added: Array<{ idx: number; entry: unknown }>; notified: true }>;
  // params: id
  retrigger(input: CommandInput): CommandResult;
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

type HostedSourceTokenPayload = SourceTokenPayload & { dt?: string };

function encodeSourceToken(payload: HostedSourceTokenPayload): string {
  return toBase64Url(JSON.stringify(payload));
}

function decodeSourceToken(token: string): HostedSourceTokenPayload | null {
  try {
    const p = JSON.parse(fromBase64Url(token));
    if (typeof p?.cbk === 'string' && typeof p?.cid === 'string' &&
        typeof p?.b === 'string' && typeof p?.d === 'string') return p as HostedSourceTokenPayload;
    return null;
  } catch { return null; }
}

function nowIso(): string { return new Date().toISOString(); }

function createInMemoryExecutionRequestStore(
  onDispatchFailed: (entry: ExecutionRequestEntry, error: string) => void,
): ExecutionRequestStore {
  const entriesByJournalId = new Map<string, ExecutionRequestEntry[]>();
  return {
    appendEntries(journalId: string, entries: ExecutionRequestEntry[]): void {
      if (!journalId || entries.length === 0) return;
      const existing = entriesByJournalId.get(journalId) ?? [];
      entriesByJournalId.set(journalId, [...existing, ...entries]);
    },
    dispatchEntriesForJournalId(journalId: string, processorFn: (entry: ExecutionRequestEntry) => void): void {
      if (!journalId) return;
      const pendingEntries = entriesByJournalId.get(journalId);
      if (!pendingEntries || pendingEntries.length === 0) return;
      for (const entry of pendingEntries) {
        try {
          processorFn(entry);
        } catch (error) {
          try { onDispatchFailed(entry, error instanceof Error ? error.message : String(error)); } catch { /* best-effort */ }
        }
      }
      entriesByJournalId.delete(journalId);
    },
  };
}

// ============================================================================
// createBoardLiveCardsPublic — factory
// ============================================================================

export interface BoardLiveCardsPublicOptions {
  boardRuntimeStoreRef?: string;
  scratchStoreRef?: string;
  taskExecutorRef?: ExecutionRef;
  chatHandlerFlow?: unknown;
  emitNotification?: NotificationEmitter;
}

export function createBoardLiveCardsPublic(
  baseRef: KindValueRef,
  adapter: BoardPlatformAdapter,
  options: BoardLiveCardsPublicOptions = {},
): BoardLiveCardsPublic {
  assertBoardCallbackTransport(adapter.callbackTransport, 'createBoardLiveCardsPublic');
  const callbackTransport = adapter.callbackTransport;
  const warn = adapter.onWarn ?? (() => { /* no-op */ });
  const boardPath = serializeRef(baseRef);
  let runtimeStoreRef = options.boardRuntimeStoreRef;
  let scratchStoreRef = options.scratchStoreRef;
  const hostedTaskExecutorRef = options.taskExecutorRef;
  const hostedChatHandlerFlow = options.chatHandlerFlow;
  const emitNotification = options.emitNotification ?? ((notification: RuntimeNotification | import('./notification-interface.js').RuntimeNotificationBatch) => {
    if (!adapter.publishBoardChangeNotifications) return;
    const notifications = notification.kind === 'notification-batch'
      ? notification.notifications as BoardChangeNotification[]
      : [notification as BoardChangeNotification];
    return adapter.publishBoardChangeNotifications(notifications);
  });

  function requireBoardRuntimeStoreRef(): string {
    if (!runtimeStoreRef) throw new Error(`Board at ${baseRef.value} has no board runtime store configured. Pass boardRuntimeStoreRef at construction or init.`);
    return runtimeStoreRef;
  }

  function flushBoardChangeNotifications(notifications: BoardChangeNotification[]): void {
    if (notifications.length === 0) return;
    try {
      const normalized = withRuntimeNotificationCategories(notifications as RuntimeNotification[]) as BoardChangeNotification[];
      const batch = withRuntimeNotificationBatchCategories({ kind: 'notification-batch', notifications: normalized as RuntimeNotification[] });
      const p = emitNotification(batch);
      if (p && typeof (p as Promise<void>).catch === 'function') {
        void (p as Promise<void>).catch((e: unknown) =>
          warn(`[board-live-cards-public] emitNotification failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      }
    } catch (e) {
      warn(`[board-live-cards-public] emitNotification failed: ${e instanceof Error ? e.message : String(e)}`);
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
      const kv = adapter.kvStorageForRef(requireBoardRuntimeStoreRef());
      const keys = kv.listKeys().sort();
      if (keys.length === 0) return { version: null, values: {} };
      const values: Record<string, unknown> = {};
      for (const key of keys) values[key] = kv.read(key);
      return { version: adapter.hashFn(values), values };
    },
    writeValues(_scopeId: string, nextValues: Record<string, unknown>, deletedKeys: string[]): string {
      const kv = adapter.kvStorageForRef(requireBoardRuntimeStoreRef());
      for (const key of deletedKeys) kv.delete(key);
      for (const [key, value] of Object.entries(nextValues)) kv.write(key, value);
      return adapter.hashFn(nextValues);
    },
  };

  // Store factory helpers — no long-lived singletons, created per call
  const configStore = () => createBoardConfigStore(adapter.kvStorageForRef(requireBoardRuntimeStoreRef()));
  const snapshotStore = () => createStateSnapshotStore(snapshotAdapterImpl);
  const journalStore = () => createJournalStore(adapter.journalAdapterForRef(requireBoardRuntimeStoreRef()));
  const cardStore = () => createCardStore(makeCardAdapter(), warn);
  const outputStore = () => {
    const ref = configStore().readOutputsStoreRef();
    if (!ref) throw new Error(`Board at ${baseRef.value} has no outputs store configured. Run: init --outputs-store-ref <b64-ref>`);
    return createPublishedOutputsStore(adapter.kvStorageForRef(ref));
  };

  function resolveTaskExecutorRef(): ExecutionRef | undefined {
    return hostedTaskExecutorRef ?? configStore().readTaskExecutorRef();
  }

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

    const executionRequestStore = createInMemoryExecutionRequestStore(onDispatchFailed);

    const envelope = loadEnvelope();
    const live = restore(envelope.graph);
    const { events: undrained, newCursor } = journalStore().readEntriesAfterCursor(envelope.lastDrainedJournalId);

    const fetchedSourcesBlob = fetchedSourcesBlobStore();
    const realFetchedSourcesStore = createFetchedSourcesStore(
      fetchedSourcesBlob,
      (ref) => adapter.resolveBlob(ref),
    );

    // RX: in-memory overlay for card runtime writes — reads check overlay first
    const runtimeByCardId = { ...envelope.runtimeByCardId };
    const RX = new Map<string, CardRuntimeSnapshot>();
    const overlayCardRuntimeStore: CardRuntimeStore = {
      readRuntime(cardId) {
        return RX.get(cardId) ?? runtimeByCardId[cardId] ?? { _sources: {} };
      },
      writeRuntime(cardId, state) {
        RX.set(cardId, state);
        runtimeByCardId[cardId] = state;
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
        let content = fetchedSourcesBlob.read(stagedKey);
        if (content == null) {
          const stagedRef = fetchedSourcesBlob.keyRef?.(stagedKey);
          if (stagedRef) content = adapter.resolveBlob(stagedRef);
        }
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
      listSources(cardId) {
        const real = realFetchedSourcesStore.listSources(cardId);
        const overlayFiles = new Set<string>();
        for (const k of sxCache.keys()) {
          if (k.startsWith(`${cardId}/`)) overlayFiles.add(k.slice(`${cardId}/`.length));
        }
        const merged = new Set([...real, ...overlayFiles]);
        return Array.from(merged);
      },
    };

    const cardHandlerAdapters = {
      cardStore: cardStore(),
      cardRuntimeStore: overlayCardRuntimeStore,
      fetchedSourcesStore: overlayFetchedSourcesStore,
      outputStore: outputStore(),
      executionRequestStore,
    };

    let TX: GraphEvent[] = [];
    const CX: { cardId: string; values: Record<string, unknown> }[] = [];
    const DX: Record<string, unknown>[] = [];
    // NX: card refreshes — Map so last write per cardId wins, deduplicating rapid updates.
    const NX = new Map<string, LiveCard>();
    const RemX = new Set<string>();

    const taskCompletedFn = (taskName: string, data: Record<string, unknown>): void => {
      TX.push({ type: 'task-completed', taskName, data, timestamp: nowIso() } as GraphEvent);
    };
    const taskFailedFn = (taskName: string, error: string): void => {
      appendJournalEvent({ type: 'task-failed', taskName, error, timestamp: nowIso() });
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
      onNodeRemoved: (cardId) => {
        NX.delete(cardId);
        RX.delete(cardId);
        delete runtimeByCardId[cardId];
        RemX.add(cardId);
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
    commitEnvelope({ lastDrainedJournalId: newCursor, graph: snapshot(finalLive), runtimeByCardId }, currentVersion);

    // Flush deferred output writes after board state is saved
    for (const { cardId, values } of CX) cardHandlerAdapters.outputStore.writeComputedValues(cardId, values);
    for (const data of DX) cardHandlerAdapters.outputStore.writeDataObjects(data);

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
    for (const cardId of RemX) batch.push({ kind: 'card_removed', cardId });
    if (statusObj !== undefined) batch.push({ kind: 'status', status: statusObj });
    flushBoardChangeNotifications(batch);

    const executorRef = resolveTaskExecutorRef()
      ?? { howToRun: 'built-in' as const, whatToRun: serializeRef({ kind: 'built-in', value: 'source-cli-task-executor' }) };
    const useDirectHostedWorkerRequest = adapter.supportsDirectSourceOutput?.(executorRef) === true;

    executionRequestStore.dispatchEntriesForJournalId(newCursor, (entry) => {
      if (entry.taskKind !== 'source-fetch') {
        warn(`[process-accumulated-events] unknown taskKind "${entry.taskKind}" — skipping`);
        return;
      }
      const p = entry.payload as { boardRef: string; enrichedCard: Record<string, unknown>; callbackToken: string; rqt: string };
      const cardId = (p.enrichedCard?.id as string | undefined) ?? 'unknown';
      const sourceDefs = (p.enrichedCard?.source_defs ?? []) as Array<{ bindTo: string; outputFile?: string; [k: string]: unknown }>;

      if (executorRef.howToRun === 'queue-storage' && useDirectHostedWorkerRequest) {
        try {
          const queue = adapter.queueStorageForRef(queueStoreRef(), 'task-executor');
          const boardId = typeof executorRef.extra?.boardId === 'string' ? executorRef.extra.boardId : undefined;
          const requests: Array<{ boardId?: string; ref: typeof executorRef; args: Record<string, unknown> }> = [];
          for (const src of sourceDefs) {
            if (!src.outputFile) { warn(`[dispatch] source "${src.bindTo}" has no outputFile — skipping`); continue; }
            const deliveryToken = adapter.genId();
            const stagedKey = `${cardId}/.staged/${deliveryToken}/${src.outputFile}`;
            const stagedRef = fetchedSourcesBlob.keyRef?.(stagedKey);
            if (!stagedRef) continue;
            const directOutput = {
              ref: serializeRef(stagedRef),
              deliveryToken,
              outputFile: src.outputFile,
              cardId,
            };
            const sourceToken = encodeSourceToken({
              cbk: p.callbackToken, rg: baseRef.value, br: serializeRef(baseRef),
              cid: cardId, b: src.bindTo, d: src.outputFile, cs: undefined, rqt: p.rqt,
              dt: directOutput.deliveryToken,
            });
            requests.push({
              ...(boardId ? { boardId } : {}),
              ref: executorRef,
              args: {
                source_def: src,
                base_ref: serializeRef(baseRef),
                callback: callbackTransport.createCallback(sourceToken),
                output: directOutput,
              },
            });
          }
          if (requests.length > 0) queue.enqueueMany(requests);
        } catch (e) {
          taskFailedFn(cardId, e instanceof Error ? e.message : String(e));
        }
        return;
      }

      for (const src of sourceDefs) {
        if (!src.outputFile) { warn(`[dispatch] source "${src.bindTo}" has no outputFile — skipping`); continue; }
        let directOutput: { ref: string; deliveryToken: string; outputFile: string; cardId: string } | undefined;
        if (useDirectHostedWorkerRequest) {
          const deliveryToken = adapter.genId();
          const stagedKey = `${cardId}/.staged/${deliveryToken}/${src.outputFile}`;
          const stagedRef = fetchedSourcesBlob.keyRef?.(stagedKey);
          if (stagedRef) {
            directOutput = {
              ref: serializeRef(stagedRef),
              deliveryToken,
              outputFile: src.outputFile,
              cardId,
            };
          }
        }
        const sourceToken = encodeSourceToken({
          cbk: p.callbackToken, rg: baseRef.value, br: serializeRef(baseRef),
          cid: cardId, b: src.bindTo, d: src.outputFile, cs: undefined, rqt: p.rqt,
          ...(directOutput ? { dt: directOutput.deliveryToken } : {}),
        });
        adapter.dispatchExecution(executorRef, {
          source_def: src, base_ref: serializeRef(baseRef),
          callback: callbackTransport.createCallback(sourceToken),
          ...(directOutput ? { output: directOutput } : {}),
        }).catch((e: unknown) => taskFailedFn(cardId, e instanceof Error ? e.message : String(e)));
      }
    });
  }

  // ── Public methods ──────────────────────────────────────────────────────────

  function queueStoreRef(): string {
    const ref = configStore().readQueueStoreRef();
    if (!ref) throw new Error(`Board at ${baseRef.value} has no queue store configured. Run: init --queue-store-ref <b64-ref>`);
    return ref;
  }

  function requestQueuedProcessAccumulated(): void {
    const queue = adapter.queueStorageForRef(queueStoreRef(), 'process-accumulated');
    if (queue.enqueueIfAbsent) {
      queue.enqueueIfAbsent({ boardRef: serializeRef(baseRef) }, `process-accumulated:${serializeRef(baseRef)}`);
    } else {
      queue.enqueue({ boardRef: serializeRef(baseRef) });
    }
    adapter.requestProcessAccumulated?.();
  }

  function clearQueuedProcessAccumulatedWakeups(): void {
    const queue = adapter.queueStorageForRef(queueStoreRef(), 'process-accumulated');
    while (true) {
      const leased = queue.lease<{ boardRef?: string }>({ max: 64, visibilityMs: 1_000 });
      if (leased.length <= 0) return;
      for (const message of leased) {
        queue.ack(message.id, message.leaseToken);
      }
      if (leased.length < 64) return;
    }
  }

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
        requestQueuedProcessAccumulated();
      };
      const ran = await withRelayLock(adapter.lock, drainCycle, continuation);
      return ok({ ran: ran !== false });
    } catch (e) { return err(e); }
  }

  function drainFireAndForget(): void {
    requestQueuedProcessAccumulated();
  }

  function init(input: CommandInput): CommandResult {
    try {
      // cardStoreRef is required — create a card store with card-store-cli first
      const storeRef = input.params?.['cardStoreRef'] as string | undefined;
      if (!storeRef) return fail('init requires params.cardStoreRef — create a card store with card-store-cli and pass its ref here');
      runtimeStoreRef = input.params?.['boardRuntimeStoreRef'] as string | undefined;
      if (!runtimeStoreRef) return fail('init requires params.boardRuntimeStoreRef — pass the board runtime store ref here');
      if (!boardExists()) {
        const live = createLiveGraph(EMPTY_CONFIG);
        commitEnvelope({ lastDrainedJournalId: '', graph: snapshot(live), runtimeByCardId: {} }, null);
      }
      const outputsStoreRef = input.params?.['outputsStoreRef'] as string | undefined;
      if (!outputsStoreRef) return fail('init requires params.outputsStoreRef — pass the outputs store ref here');
      const queueStoreRefValue = input.params?.['queueStoreRef'] as string | undefined;
      if (!queueStoreRefValue) return fail('init requires params.queueStoreRef — pass the queue store ref here');
      const fetchedSourcesStoreRef = input.params?.['fetchedSourcesStoreRef'] as string | undefined;
      if (!fetchedSourcesStoreRef) return fail('init requires params.fetchedSourcesStoreRef — pass the fetched sources store ref here');
      scratchStoreRef = input.params?.['scratchStoreRef'] as string | undefined;
      if (!scratchStoreRef) return fail('init requires params.scratchStoreRef — pass the scratch store ref here');
      const chatStoreRef = input.params?.['chatStoreRef'] as string | undefined;
      if (!chatStoreRef) return fail('init requires params.chatStoreRef — pass the chat store ref here');
      const artifactsStoreRef = input.params?.['artifactsStoreRef'] as string | undefined;
      if (!artifactsStoreRef) return fail('init requires params.artifactsStoreRef — pass the artifacts store ref here');
      const cfg = configStore();
      cfg.writeBoardRuntimeStoreRef(runtimeStoreRef);
      cfg.writeCardStoreRef(storeRef);
      cfg.writeOutputsStoreRef(outputsStoreRef);
      cfg.writeQueueStoreRef(queueStoreRefValue);
      cfg.writeFetchedSourcesStoreRef(fetchedSourcesStoreRef);
      cfg.writeChatStoreRef(chatStoreRef);
      cfg.writeArtifactsStoreRef(artifactsStoreRef);
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
      try { adapter.kvStorage('card-upsert').delete(id); } catch { /* best-effort */ }
      appendJournalEvent({ type: 'task-removal', taskName: id, timestamp: nowIso() });
      drainFireAndForget();
      return ok();
    } catch (e) { return err(e); }
  }

  function addCardFiles(input: CommandInput): CommandResult<{ cardId: string; files_added: Array<{ idx: number; entry: unknown }>; notified: true }> {
    type R = CommandResult<{ cardId: string; files_added: Array<{ idx: number; entry: unknown }>; notified: true }>;
    try {
      const cardId = input.params?.['cardId'] as string | undefined;
      if (!cardId) return fail('addCardFiles requires params.cardId') as R;

      const appendResult = createCardStorePublic(cardStore(), { emitNotification }).appendFiles({
        params: { id: cardId },
        body: input.body,
      });
      if (appendResult.status !== 'success') return appendResult as unknown as R;

      return ok({ cardId, files_added: appendResult.data.files_added, notified: true });
    } catch (e) { return err(e) as R; }
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
    clearQueuedProcessAccumulatedWakeups();
    return drain();
  }

  function fetchedSourcesStoreRef(): string {
    const ref = configStore().readFetchedSourcesStoreRef();
    if (!ref) throw new Error(`Board at ${baseRef.value} has no fetched sources store configured. Run: init --fetched-sources-store-ref <b64-ref>`);
    return ref;
  }

  function fetchedSourcesBlobStore(): BlobStorage {
    return adapter.blobStorageForRef(fetchedSourcesStoreRef());
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
      const { cbk, cid, b, d, cs, rqt, dt } = payload;

      const fetchedSourcesStore = createFetchedSourcesStore(
        fetchedSourcesBlobStore(),
        (ref) => adapter.resolveBlob(ref),
      );

      const deliveryToken = dt || adapter.genId();
      if (!dt) {
        fetchedSourcesStore.ingestSourceDataStaged(cid, d, parseRef(ref), deliveryToken);
      }

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

  function getBoardRuntimeStoreRef(_input: CommandInput): CommandResult<{ storeRef: string | null }> {
    try {
      return ok({ storeRef: runtimeStoreRef ?? null }) as CommandResult<{ storeRef: string | null }>;
    } catch (e) { return err(e) as CommandResult<{ storeRef: string | null }>; }
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
      return ok({ storeRef: scratchStoreRef ?? null }) as CommandResult<{ storeRef: string | null }>;
    } catch (e) { return err(e) as CommandResult<{ storeRef: string | null }>; }
  }

  function getChatStoreRef(_input: CommandInput): CommandResult<{ storeRef: string | null }> {
    try {
      const storeRef = configStore().readChatStoreRef();
      return ok({ storeRef }) as CommandResult<{ storeRef: string | null }>;
    } catch (e) { return err(e) as CommandResult<{ storeRef: string | null }>; }
  }

  function getArtifactsStoreRef(_input: CommandInput): CommandResult<{ storeRef: string | null }> {
    try {
      const storeRef = configStore().readArtifactsStoreRef();
      return ok({ storeRef }) as CommandResult<{ storeRef: string | null }>;
    } catch (e) { return err(e) as CommandResult<{ storeRef: string | null }>; }
  }

  function getFetchedSourcesStoreRef(_input: CommandInput): CommandResult<{ storeRef: string | null }> {
    try {
      const storeRef = configStore().readFetchedSourcesStoreRef();
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
        case 'task-executor':     value = hostedTaskExecutorRef ?? null; break;
        case 'chat-handler-flow': value = hostedChatHandlerFlow ?? null; break;
        case 'board-runtime-store-ref': value = cfg.readBoardRuntimeStoreRef(); break;
        case 'card-store-ref':    value = cfg.readCardStoreRef(); break;
        case 'outputs-store-ref': value = cfg.readOutputsStoreRef(); break;
        case 'scratch-store-ref': value = scratchStoreRef ?? null; break;
        case 'chat-store-ref':        value = cfg.readChatStoreRef(); break;
        case 'artifacts-store-ref':   value = cfg.readArtifactsStoreRef(); break;
        case 'fetched-sources-store-ref': value = cfg.readFetchedSourcesStoreRef(); break;
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

  function sourcesStore() {
    return createFetchedSourcesStore(
      fetchedSourcesBlobStore(),
      (ref) => adapter.resolveBlob(ref),
    );
  }

  function toSourceRef(blobKey: string): string {
    const keyRef = fetchedSourcesBlobStore().keyRef?.(blobKey);
    if (!keyRef) throw new Error('configured fetched-sources store does not support keyRef');
    return serializeRef(keyRef);
  }

  function getOutputsFetchedSources(input: CommandInput): CommandResult<Record<string, string>> {
    try {
      const key = input.params?.['key'] as string | undefined;
      if (!key) return fail('getOutputsFetchedSources requires params.key') as CommandResult<Record<string, string>>;
      const files = sourcesStore().listSources(key);
      const result: Record<string, string> = {};
      for (const outputFile of files) result[outputFile] = toSourceRef(`${key}/${outputFile}`);
      return ok(result) as CommandResult<Record<string, string>>;
    } catch (e) { return err(e) as CommandResult<Record<string, string>>; }
  }

  function getAllOutputsFetchedSources(_input: CommandInput): CommandResult<Record<string, Record<string, string>>> {
    try {
      const store = sourcesStore();
      const cardIds = new Set<string>();
      for (const key of fetchedSourcesBlobStore().listKeys()) {
        const slash = key.indexOf('/');
        if (slash > 0 && !key.includes('/.staged/')) cardIds.add(key.slice(0, slash));
      }
      const result: Record<string, Record<string, string>> = {};
      for (const cardId of cardIds) {
        const files = store.listSources(cardId);
        if (files.length > 0) {
          result[cardId] = {};
          for (const outputFile of files) result[cardId][outputFile] = toSourceRef(`${cardId}/${outputFile}`);
        }
      }
      return ok(result) as CommandResult<Record<string, Record<string, string>>>;
    } catch (e) { return err(e) as CommandResult<Record<string, Record<string, string>>>; }
  }

  return {
    init, status, getBoardRuntimeStoreRef, getCardStoreRef, getOutputsStoreRef, getScratchStoreRef, getChatStoreRef, getArtifactsStoreRef, getFetchedSourcesStoreRef, getConfig,
    getOutputsDataObject, getAllOutputsDataObjects,
    getOutputsComputedValues, getAllOutputsComputedValues,
    getOutputsFetchedSources, getAllOutputsFetchedSources,
    removeCard, addCardFiles, retrigger, processAccumulatedEvents,
    upsertCard,
    taskFailed, taskProgress,
    sourceDataFetched, sourceDataFetchFailure,
  };
}

// ============================================================================
// BoardNonCorePlatformAdapter — extends the base adapter with async
// executor request/response and schema validation.
// ============================================================================

export interface BoardNonCorePlatformAdapter extends BoardPlatformAdapter {
  /**
   * Invoke a task executor subcommand and return stdout.
   * Throws on transport failure, non-zero exit, or timeout.
   */
  invokeExecutor(
    ref: ExecutionRef,
    subcommand: string,
    opts?: { timeout?: number; input?: string },
  ): Promise<string>;

  /** Schema-only card validator (no executor invocation). */
  validateSchema(card: Record<string, unknown>): { ok: boolean; errors: string[] };

  /** Absolute-path blob I/O for resolving arbitrary KindValueRef blobs. */
  absoluteBlob: BlobStorage;

  /**
  * Default timeouts (ms) for executor request/response calls.
   * Each field can also be overridden per-source via source_def.timeout.
   *
   *   validationMs — validate-source-def, validate-card-preflight (structural, fast). Default: 10_000.
    *   preflightMs  — source preflight executor hooks (probe-source-preflight). Default: 60_000.
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
// BoardLiveCardsNonCorePublic — validation, preflight, and compute helpers
// ============================================================================

export interface BoardLiveCardsNonCorePublic {
  /** body: { "card-content": <card> } — card JSON arrives via stdin; validates schema + JSONata + provides refs + source_defs (executor, if configured) */
  validateCardPreflight(input: CommandInput): Promise<CommandResult<{ cardId: string; isValid: boolean; issues: string[] }>>;

  /** body: { "card-content": <card>, "mock-projections"?: {} }; params: sourceIdx, outRef? — card JSON arrives via stdin; no board state needed */
  probeSourcePreflight(input: CommandInput): Promise<CommandResult>;

  /** body: { "card-content": <card>, "mock-projections"?: {} }; params: sourceIdx, outRef? — runs the real source fetch flow as a preflight */
  runSourcePreflight(input: CommandInput): Promise<CommandResult<{ bindTo: string; ok: boolean; result: unknown; issues: string[] }>>;

  /** body: { "card-content": <card>, "mock-fetched-sources"?: {}, "mock-requires"?: {} } — evaluates compute expressions with supplied data; no board state needed */
  evalCardCompute(input: CommandInput): CommandResult<{ cardId: string; ok: boolean; computed_values: Record<string, unknown>; errors: Array<{ bindTo: string; error: string }> }>;

  /** body: { "card-content": <card>, "mock-fetched-sources"?: {}, "mock-requires"?: {} } — full cycle: validate → resolve projections → probe sources → compute */
  simulateCardCycle(input: CommandInput): Promise<CommandResult>;

  /** no params needed */
  describeTaskExecutorCapabilities(input: CommandInput): Promise<CommandResult>;

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
  opts?: { boardRuntimeStoreRef?: string; taskExecutorRef?: ExecutionRef },
): BoardLiveCardsNonCorePublic {
  const hostedTaskExecutorRef = opts?.taskExecutorRef;
  // Mirror the same internal helpers as the core factory.
  const configStore = () => {
    if (opts) {
      if (!opts.boardRuntimeStoreRef) {
        throw new Error(`Board at ${baseRef.value} requires boardRuntimeStoreRef for non-core runtime operations.`);
      }
      return createBoardConfigStore(adapter.kvStorageForRef(opts.boardRuntimeStoreRef));
    }
    return createBoardConfigStore(adapter.kvStorage('config'));
  };
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

  function resolveTaskExecutorRef(): ExecutionRef | undefined {
    return hostedTaskExecutorRef ?? configStore().readTaskExecutorRef();
  }

  // ── Shared validation helper ───────────────────────────────────────────────

  async function validateCardObject(
    cardId: string,
    card: Record<string, unknown>,
  ): Promise<CommandResult<{ cardId: string; isValid: boolean; issues: string[] }>> {
    const schemaResult = adapter.validateSchema(card);
    const sourceErrors: string[] = [];

    const teRef = resolveTaskExecutorRef();
    if (teRef && Array.isArray(card['source_defs'])) {
      for (const src of card['source_defs'] as Array<Record<string, unknown>>) {
        const bindTo = typeof src['bindTo'] === 'string' ? src['bindTo'] : '(unknown)';
        try {
          let stdout: string;
          try {
            // Pass source_def JSON via stdin; executor reads stdin, writes { ok, errors } to stdout.
            stdout = await adapter.invokeExecutor(teRef, 'validate-source-def', { timeout: adapter.executorTimeouts?.validationMs ?? 10_000, input: JSON.stringify(src) });
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

  async function validateCardPreflight(input: CommandInput): Promise<CommandResult<{ cardId: string; isValid: boolean; issues: string[] }>> {
    try {
      if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) {
        return fail('validateCardPreflight requires card JSON object in body') as CommandResult<{ cardId: string; isValid: boolean; issues: string[] }>;
      }
      const body = input.body as Record<string, unknown>;
      const card = (body['card-content'] ?? body) as Record<string, unknown>;
      const cardId = typeof card['id'] === 'string' ? card['id'] : '(unknown)';
      return await validateCardObject(cardId, card);
    } catch (e) { return err(e) as CommandResult<{ cardId: string; isValid: boolean; issues: string[] }>; }
  }

  async function probeSourcePreflight(input: CommandInput): Promise<CommandResult> {
    try {
      const resolved = resolvePreflightSource(input, 'probeSourcePreflight');
      if ('status' in resolved) return resolved;

      // Lightweight probe only. Do not silently degrade into a real fetch path.
      const teRef = resolveTaskExecutorRef();
      if (!teRef) return fail('No task-executor registered for this board');
      try {
        const inPayload = { ...resolved.src, _projections: resolved.mockProjections };
        const stdout = await adapter.invokeExecutor(teRef, 'probe-source-preflight',
          { timeout: (resolved.src['timeout'] as number | undefined) ?? adapter.executorTimeouts?.preflightMs ?? 60_000, input: JSON.stringify(inPayload) });
        const result = JSON.parse(stdout.trim()) as { ok: boolean; reachable: boolean; latencyMs?: number; error?: string; note?: string };
        if (!result.ok) return fail(result.error ?? 'Preflight probe failed');
        return ok({ bindTo: resolved.bindTo, reachable: result.reachable, latencyMs: result.latencyMs, note: result.note });
      } catch {
        return fail('Executor does not support probe-source-preflight');
      }
    } catch (e) { return err(e); }
  }

  async function runSourcePreflight(input: CommandInput): Promise<CommandResult<{ bindTo: string; ok: boolean; result: unknown; issues: string[] }>> {
    try {
      const resolved = resolvePreflightSource(input, 'runSourcePreflight');
      if ('status' in resolved) return resolved as CommandResult<{ bindTo: string; ok: boolean; result: unknown; issues: string[] }>;

      const teRef = resolveTaskExecutorRef();
      if (!teRef) {
        return fail('No task-executor registered for this board') as CommandResult<{ bindTo: string; ok: boolean; result: unknown; issues: string[] }>;
      }

      try {
        const inPayload = { ...resolved.src, _projections: resolved.mockProjections };
        const stdout = await adapter.invokeExecutor(teRef, 'run-source-preflight', {
          timeout: (resolved.src['timeout'] as number | undefined) ?? adapter.executorTimeouts?.probeMs ?? 60_000,
          input: JSON.stringify(inPayload),
        });
        const executed = JSON.parse(stdout.trim()) as { ok?: boolean; bindTo?: string; resultValue?: unknown; error?: string };
        if (!executed.ok) {
          return ok({
            bindTo: resolved.bindTo,
            ok: false,
            result: null,
            issues: [executed.error ?? 'Preflight run failed'],
          });
        }
        if (resolved.outRef) {
          const parsed = parseRef(resolved.outRef);
          adapter.absoluteBlob.write(parsed.value, JSON.stringify(executed.resultValue, null, 2));
        }

        return ok({
          bindTo: typeof executed.bindTo === 'string' ? executed.bindTo : resolved.bindTo,
          ok: true,
          result: executed.resultValue ?? null,
          issues: [],
        });
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        return ok({
          bindTo: resolved.bindTo,
          ok: false,
          result: null,
          issues: [errorMessage],
        });
      }
    } catch (e) { return err(e) as CommandResult<{ bindTo: string; ok: boolean; result: unknown; issues: string[] }>; }
  }

  async function describeTaskExecutorCapabilities(_input: CommandInput): Promise<CommandResult> {
    try {
      const teRef = resolveTaskExecutorRef();
      if (!teRef) return fail('No task-executor registered for this board');
      const stdout = await adapter.invokeExecutor(teRef, 'describe-capabilities', { timeout: adapter.executorTimeouts?.describeMs ?? 10_000 });
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
    fetched_sources: Record<string, unknown>;
    computed_values: Record<string, unknown>;
    compute_errors: Array<{ bindTo: string; error: string }>;
  };

  async function simulateCardCycle(input: CommandInput): Promise<CommandResult<SimulateResult>> {
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
      const structResult = await validateCardObject(cardId, card);
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
      const fetchedSources: Record<string, unknown> = { ...mockFetchedSources };
      const bodyTeRef = body['task-executor-ref'] as ExecutionRef | undefined;
      const teRef = (bodyTeRef?.howToRun && bodyTeRef?.whatToRun ? bodyTeRef : undefined)
        ?? resolveTaskExecutorRef();
      for (let i = 0; i < enrichedSources.length; i++) {
        const src = enrichedSources[i];
        const bindTo = typeof src['bindTo'] === 'string' ? src['bindTo'] : `source_${i}`;
        if (!teRef) {
          sourceProbes.push({ bindTo, skipped: true, error: 'No task executor configured' });
          continue;
        }
        try {
          const inPayload = { ...src };
          const stdout = await adapter.invokeExecutor(teRef!, 'run-source-preflight',
            { timeout: (src['timeout'] as number | undefined) ?? adapter.executorTimeouts?.preflightMs ?? 60_000, input: JSON.stringify(inPayload) });
          const result = JSON.parse(stdout.trim()) as { ok: boolean; reachable: boolean; latencyMs?: number; error?: string; resultValue?: unknown };
          if (result.ok && !Object.prototype.hasOwnProperty.call(mockFetchedSources, bindTo) && Object.prototype.hasOwnProperty.call(result, 'resultValue')) {
            fetchedSources[bindTo] = result.resultValue;
          }
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
        const result = CardCompute.runSync(node, { sourcesData: fetchedSources });
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
        fetched_sources: fetchedSources,
        computed_values: computedValues,
        compute_errors: computeErrors,
      }) as CommandResult<SimulateResult>;
    } catch (e) { return err(e) as CommandResult<SimulateResult>; }
  }

  return {
    validateCardPreflight,
    probeSourcePreflight, runSourcePreflight,
    evalCardCompute,
    simulateCardCycle,
    describeTaskExecutorCapabilities,
    updatesInCardStore,
    readFromCardStore,
  };
}
