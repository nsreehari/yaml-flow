import type { TaskHandlerFn } from '../../continuous-event-graph/reactive.js';
import { createReactiveGraph } from '../../continuous-event-graph/reactive.js';
import { createLiveGraph, restore, snapshot } from '../../continuous-event-graph/core.js';
import type { GraphEvent } from '../../event-graph/types.js';
import { CardCompute } from '../../card-compute/index.js';
import type { ComputeNode, ComputeSource } from '../../card-compute/index.js';
import type { KindValueRef } from '../common/storage-interface.js';
import { parseRef, serializeRef } from '../common/storage-interface.js';
import { assertBoardCallbackTransport } from '../common/board-callback-transport.js';
import type {
  BoardSseOneShotPayload,
  CommandInput,
  CommandResult,
} from '../common/board-live-cards-public.js';
import type {
  BoardChangeNotification,
  BoardOutputNotification,
  NotificationEmitter,
  RuntimeNotification,
} from '../common/notification-interface.js';
import { withRuntimeNotificationBatchCategories, withRuntimeNotificationCategories } from '../common/notification-interface.js';
import {
  BOARD_GRAPH_KEY,
  EMPTY_CONFIG,
} from '../common/board-live-cards-public.js';
import type {
  BoardEnvelope,
  BoardStatusObject,
  CardRuntimeSnapshot,
  CardUpsertIndexEntry,
  ExecutionRequestEntry,
  LiveCard,
  SourceTokenPayload,
} from '../common/board-live-cards-lib.js';
import {
  buildBoardStatusObject,
  boardEnvelopeToSnapshotEntries,
  cardRuntimeKey,
  decideSourceAction,
  liveCardToTaskConfig,
  nextEntryAfterFetchDelivery,
  nextEntryAfterFetchFailure,
  normalizeSourceRuntimeEntry,
  snapshotEntriesToBoardEnvelope,
} from '../common/board-live-cards-lib.js';
import {
  createCardRuntimeStoreFromBacking,
  createExecutionRequestStoreFromBacking,
  createFetchedSourcesStoreFromBacking,
  createPublishedOutputsStoreFromBacking,
} from '../common/board-live-cards-shared-stores.js';
import {
  createAsyncJournalStoreFromStorage,
  createStateSnapshotAdapterFromKV,
  createStateSnapshotStoreFromAdapter,
} from '../common/board-live-cards-shared-snapshot-journal.js';
import type { ExecutionRef } from '../common/execution-interface.js';
import { createAsyncCardStorePublic } from './card-store-lib-public-async.js';
import type {
  AsyncBlobStorage,
  AsyncKVStorage,
} from './storage-async-interface.js';
import { withAsyncRelayLock } from './storage-async-interface.js';
import type {
  AsyncBoardConfigStore,
  AsyncBoardPlatformAdapter,
} from './board-platform-adapter-async.js';
import { createAsyncBoardConfigStore } from './board-platform-adapter-async.js';
import { createAsyncCardStorageAdapter, createAsyncCardStore, createAsyncJsonStorage } from './board-live-cards-storage-async.js';
import type { AsyncCardAdminStore } from './board-live-cards-storage-async.js';

export interface AsyncBoardLiveCardsPublic {
  init(input: CommandInput): Promise<CommandResult>;
  status(input: CommandInput): Promise<CommandResult<BoardStatusObject>>;
  getBoardRuntimeStoreRef(input: CommandInput): Promise<CommandResult<{ storeRef: string | null }>>;
  getCardStoreRef(input: CommandInput): Promise<CommandResult<{ storeRef: string }>>;
  getOutputsStoreRef(input: CommandInput): Promise<CommandResult<{ storeRef: string }>>;
  getScratchStoreRef(input: CommandInput): Promise<CommandResult<{ storeRef: string | null }>>;
  getChatStoreRef(input: CommandInput): Promise<CommandResult<{ storeRef: string | null }>>;
  getArtifactsStoreRef(input: CommandInput): Promise<CommandResult<{ storeRef: string | null }>>;
  getFetchedSourcesStoreRef(input: CommandInput): Promise<CommandResult<{ storeRef: string | null }>>;
  getConfig(input: CommandInput): Promise<CommandResult<{ value: unknown }>>;
  getOutputsDataObject(input: CommandInput): Promise<CommandResult>;
  getAllOutputsDataObjects(input: CommandInput): Promise<CommandResult<Record<string, unknown>>>;
  getOutputsComputedValues(input: CommandInput): Promise<CommandResult>;
  getAllOutputsComputedValues(input: CommandInput): Promise<CommandResult<Record<string, unknown>>>;
  getOutputsFetchedSources(input: CommandInput): Promise<CommandResult<Record<string, string>>>;
  getAllOutputsFetchedSources(input: CommandInput): Promise<CommandResult<Record<string, Record<string, string>>>>;
  buildSseOneShotPayload(input: CommandInput): Promise<CommandResult<BoardSseOneShotPayload>>;
  addCardFiles(input: CommandInput): Promise<CommandResult<{ cardId: string; files_added: Array<{ idx: number; entry: unknown }>; notified: true }>>;
  removeCard(input: CommandInput): Promise<CommandResult>;
  retrigger(input: CommandInput): Promise<CommandResult>;
  processAccumulatedEvents(input: CommandInput): Promise<CommandResult>;
  upsertCard(input: CommandInput): Promise<CommandResult>;
  taskFailed(input: CommandInput): Promise<CommandResult>;
  taskProgress(input: CommandInput): Promise<CommandResult>;
  sourceDataFetched(input: CommandInput): Promise<CommandResult>;
  sourceDataFetchFailure(input: CommandInput): Promise<CommandResult>;
}

export interface AsyncBoardLiveCardsPublicOptions {
  boardRuntimeStoreRef?: string;
  scratchStoreRef?: string;
  taskExecutorRef?: ExecutionRef;
  chatHandlerFlow?: unknown;
  emitNotification?: NotificationEmitter;
}

interface AsyncPublishedOutputsStore {
  writeComputedValues(cardId: string, values: Record<string, unknown>): Promise<void>;
  readComputedValues(cardId: string): Promise<unknown | null>;
  readAllComputedValues(): Promise<Record<string, unknown>>;
  writeDataObjects(data: Record<string, unknown>): Promise<void>;
  readDataObject(key: string): Promise<unknown | null>;
  readAllDataObjects(): Promise<Record<string, unknown>>;
  writeStatusSnapshot(status: unknown): Promise<void>;
  readStatusSnapshot(): Promise<unknown | null>;
}

interface AsyncCardRuntimeStore {
  readRuntime(cardId: string): Promise<CardRuntimeSnapshot>;
  writeRuntime(cardId: string, state: CardRuntimeSnapshot): Promise<void>;
}

interface AsyncFetchedSourcesStore {
  readSourceData(cardId: string, outputFile: string): Promise<unknown>;
  ingestSourceDataStaged(cardId: string, outputFile: string, ref: KindValueRef, deliveryToken: string): Promise<void>;
  commitSourceData(cardId: string, outputFile: string, deliveryToken: string): Promise<boolean>;
  hasSource(cardId: string, outputFile: string): Promise<boolean>;
  listSources(cardId: string): Promise<string[]>;
}

interface AsyncExecutionRequestStore {
  appendEntries(journalId: string, entries: ExecutionRequestEntry[]): Promise<void>;
  dispatchEntriesForJournalId(journalId: string, processorFn: (entry: ExecutionRequestEntry) => Promise<void>): Promise<void>;
}

function ok(): CommandResult;
function ok<T>(data: T): CommandResult<T>;
function ok<T>(data?: T): CommandResult<T> {
  return (data !== undefined ? { status: 'success', data } : { status: 'success' }) as CommandResult<T>;
}

function fail(error: string): CommandResult { return { status: 'fail', error }; }
function err(error: unknown): CommandResult { return { status: 'error', error: error instanceof Error ? error.message : String(error) }; }

const SYS_KEYS_BOARD_STATE = 'sys_keys_board_state';

function nowIso(): string { return new Date().toISOString(); }

function toBase64Url(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const binStr = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
  return btoa(binStr).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function fromBase64Url(str: string): string {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  const binStr = atob(padded);
  const bytes = Uint8Array.from(binStr, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function decodeCallbackToken(token: string): { taskName: string } | null {
  try {
    const payload = JSON.parse(fromBase64Url(token));
    return typeof payload?.t === 'string' ? { taskName: payload.t } : null;
  } catch {
    return null;
  }
}

type HostedSourceTokenPayload = SourceTokenPayload & { dt?: string };

function encodeSourceToken(payload: HostedSourceTokenPayload): string {
  return toBase64Url(JSON.stringify(payload));
}

function decodeSourceToken(token: string): HostedSourceTokenPayload | null {
  try {
    const payload = JSON.parse(fromBase64Url(token));
    if (typeof payload?.cbk === 'string' && typeof payload?.cid === 'string' && typeof payload?.b === 'string' && typeof payload?.d === 'string') {
      return payload as HostedSourceTokenPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function createAsyncCardRuntimeStore(kv: AsyncKVStorage): AsyncCardRuntimeStore {
  return createCardRuntimeStoreFromBacking(kv, cardRuntimeKey, () => ({ _sources: {} }));
}

function createAsyncFetchedSourcesStore(
  blob: AsyncBlobStorage,
  resolveRef: (ref: KindValueRef) => Promise<string>,
): AsyncFetchedSourcesStore {
  return createFetchedSourcesStoreFromBacking(blob, resolveRef);
}

function createAsyncPublishedOutputsStore(kv: AsyncKVStorage): AsyncPublishedOutputsStore {
  return createPublishedOutputsStoreFromBacking(kv);
}

function createAsyncExecutionRequestStore(
  kv: AsyncKVStorage,
  onDispatchFailed: (entry: ExecutionRequestEntry, error: string) => Promise<void>,
): AsyncExecutionRequestStore {
  return createExecutionRequestStoreFromBacking(kv, onDispatchFailed);
}

function createAsyncCardHandlerFn(
  baseRef: KindValueRef,
  journalId: string,
  adapters: {
    cardStore: AsyncCardAdminStore;
    cardRuntimeStore: AsyncCardRuntimeStore;
    fetchedSourcesStore: AsyncFetchedSourcesStore;
    outputStore: AsyncPublishedOutputsStore;
    executionRequestStore: AsyncExecutionRequestStore;
  },
  taskCompletedFn: (taskName: string, data: Record<string, unknown>) => void,
  writeComputedValuesFn?: (cardId: string, values: Record<string, unknown>) => void,
  writeDataObjectsFn?: (data: Record<string, unknown>) => void,
): TaskHandlerFn {
  return async (input) => {
    const pendingRequests: ExecutionRequestEntry[] = [];
    const card = await adapters.cardStore.readCard(input.nodeId);
    if (!card) return 'task-initiate-failure';

    const cardId = card.id as string;
    const cardState = (card.card_data ?? {}) as Record<string, unknown>;
    const allSources = (card.source_defs ?? []) as ComputeSource[];
    const requiredSources = allSources;

    let state = await adapters.cardRuntimeStore.readRuntime(cardId);
    let dirty = false;

    const flush = async (): Promise<void> => {
      if (!dirty) return;
      await adapters.cardRuntimeStore.writeRuntime(cardId, state);
      dirty = false;
    };

    const getSourceEntry = (outputFile: string) => normalizeSourceRuntimeEntry(state._sources[outputFile]);
    const setSourceEntry = (outputFile: string, entry: CardRuntimeSnapshot['_sources'][string]): void => {
      state._sources[outputFile] = normalizeSourceRuntimeEntry(entry);
      dirty = true;
    };

    const currentExecutionCount = input.taskState?.executionCount ?? 0;
    if (state._lastExecutionCount !== currentExecutionCount) {
      state._sources = {};
      state._lastExecutionCount = currentExecutionCount;
      dirty = true;
    }

    if (input.update) {
      const outputFile = input.update.outputFile as string;
      if (outputFile) {
        const entry = getSourceEntry(outputFile);
        if (input.update.failure) {
          const failureToken = (input.update.rqt as string | undefined) ?? entry.lastRequestedToken ?? entry.queueRequestedToken;
          if (failureToken) setSourceEntry(outputFile, nextEntryAfterFetchFailure(entry, failureToken));
        } else {
          const incomingRqt = input.update.rqt as string;
          if (!entry.lastCompletedToken || incomingRqt > entry.lastCompletedToken) {
            const deliveryToken = typeof input.update.deliveryToken === 'string' ? input.update.deliveryToken : undefined;
            const committed = deliveryToken ? await adapters.fetchedSourcesStore.commitSourceData(cardId, outputFile, deliveryToken) : false;
            setSourceEntry(outputFile, committed
              ? nextEntryAfterFetchDelivery(entry, incomingRqt)
              : nextEntryAfterFetchFailure(entry, incomingRqt));
          }
        }
        await flush();
      }
    }

    const sourcesData: Record<string, unknown> = {};
    for (const src of allSources) {
      if (!src.outputFile) continue;
      const content = await adapters.fetchedSourcesStore.readSourceData(cardId, src.outputFile);
      if (content !== null) sourcesData[src.bindTo] = content;
    }

    const requires: Record<string, unknown> = {};
    for (const [token, taskData] of Object.entries(input.state ?? {})) {
      if (taskData !== null && typeof taskData === 'object' && !Array.isArray(taskData)) {
        const unwrapped = (taskData as Record<string, unknown>)[token];
        requires[token] = unwrapped !== undefined ? unwrapped : taskData;
      } else {
        requires[token] = taskData;
      }
    }

    const computeNode: ComputeNode = {
      id: cardId,
      card_data: { ...cardState },
      requires,
      source_defs: allSources,
      compute: card.compute as never,
    };
    computeNode._sourcesData = sourcesData;
    if (card.compute) CardCompute.runSync(computeNode, { sourcesData });

    (writeComputedValuesFn ?? (() => undefined))(cardId, computeNode.computed_values ?? {});

    const enrichedSources = CardCompute.enrichSourcesSync(
      Array.isArray(card.source_defs) ? card.source_defs : undefined,
      { card_data: card.card_data as Record<string, unknown>, requires },
    );
    const enrichedCard = {
      ...card,
      source_defs: Array.isArray(enrichedSources)
        ? enrichedSources.map((src) => ({
            ...src,
            boardDir: typeof src.boardDir === 'string' && src.boardDir ? src.boardDir : baseRef.value,
          }))
        : enrichedSources,
    };

    const now = nowIso();
    const runQueuedToken = input.update ? undefined : now;

    const undeliveredRequired = requiredSources.filter((src) => {
      const outputFile = src.outputFile;
      if (typeof outputFile !== 'string' || !outputFile) return true;
      let entry = getSourceEntry(outputFile);
      if (runQueuedToken) {
        entry = { ...entry, queueRequestedToken: runQueuedToken };
        setSourceEntry(outputFile, entry);
      }
      const queueRequestedToken = entry.queueRequestedToken ?? entry.lastRequestedToken ?? now;
      const action = decideSourceAction(entry, queueRequestedToken);
      return action === 'dispatch';
    });

    await flush();

    if (undeliveredRequired.length > 0) {
      let stampedAny = false;
      let dispatchRqt = now;
      for (const src of undeliveredRequired) {
        const outputFile = src.outputFile;
        if (typeof outputFile !== 'string' || !outputFile) continue;
        const entry = getSourceEntry(outputFile);
        const queuedAt = entry.queueRequestedToken ?? now;
        setSourceEntry(outputFile, { ...entry, lastRequestedToken: queuedAt });
        dispatchRqt = queuedAt;
        stampedAny = true;
      }
      if (stampedAny) await flush();
      if (!stampedAny) return 'task-initiated';

      pendingRequests.push({
        taskKind: 'source-fetch',
        payload: {
          boardRef: serializeRef(baseRef),
          enrichedCard: enrichedCard as Record<string, unknown>,
          callbackToken: input.callbackToken,
          rqt: dispatchRqt,
        },
      });
      await adapters.executionRequestStore.appendEntries(journalId, pendingRequests);
      return 'task-initiated';
    }

    const anyRequiredInFlight = requiredSources.some((src) => {
      const outputFile = src.outputFile;
      if (typeof outputFile !== 'string' || !outputFile) return false;
      const entry = getSourceEntry(outputFile);
      const queueRequestedToken = entry.queueRequestedToken ?? entry.lastRequestedToken ?? now;
      return decideSourceAction(entry, queueRequestedToken) === 'in-flight';
    });
    if (anyRequiredInFlight) return 'task-initiated';

    const providesBindings = (card.provides ?? []) as Array<{ bindTo: string; ref: string }>;
    const data: Record<string, unknown> = {};
    for (const { bindTo, ref } of providesBindings) data[bindTo] = CardCompute.resolve(computeNode, ref);

    (writeDataObjectsFn ?? (() => undefined))(data);

    taskCompletedFn(input.nodeId, data);
    if (pendingRequests.length > 0) await adapters.executionRequestStore.appendEntries(journalId, pendingRequests);
    return 'task-initiated';
  };
}

export function createAsyncBoardLiveCardsPublic(
  baseRef: KindValueRef,
  adapter: AsyncBoardPlatformAdapter,
  options: AsyncBoardLiveCardsPublicOptions = {},
): AsyncBoardLiveCardsPublic {
  assertBoardCallbackTransport(adapter.callbackTransport, 'createAsyncBoardLiveCardsPublic');
  const callbackTransport = adapter.callbackTransport;
  const warn = adapter.warn ?? (() => undefined);
  const boardPath = serializeRef(baseRef);
  const emitNotification = options.emitNotification ?? ((notification: RuntimeNotification | import('../common/notification-interface.js').RuntimeNotificationBatch) => {
    if (!adapter.publishBoardChangeNotifications) return undefined;
    const notifications = notification.kind === 'notification-batch'
      ? notification.notifications as BoardChangeNotification[]
      : [notification as BoardChangeNotification];
    return adapter.publishBoardChangeNotifications(notifications);
  });
  let drainInFlight: Promise<CommandResult> | null = null;
  let runtimeStoreRef = options.boardRuntimeStoreRef;
  let scratchStoreRef = options.scratchStoreRef;
  const hostedTaskExecutorRef = options.taskExecutorRef;
  const hostedChatHandlerFlow = options.chatHandlerFlow;

  function requireBoardRuntimeStoreRef(): string {
    if (!runtimeStoreRef) throw new Error(`Board at ${baseRef.value} has no board runtime store configured. Pass boardRuntimeStoreRef at construction or init.`);
    return runtimeStoreRef;
  }

  function flushBoardChangeNotifications(notifications: BoardChangeNotification[]): Promise<void> | undefined {
    if (notifications.length === 0) return undefined;
    try {
      const normalized = withRuntimeNotificationCategories(notifications as RuntimeNotification[]) as BoardChangeNotification[];
      const batch = withRuntimeNotificationBatchCategories({ kind: 'notification-batch', notifications: normalized as RuntimeNotification[] });
      return Promise.resolve(emitNotification(batch)).catch((error) => {
        warn(`[async-board-live-cards-public] emitNotification failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } catch (error) {
      warn(`[async-board-live-cards-public] emitNotification failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  const configStore = (): AsyncBoardConfigStore => createAsyncBoardConfigStore(adapter.kvStorageForRef(requireBoardRuntimeStoreRef()));
  const boardScopeId = baseRef.value;
  const stateSnapshotStore = () => createStateSnapshotStoreFromAdapter(
    createStateSnapshotAdapterFromKV(() => adapter.kvStorageForRef(requireBoardRuntimeStoreRef()), adapter.hashFn),
    'v1',
  );
  const outputStore = async (): Promise<AsyncPublishedOutputsStore> => {
    const ref = await configStore().readOutputsStoreRef();
    if (!ref) throw new Error(`Board at ${baseRef.value} has no outputs store configured.`);
    return createAsyncPublishedOutputsStore(adapter.kvStorageForRef(ref));
  };
  const cardStore = async (): Promise<AsyncCardAdminStore> => {
    const ref = await configStore().readCardStoreRef();
    if (!ref) throw new Error(`Board at ${baseRef.value} has no card store configured.`);
    const kv = adapter.kvStorageForRef(ref);
    return createAsyncCardStore(createAsyncCardStorageAdapter(createAsyncJsonStorage(kv), adapter.hashFn), warn);
  };
  async function boardExists(): Promise<boolean> {
    return Boolean((await stateSnapshotStore().readSnapshot(boardScopeId)).values[BOARD_GRAPH_KEY]);
  }

  async function loadEnvelope(): Promise<BoardEnvelope> {
    const snapshotRead = await stateSnapshotStore().readSnapshot(boardScopeId);
    if (!snapshotRead.values[BOARD_GRAPH_KEY]) throw new Error(`Board not initialized at ${baseRef.value}`);
    return snapshotEntriesToBoardEnvelope(snapshotRead.values);
  }

  async function commitEnvelope(envelope: BoardEnvelope, expectedVersion: string | null): Promise<void> {
    const result = await stateSnapshotStore().commitSnapshot(boardScopeId, {
      schemaVersion: 'v1',
      expectedVersion,
      deleteKeys: [],
      shallowMerge: boardEnvelopeToSnapshotEntries(envelope),
    });
    if (!result.ok) {
      throw new Error(`Snapshot commit failed (version mismatch): expected=${expectedVersion ?? 'null'} current=${result.currentVersion ?? 'null'}`);
    }
  }

  const journalStore = () => createAsyncJournalStoreFromStorage<GraphEvent>(adapter.journalStorageForRef(requireBoardRuntimeStoreRef()));

  async function resolveTaskExecutorRef(): Promise<ExecutionRef | undefined> {
    return hostedTaskExecutorRef ?? await configStore().readTaskExecutorRef();
  }

  function isControlplaneOnlyCard(card: unknown): boolean {
    if (!card || typeof card !== 'object' || Array.isArray(card)) return false;
    const priv = (card as { __private?: unknown }).__private;
    return !!priv
      && typeof priv === 'object'
      && !Array.isArray(priv)
      && (priv as Record<string, unknown>).visible_controlplane_only === true;
  }

  async function buildSysKeysBoardState(dataObjects: Record<string, unknown>): Promise<{ card_ids: string[]; data_object_keys: string[] }> {
    const cards = await (await cardStore()).readAllCards();
    const cardIds = [...new Set(
      cards
        .filter((card) => !isControlplaneOnlyCard(card))
        .map((card) => card.id)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    )].sort();
    const dataObjectKeys = [...new Set(
      Object.keys(dataObjects).filter((key) => key && key !== SYS_KEYS_BOARD_STATE),
    )].sort();
    return {
      card_ids: cardIds,
      data_object_keys: dataObjectKeys,
    };
  }

  async function readBoardDataObjects(): Promise<Record<string, unknown>> {
    const storedDataObjects = await (await outputStore()).readAllDataObjects();
    return {
      ...storedDataObjects,
      [SYS_KEYS_BOARD_STATE]: await buildSysKeysBoardState(storedDataObjects),
    };
  }

  async function appendJournalEvent(event: GraphEvent): Promise<void> {
    await journalStore().appendEvent(event);
  }

  async function fetchedSourcesStoreRef(): Promise<string> {
    const ref = await configStore().readFetchedSourcesStoreRef();
    if (!ref) throw new Error(`Board at ${baseRef.value} has no fetched sources store configured. Run: init --fetched-sources-store-ref <b64-ref>`);
    return ref;
  }

  async function fetchedSourcesBlobStore(): Promise<AsyncBlobStorage> {
    return adapter.blobStorageForRef(await fetchedSourcesStoreRef());
  }

  async function createFetchedSourcesStoreForRuntime(): Promise<AsyncFetchedSourcesStore> {
    return createAsyncFetchedSourcesStore(await fetchedSourcesBlobStore(), (ref) => adapter.resolveBlob(ref));
  }

  async function toSourceRef(blobKey: string): Promise<string> {
    const keyRef = (await fetchedSourcesBlobStore()).keyRef?.(blobKey);
    if (!keyRef) throw new Error('configured fetched-sources store does not support keyRef');
    const ref = await Promise.resolve(keyRef);
    return serializeRef(ref);
  }

  async function drainCycle(): Promise<void> {
    const executionRequestStore = createAsyncExecutionRequestStore(adapter.kvStorageForRef(requireBoardRuntimeStoreRef()), async (entry, error) => {
      const payload = entry.payload as Record<string, unknown>;
      const enriched = (payload.enrichedCard ?? {}) as Record<string, unknown>;
      const taskName = (enriched.id ?? payload.cardId ?? 'unknown') as string;
      await appendJournalEvent({ type: 'task-failed', taskName, error, timestamp: nowIso() });
    });

    const realCardRuntimeStore = createAsyncCardRuntimeStore(adapter.kvStorageForRef(requireBoardRuntimeStoreRef()));
    const fetchedSourcesBlob = await fetchedSourcesBlobStore();
    const realFetchedSourcesStore = await createFetchedSourcesStoreForRuntime();
    const resolvedCardStore = await cardStore();
    const resolvedOutputStore = await outputStore();

    const runtimeOverlay = new Map<string, CardRuntimeSnapshot>();
    const sourceOverlay = new Map<string, unknown>();
    const sourceCommits: Array<{ cardId: string; outputFile: string; deliveryToken: string }> = [];
    const computedWrites: Array<{ cardId: string; values: Record<string, unknown> }> = [];
    const dataWrites: Record<string, unknown>[] = [];
    const refreshedCards = new Map<string, LiveCard>();
    const removedCards = new Set<string>();

    const overlayCardRuntimeStore: AsyncCardRuntimeStore = {
      async readRuntime(cardId: string): Promise<CardRuntimeSnapshot> {
        return runtimeOverlay.get(cardId) ?? await realCardRuntimeStore.readRuntime(cardId);
      },
      async writeRuntime(cardId: string, state: CardRuntimeSnapshot): Promise<void> {
        runtimeOverlay.set(cardId, state);
        runtimeByCardId[cardId] = state;
      },
    };

    const overlayFetchedSourcesStore: AsyncFetchedSourcesStore = {
      async readSourceData(cardId: string, outputFile: string): Promise<unknown> {
        const key = `${cardId}/${outputFile}`;
        return sourceOverlay.has(key) ? sourceOverlay.get(key) : await realFetchedSourcesStore.readSourceData(cardId, outputFile);
      },
      ingestSourceDataStaged(cardId: string, outputFile: string, ref: KindValueRef, deliveryToken: string): Promise<void> {
        return realFetchedSourcesStore.ingestSourceDataStaged(cardId, outputFile, ref, deliveryToken);
      },
      async commitSourceData(cardId: string, outputFile: string, deliveryToken: string): Promise<boolean> {
        const stagedKey = `${cardId}/.staged/${deliveryToken}/${outputFile}`;
        let content = await fetchedSourcesBlob.read(stagedKey);
        if (content == null) {
          const stagedRef = await Promise.resolve(fetchedSourcesBlob.keyRef?.(stagedKey));
          if (stagedRef) content = await adapter.resolveBlob(stagedRef);
        }
        if (content == null) return false;
        const key = `${cardId}/${outputFile}`;
        const trimmed = content.trim();
        try { sourceOverlay.set(key, JSON.parse(trimmed)); } catch { sourceOverlay.set(key, trimmed); }
        sourceCommits.push({ cardId, outputFile, deliveryToken });
        return true;
      },
      async hasSource(cardId: string, outputFile: string): Promise<boolean> {
        const key = `${cardId}/${outputFile}`;
        return sourceOverlay.has(key) || await realFetchedSourcesStore.hasSource(cardId, outputFile);
      },
      async listSources(cardId: string): Promise<string[]> {
        const real = await realFetchedSourcesStore.listSources(cardId);
        const overlay = [...sourceOverlay.keys()]
          .filter((key) => key.startsWith(`${cardId}/`))
          .map((key) => key.slice(`${cardId}/`.length));
        return [...new Set([...real, ...overlay])];
      },
    };

    const envelope = await loadEnvelope();
    const live = restore(envelope.graph);
    const runtimeByCardId: Record<string, CardRuntimeSnapshot> = { ...envelope.runtimeByCardId };
    const { events: undrained, newCursor } = await journalStore().readEntriesAfterCursor(envelope.lastDrainedJournalId);
    let tx: GraphEvent[] = undrained;

    const rg = createReactiveGraph(live, {
      handlers: {
        'card-handler': createAsyncCardHandlerFn(
          baseRef,
          newCursor,
          {
            cardStore: resolvedCardStore,
            cardRuntimeStore: overlayCardRuntimeStore,
            fetchedSourcesStore: overlayFetchedSourcesStore,
            outputStore: resolvedOutputStore,
            executionRequestStore,
          },
          (taskName, data) => {
            tx.push({ type: 'task-completed', taskName, data, timestamp: nowIso() } as GraphEvent);
          },
          (cardId, values) => { computedWrites.push({ cardId, values }); },
          (data) => { dataWrites.push(data); },
        ),
      },
      onNodeRemoved: (cardId) => {
        refreshedCards.delete(cardId);
        runtimeOverlay.delete(cardId);
        delete runtimeByCardId[cardId];
        removedCards.add(cardId);
      },
    });

    while (tx.length > 0) {
      const pending = tx;
      tx = [];
      for (const event of pending) {
        if (event.type === 'task-restart') {
          const card = await resolvedCardStore.readCard(event.taskName as string);
          if (card) refreshedCards.set(event.taskName as string, card);
        }
      }
      rg.pushAll(pending);
      await rg.waitForHandlers();
    }

    const finalLive = rg.getState();
    await rg.dispose({ wait: true });

    await commitEnvelope({ lastDrainedJournalId: newCursor, graph: snapshot(finalLive), runtimeByCardId }, (await stateSnapshotStore().readSnapshot(boardScopeId)).version);

    for (const { cardId, values } of computedWrites) await resolvedOutputStore.writeComputedValues(cardId, values);
    for (const data of dataWrites) await resolvedOutputStore.writeDataObjects(data);
    for (const [cardId, state] of runtimeOverlay) await realCardRuntimeStore.writeRuntime(cardId, state);
    for (const staged of sourceCommits) await realFetchedSourcesStore.commitSourceData(staged.cardId, staged.outputFile, staged.deliveryToken);

    const statusObj = buildBoardStatusObject(boardPath, finalLive);
    await resolvedOutputStore.writeStatusSnapshot(statusObj);

    const notifications: BoardChangeNotification[] = [];
    for (const { cardId, values } of computedWrites) notifications.push({ kind: 'computed_values', cardId, values } satisfies BoardOutputNotification);
    for (const data of dataWrites) {
      for (const [key, payload] of Object.entries(data)) notifications.push({ kind: 'data_object', key, payload } satisfies BoardOutputNotification);
    }
    for (const [cardId, card] of refreshedCards) notifications.push({ kind: 'card_refreshed', cardId, card });
    for (const cardId of removedCards) notifications.push({ kind: 'card_removed', cardId });
    notifications.push({ kind: 'status', status: statusObj } satisfies BoardOutputNotification);
    await flushBoardChangeNotifications(notifications);

    const executorRef = await resolveTaskExecutorRef();
    if (!executorRef) return;
    const useDirectHostedWorkerRequest = adapter.supportsDirectSourceOutput?.(executorRef) === true;
    await executionRequestStore.dispatchEntriesForJournalId(newCursor, async (entry) => {
      if (entry.taskKind !== 'source-fetch') {
        warn(`[async-process-accumulated-events] unknown taskKind "${entry.taskKind}" — skipping`);
        return;
      }
      const payload = entry.payload as { enrichedCard: Record<string, unknown>; callbackToken: string; rqt: string };
      const cardId = (payload.enrichedCard?.id as string | undefined) ?? 'unknown';
      const sourceDefs = (payload.enrichedCard?.source_defs ?? []) as Array<{ bindTo: string; outputFile?: string; [key: string]: unknown }>;

      if (executorRef.howToRun === 'queue-storage' && useDirectHostedWorkerRequest) {
        try {
          const queueStoreRef = await configStore().readQueueStoreRef();
          if (!queueStoreRef) throw new Error(`Board at ${baseRef.value} has no queue store configured. Run: init --queue-store-ref <b64-ref>`);
          const queue = adapter.queueStorageForRef(queueStoreRef, 'task-executor');
          const boardId = typeof executorRef.extra?.boardId === 'string' ? executorRef.extra.boardId : undefined;
          const requests: Array<{ boardId?: string; ref: typeof executorRef; args: Record<string, unknown> }> = [];
          for (const src of sourceDefs) {
            if (!src.outputFile) continue;
            const deliveryToken = adapter.genId();
            const stagedKey = `${cardId}/.staged/${deliveryToken}/${src.outputFile}`;
            const stagedRef = await Promise.resolve(fetchedSourcesBlob.keyRef?.(stagedKey));
            if (!stagedRef) continue;
            const directOutput = { ref: serializeRef(stagedRef), deliveryToken, outputFile: src.outputFile, cardId };
            const sourceToken = encodeSourceToken({
              cbk: payload.callbackToken,
              rg: baseRef.value,
              br: serializeRef(baseRef),
              cid: cardId,
              b: src.bindTo,
              d: src.outputFile,
              cs: undefined,
              rqt: payload.rqt,
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
          if (requests.length > 0) await queue.enqueueMany(requests);
        } catch (error) {
          await appendJournalEvent({ type: 'task-failed', taskName: cardId, error: error instanceof Error ? error.message : String(error), timestamp: nowIso() });
        }
        return;
      }

      for (const src of sourceDefs) {
        if (!src.outputFile) continue;
        let directOutput: { ref: string; deliveryToken: string; outputFile: string; cardId: string } | undefined;
        if (useDirectHostedWorkerRequest) {
          const deliveryToken = adapter.genId();
          const stagedKey = `${cardId}/.staged/${deliveryToken}/${src.outputFile}`;
          const stagedRef = await Promise.resolve(fetchedSourcesBlob.keyRef?.(stagedKey));
          if (stagedRef) {
            directOutput = { ref: serializeRef(stagedRef), deliveryToken, outputFile: src.outputFile, cardId };
          }
        }
        const sourceToken = encodeSourceToken({
          cbk: payload.callbackToken,
          rg: baseRef.value,
          br: serializeRef(baseRef),
          cid: cardId,
          b: src.bindTo,
          d: src.outputFile,
          cs: undefined,
          rqt: payload.rqt,
          ...(directOutput ? { dt: directOutput.deliveryToken } : {}),
        });
        const result = await adapter.dispatchExecution(executorRef, {
          source_def: src,
          base_ref: serializeRef(baseRef),
          callback: callbackTransport.createCallback(sourceToken),
          ...(directOutput ? { output: directOutput } : {}),
        });
        if (!result.dispatched) {
          await appendJournalEvent({ type: 'task-failed', taskName: cardId, error: result.error ?? 'dispatch failed', timestamp: nowIso() });
        }
      }
    });
  }

  async function drainOnce(): Promise<CommandResult> {
    try {
      const continuation = async () => {
        const envelope = await loadEnvelope();
        const { events } = await journalStore().readEntriesAfterCursor(envelope.lastDrainedJournalId);
        if (events.length > 0) {
          await requestQueuedProcessAccumulated();
        }
      };
      const ran = await withAsyncRelayLock(adapter.lock, drainCycle, continuation);
      return ok({ ran: ran !== false }) as CommandResult;
    } catch (error) {
      return err(error);
    }
  }

  async function drain(): Promise<CommandResult> {
    if (drainInFlight) return drainInFlight;
    drainInFlight = drainOnce().finally(() => {
      drainInFlight = null;
    });
    return drainInFlight;
  }

  async function requestQueuedProcessAccumulated(): Promise<void> {
    const ref = await configStore().readQueueStoreRef();
    if (!ref) throw new Error(`Board at ${baseRef.value} has no queue store configured. Run: init --queue-store-ref <b64-ref>`);
    const queue = adapter.queueStorageForRef(ref, 'process-accumulated');
    if (queue.enqueueIfAbsent) {
      await queue.enqueueIfAbsent({ boardRef: serializeRef(baseRef) }, `process-accumulated:${serializeRef(baseRef)}`);
    } else {
      await queue.enqueue({ boardRef: serializeRef(baseRef) });
    }
    await adapter.requestProcessAccumulated?.();
  }

  async function clearQueuedProcessAccumulatedWakeups(): Promise<void> {
    const ref = await configStore().readQueueStoreRef();
    if (!ref) throw new Error(`Board at ${baseRef.value} has no queue store configured. Run: init --queue-store-ref <b64-ref>`);
    const queue = adapter.queueStorageForRef(ref, 'process-accumulated');
    while (true) {
      const leased = await queue.lease<{ boardRef?: string }>({ max: 64, visibilityMs: 1_000 });
      if (leased.length <= 0) return;
      for (const message of leased) {
        await queue.ack(message.id, message.leaseToken);
      }
      if (leased.length < 64) return;
    }
  }

  function drainFireAndForget(): void {
    void requestQueuedProcessAccumulated();
  }

  return {
    async init(input: CommandInput): Promise<CommandResult> {
      try {
        const storeRef = input.params?.['cardStoreRef'] as string | undefined;
        if (!storeRef) return fail('init requires params.cardStoreRef');
        runtimeStoreRef = input.params?.['boardRuntimeStoreRef'] as string | undefined;
        if (!runtimeStoreRef) return fail('init requires params.boardRuntimeStoreRef');
        const outputsStoreRef = input.params?.['outputsStoreRef'] as string | undefined;
        if (!outputsStoreRef) return fail('init requires params.outputsStoreRef');
        const queueStoreRefValue = input.params?.['queueStoreRef'] as string | undefined;
        if (!queueStoreRefValue) return fail('init requires params.queueStoreRef');
        const fetchedSourcesStoreRef = input.params?.['fetchedSourcesStoreRef'] as string | undefined;
        if (!fetchedSourcesStoreRef) return fail('init requires params.fetchedSourcesStoreRef');
        scratchStoreRef = input.params?.['scratchStoreRef'] as string | undefined;
        const chatStoreRef = input.params?.['chatStoreRef'] as string | undefined;
        if (!chatStoreRef) return fail('init requires params.chatStoreRef');
        const artifactsStoreRef = input.params?.['artifactsStoreRef'] as string | undefined;
        if (!artifactsStoreRef) return fail('init requires params.artifactsStoreRef');
        if (!await boardExists()) {
          await commitEnvelope({ lastDrainedJournalId: '', graph: snapshot(createLiveGraph(EMPTY_CONFIG)), runtimeByCardId: {} }, null);
        }
        const cfg = configStore();
        await cfg.writeBoardRuntimeStoreRef(runtimeStoreRef);
        await cfg.writeCardStoreRef(storeRef);
        await cfg.writeOutputsStoreRef(outputsStoreRef);
        await cfg.writeQueueStoreRef(queueStoreRefValue);
        await cfg.writeFetchedSourcesStoreRef(fetchedSourcesStoreRef);
        await cfg.writeChatStoreRef(chatStoreRef);
        await cfg.writeArtifactsStoreRef(artifactsStoreRef);
        await (await outputStore()).writeStatusSnapshot(buildBoardStatusObject(boardPath, restore((await loadEnvelope()).graph)));
        return ok();
      } catch (error) {
        return err(error);
      }
    },

    async status(_input: CommandInput): Promise<CommandResult<BoardStatusObject>> {
      try {
        const outputs = await outputStore();
        let statusObj = await outputs.readStatusSnapshot() as BoardStatusObject | null;
        if (!statusObj) {
          statusObj = buildBoardStatusObject(boardPath, restore((await loadEnvelope()).graph));
          await outputs.writeStatusSnapshot(statusObj);
        }
        return ok(statusObj) as CommandResult<BoardStatusObject>;
      } catch (error) {
        return err(error) as CommandResult<BoardStatusObject>;
      }
    },

    async getCardStoreRef(_input: CommandInput): Promise<CommandResult<{ storeRef: string }>> {
      try {
        const storeRef = await configStore().readCardStoreRef();
        if (!storeRef) return fail(`Board at ${baseRef.value} has no card store configured`) as CommandResult<{ storeRef: string }>;
        return ok({ storeRef }) as CommandResult<{ storeRef: string }>;
      } catch (error) {
        return err(error) as CommandResult<{ storeRef: string }>;
      }
    },

    async getBoardRuntimeStoreRef(_input: CommandInput): Promise<CommandResult<{ storeRef: string | null }>> {
      try {
        return ok({ storeRef: runtimeStoreRef ?? null }) as CommandResult<{ storeRef: string | null }>;
      } catch (error) {
        return err(error) as CommandResult<{ storeRef: string | null }>;
      }
    },

    async getOutputsStoreRef(_input: CommandInput): Promise<CommandResult<{ storeRef: string }>> {
      try {
        const storeRef = await configStore().readOutputsStoreRef();
        if (!storeRef) return fail(`Board at ${baseRef.value} has no outputs store configured`) as CommandResult<{ storeRef: string }>;
        return ok({ storeRef }) as CommandResult<{ storeRef: string }>;
      } catch (error) {
        return err(error) as CommandResult<{ storeRef: string }>;
      }
    },

    async getScratchStoreRef(_input: CommandInput): Promise<CommandResult<{ storeRef: string | null }>> {
      try {
        return ok({ storeRef: scratchStoreRef ?? null }) as CommandResult<{ storeRef: string | null }>;
      } catch (error) {
        return err(error) as CommandResult<{ storeRef: string | null }>;
      }
    },

    async getChatStoreRef(_input: CommandInput): Promise<CommandResult<{ storeRef: string | null }>> {
      try {
        return ok({ storeRef: await configStore().readChatStoreRef() }) as CommandResult<{ storeRef: string | null }>;
      } catch (error) {
        return err(error) as CommandResult<{ storeRef: string | null }>;
      }
    },

    async getArtifactsStoreRef(_input: CommandInput): Promise<CommandResult<{ storeRef: string | null }>> {
      try {
        return ok({ storeRef: await configStore().readArtifactsStoreRef() }) as CommandResult<{ storeRef: string | null }>;
      } catch (error) {
        return err(error) as CommandResult<{ storeRef: string | null }>;
      }
    },

    async getFetchedSourcesStoreRef(_input: CommandInput): Promise<CommandResult<{ storeRef: string | null }>> {
      try {
        return ok({ storeRef: await configStore().readFetchedSourcesStoreRef() }) as CommandResult<{ storeRef: string | null }>;
      } catch (error) {
        return err(error) as CommandResult<{ storeRef: string | null }>;
      }
    },

    async getConfig(input: CommandInput): Promise<CommandResult<{ value: unknown }>> {
      try {
        const key = input.params?.['key'] as string | undefined;
        if (!key) return fail('getConfig requires params.key') as CommandResult<{ value: unknown }>;
        const cfg = configStore();
        let value: unknown;
        switch (key) {
          case 'task-executor': value = hostedTaskExecutorRef ?? null; break;
          case 'chat-handler-flow': value = hostedChatHandlerFlow ?? null; break;
          case 'board-runtime-store-ref': value = await cfg.readBoardRuntimeStoreRef(); break;
          case 'card-store-ref': value = await cfg.readCardStoreRef(); break;
          case 'outputs-store-ref': value = await cfg.readOutputsStoreRef(); break;
          case 'scratch-store-ref': value = scratchStoreRef ?? null; break;
          case 'chat-store-ref': value = await cfg.readChatStoreRef(); break;
          case 'artifacts-store-ref': value = await cfg.readArtifactsStoreRef(); break;
          case 'fetched-sources-store-ref': value = await cfg.readFetchedSourcesStoreRef(); break;
          default: return fail(`getConfig: unknown key "${key}"`) as CommandResult<{ value: unknown }>;
        }
        return ok({ value }) as CommandResult<{ value: unknown }>;
      } catch (error) {
        return err(error) as CommandResult<{ value: unknown }>;
      }
    },

    async getOutputsDataObject(input: CommandInput): Promise<CommandResult> {
      try {
        const key = input.params?.['key'] as string | undefined;
        if (!key) return fail('getOutputsDataObject requires params.key');
        const dataObjects = await readBoardDataObjects();
        return ok(dataObjects[key] ?? null);
      } catch (error) {
        return err(error);
      }
    },

    async getAllOutputsDataObjects(_input: CommandInput): Promise<CommandResult<Record<string, unknown>>> {
      try {
        return ok(await readBoardDataObjects()) as CommandResult<Record<string, unknown>>;
      } catch (error) {
        return err(error) as CommandResult<Record<string, unknown>>;
      }
    },

    async getOutputsComputedValues(input: CommandInput): Promise<CommandResult> {
      try {
        const key = input.params?.['key'] as string | undefined;
        if (!key) return fail('getOutputsComputedValues requires params.key');
        return ok(await (await outputStore()).readComputedValues(key));
      } catch (error) {
        return err(error);
      }
    },

    async getAllOutputsComputedValues(_input: CommandInput): Promise<CommandResult<Record<string, unknown>>> {
      try {
        return ok(await (await outputStore()).readAllComputedValues()) as CommandResult<Record<string, unknown>>;
      } catch (error) {
        return err(error) as CommandResult<Record<string, unknown>>;
      }
    },

    async getOutputsFetchedSources(input: CommandInput): Promise<CommandResult<Record<string, string>>> {
      try {
        const key = input.params?.['key'] as string | undefined;
        if (!key) return fail('getOutputsFetchedSources requires params.key') as CommandResult<Record<string, string>>;
        const files = await (await createFetchedSourcesStoreForRuntime()).listSources(key);
        const result: Record<string, string> = {};
        for (const outputFile of files) result[outputFile] = await toSourceRef(`${key}/${outputFile}`);
        return ok(result) as CommandResult<Record<string, string>>;
      } catch (error) {
        return err(error) as CommandResult<Record<string, string>>;
      }
    },

    async getAllOutputsFetchedSources(_input: CommandInput): Promise<CommandResult<Record<string, Record<string, string>>>> {
      try {
        const store = await createFetchedSourcesStoreForRuntime();
        const blobKeys = await (await fetchedSourcesBlobStore()).listKeys();
        const cardIds = new Set<string>();
        for (const key of blobKeys) {
          const slash = key.indexOf('/');
          if (slash > 0 && !key.includes('/.staged/')) cardIds.add(key.slice(0, slash));
        }
        const result: Record<string, Record<string, string>> = {};
        for (const cardId of cardIds) {
          const files = await store.listSources(cardId);
          if (files.length === 0) continue;
          result[cardId] = {};
          for (const outputFile of files) result[cardId][outputFile] = await toSourceRef(`${cardId}/${outputFile}`);
        }
        return ok(result) as CommandResult<Record<string, Record<string, string>>>;
      } catch (error) {
        return err(error) as CommandResult<Record<string, Record<string, string>>>;
      }
    },

    async buildSseOneShotPayload(_input: CommandInput): Promise<CommandResult<BoardSseOneShotPayload>> {
      try {
        const cardDefinitions = await (await cardStore()).readAllCards() as Array<Record<string, unknown>>;
        const statusResult = await this.status({});
        if (statusResult.status !== 'success') return statusResult as unknown as CommandResult<BoardSseOneShotPayload>;

        const dataObjectsResult = await this.getAllOutputsDataObjects({});
        if (dataObjectsResult.status !== 'success') return dataObjectsResult as unknown as CommandResult<BoardSseOneShotPayload>;

        const computedValuesResult = await this.getAllOutputsComputedValues({});
        if (computedValuesResult.status !== 'success') return computedValuesResult as unknown as CommandResult<BoardSseOneShotPayload>;

        const computedValues = computedValuesResult.data;
        const cardRuntimeById: Record<string, unknown> = {};
        for (const cardDef of cardDefinitions) {
          const id = typeof cardDef?.id === 'string' ? cardDef.id : null;
          if (!id) continue;
          const cardData = cardDef.card_data && typeof cardDef.card_data === 'object' && !Array.isArray(cardDef.card_data)
            ? cardDef.card_data as Record<string, unknown>
            : {};
          cardRuntimeById[id] = {
            schema_version: 'v1',
            card_id: id,
            card_data: { ...cardData },
            computed_values: computedValues[id] && typeof computedValues[id] === 'object'
              ? computedValues[id]
              : {},
          };
        }

        return ok({
          cardDefinitions,
          statusSnapshot: statusResult.data,
          dataObjectsByToken: dataObjectsResult.data,
          cardRuntimeById,
        }) as CommandResult<BoardSseOneShotPayload>;
      } catch (error) {
        return err(error) as CommandResult<BoardSseOneShotPayload>;
      }
    },

    async addCardFiles(input: CommandInput): Promise<CommandResult<{ cardId: string; files_added: Array<{ idx: number; entry: unknown }>; notified: true }>> {
      type R = CommandResult<{ cardId: string; files_added: Array<{ idx: number; entry: unknown }>; notified: true }>;
      try {
        const cardId = input.params?.['cardId'] as string | undefined;
        if (!cardId) return fail('addCardFiles requires params.cardId') as R;

        const publicCards = createAsyncCardStorePublic(await cardStore(), { emitNotification });
        const appendResult = await publicCards.appendFiles({ params: { id: cardId }, body: input.body });
        if (appendResult.status !== 'success') return appendResult as unknown as R;
        return ok({ cardId, files_added: appendResult.data.files_added, notified: true }) as R;
      } catch (error) {
        return err(error) as R;
      }
    },

    async removeCard(input: CommandInput): Promise<CommandResult> {
      try {
        const id = input.params?.['id'] as string | undefined;
        if (!id) return fail('removeCard requires params.id');
        try { await adapter.kvStorage('card-upsert').delete(id); } catch { /* best-effort */ }
        await appendJournalEvent({ type: 'task-removal', taskName: id, timestamp: nowIso() });
        drainFireAndForget();
        return ok();
      } catch (error) {
        return err(error);
      }
    },

    async retrigger(input: CommandInput): Promise<CommandResult> {
      try {
        const id = input.params?.['id'] as string | undefined;
        if (!id) return fail('retrigger requires params.id');
        await appendJournalEvent({ type: 'task-restart', taskName: id, timestamp: nowIso() });
        drainFireAndForget();
        return ok();
      } catch (error) {
        return err(error);
      }
    },

    async processAccumulatedEvents(_input: CommandInput): Promise<CommandResult> {
      await clearQueuedProcessAccumulatedWakeups();
      return drain();
    },

    async upsertCard(input: CommandInput): Promise<CommandResult> {
      try {
        const cardId = input.params?.['cardId'] as string | undefined;
        const all = input.params?.['all'];
        const restart = Boolean(input.params?.['restart']);
        if (!cardId && !all) return fail('upsertCard requires --card-id <id> or --all');

        const cards = await cardStore();
        const ids = all ? (await cards.readAllCards()).map((card) => card.id) : [cardId as string];
        for (const id of ids) {
          if (!await cards.readCard(id)) return fail(`Card "${id}" not found in board at ${baseRef.value}`);
        }

        const upsertKv = adapter.kvStorage('card-upsert');
        for (const id of ids) {
          const card = await cards.readCard(id);
          if (!card) continue;
          const taskConfig = liveCardToTaskConfig(card);
          const taskConfigHash = adapter.hashFn(taskConfig);
          const existing = await upsertKv.read(id) as CardUpsertIndexEntry | null;
          const taskConfigChanged = existing?.taskConfigHash !== taskConfigHash;
          if (!taskConfigChanged && !restart) continue;
          if (taskConfigChanged) {
            const blobRef = existing?.blobRef ?? await cards.readCardKey(id) ?? id;
            await appendJournalEvent({ type: 'task-upsert', taskName: id, taskConfig, timestamp: nowIso() });
            await upsertKv.write(id, { blobRef, taskConfigHash, updatedAt: nowIso() } satisfies CardUpsertIndexEntry);
          }
          if (restart) await appendJournalEvent({ type: 'task-restart', taskName: id, timestamp: nowIso() });
        }

        drainFireAndForget();
        return ok();
      } catch (error) {
        return err(error);
      }
    },

    async taskFailed(input: CommandInput): Promise<CommandResult> {
      try {
        const token = input.params?.['token'] as string | undefined;
        if (!token) return fail('taskFailed requires params.token');
        const error = (input.params?.['error'] as string | undefined) ?? 'unknown error';
        const decoded = decodeCallbackToken(token);
        if (!decoded) return fail('Invalid callback token');
        await appendJournalEvent({ type: 'task-failed', taskName: decoded.taskName, error, timestamp: nowIso() });
        drainFireAndForget();
        return ok();
      } catch (e) {
        return err(e);
      }
    },

    async taskProgress(input: CommandInput): Promise<CommandResult> {
      try {
        const token = input.params?.['token'] as string | undefined;
        if (!token) return fail('taskProgress requires params.token');
        const update = ((input.body ?? {}) as Record<string, unknown>)['update'] ?? {};
        const decoded = decodeCallbackToken(token);
        if (!decoded) return fail('Invalid callback token');
        await appendJournalEvent({ type: 'task-progress', taskName: decoded.taskName, update: update as Record<string, unknown>, timestamp: nowIso() });
        drainFireAndForget();
        return ok();
      } catch (e) {
        return err(e);
      }
    },

    async sourceDataFetched(input: CommandInput): Promise<CommandResult> {
      try {
        const token = input.params?.['token'] as string | undefined;
        const ref = input.params?.['ref'] as string | undefined;
        if (!token) return fail('sourceDataFetched requires params.token');
        if (!ref) return fail('sourceDataFetched requires params.ref');
        const payload = decodeSourceToken(token);
        if (!payload) return fail('Invalid source token');
        const fetchedSourcesStore = await createFetchedSourcesStoreForRuntime();
        const deliveryToken = payload.dt || adapter.genId();
        if (!payload.dt) await fetchedSourcesStore.ingestSourceDataStaged(payload.cid, payload.d, parseRef(ref), deliveryToken);
        const decoded = decodeCallbackToken(payload.cbk);
        if (!decoded) return fail('Invalid callback token embedded in source token');
        await appendJournalEvent({
          type: 'task-progress',
          taskName: decoded.taskName,
          update: {
            bindTo: payload.b,
            outputFile: payload.d,
            fetchedAt: nowIso(),
            deliveryToken,
            sourceChecksum: payload.cs,
            rqt: payload.rqt,
          },
          timestamp: nowIso(),
        });
        drainFireAndForget();
        return ok();
      } catch (e) {
        return err(e);
      }
    },

    async sourceDataFetchFailure(input: CommandInput): Promise<CommandResult> {
      try {
        const token = input.params?.['token'] as string | undefined;
        const reason = (input.params?.['reason'] as string | undefined) ?? 'unknown';
        if (!token) return fail('sourceDataFetchFailure requires params.token');
        const payload = decodeSourceToken(token);
        if (!payload) return fail('Invalid source token');
        const decoded = decodeCallbackToken(payload.cbk);
        if (!decoded) return fail('Invalid callback token embedded in source token');
        await appendJournalEvent({
          type: 'task-progress',
          taskName: decoded.taskName,
          update: { bindTo: payload.b, outputFile: payload.d, failure: true, reason, sourceChecksum: payload.cs, rqt: payload.rqt },
          timestamp: nowIso(),
        });
        drainFireAndForget();
        return ok();
      } catch (e) {
        return err(e);
      }
    },
  };
}