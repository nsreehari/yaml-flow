/**
 * server-runtime/index.ts
 *
 * Platform-free board server runtime.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER DIAGRAM
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   HOST (demo-server / Azure Fn / Firebase Fn)
 *     ↓ constructs adapters, calls createSingleBoardServerRuntime(options)
 *   THIS FILE — routes, contexts, chat/file orchestration
 *     ↓ delegates to
 *   board-live-cards-public.ts — graph, journal, dispatch (already platform-free)
 *
 * No node:fs, node:net, node:child_process, node:os imports.
 * All platform access flows through injected adapters.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import {
  createBoardLiveCardsPublic,
  createBoardLiveCardsNonCorePublic,
} from '../cli/common/board-live-cards-public.js';
import type { CommandInput, CommandResult } from '../cli/common/board-live-cards-public.js';
import { createAsyncBoardLiveCardsPublic } from '../cli/cloud/board-live-cards-public-async.js';
import type { AsyncBoardLiveCardsPublic } from '../cli/cloud/board-live-cards-public-async.js';
import { createAsyncCardStorageAdapter, createAsyncCardStore, createAsyncJsonStorage } from '../cli/cloud/board-live-cards-storage-async.js';
import type { AsyncCardAdminStore } from '../cli/cloud/board-live-cards-storage-async.js';

import { createCardStorePublic } from '../cli/common/card-store-lib-public.js';
import { createCardStore } from '../cli/common/board-live-cards-lib.js';

import {
  createArtifactsStore,
  createCardFileMetadataStore,
} from '../cli/common/artifacts-store-lib.js';

import {
  createInMemoryChatStorage,
} from '../cli/common/chat-storage-lib.js';
import type { ChatStorage } from '../cli/common/chat-storage-lib.js';
import { createChatStorePublic } from '../cli/common/chat-store-lib-public.js';

import type {
  SingleBoardRuntimeOptions,
  MultiBoardRuntimeOptions,
  SingleBoardRuntime,
  MultiBoardRuntime,
  RuntimeRequest,
  RuntimeResponse,
  RuntimeLogger,
  BoardContextConfig,
  BoardRuntimeNonCorePublic,
  BoardRuntimePlatformAdapter,
  InvocationAdapter,
  NotificationTransport,
} from './types.js';
import type { BoardWorkerRequest } from '../cli/common/board-worker-store.js';
import {
  type NotificationState,
  makeNotificationState,
  hasNonEmptyCardCountStatus,
  appendNotification,
} from './notifications.js';
import {
  isAsyncBoardPlatformAdapter,
  executionWhatToRunValue,
  escapeRegExp,
  concatUint8Arrays,
} from './internal-helpers.js';
import { createSseHub } from './sse-hub.js';
import { createControlplaneToolHandlers } from './controlplane-tool-handlers.js';
import { createRuntimePayloadModule } from './runtime-payload.js';
import { createCardFileOps } from './card-file-ops.js';
import {
  createMcpToolRegistry as createMcpToolRegistryImpl,
  createMcpWebhookToolRegistry as createMcpWebhookToolRegistryImpl,
  createMcpControlplaneToolRegistry as createMcpControlplaneToolRegistryImpl,
} from './mcp-tool-registries.js';
import { createMcpFacadeModule } from './mcp-facade.js';
import type { McpFacadeBoardContextLike } from './mcp-facade.js';
import { createRoutesAgentface } from './routes-agentface.js';
import { createRoutesWebhooks } from './routes-webhooks.js';
import { createRoutesWatchers } from './routes-watchers.js';
import { createRoutesRuntimeApi } from './routes-runtime-api.js';

export type {
  SingleBoardRuntimeOptions,
  MultiBoardRuntimeOptions,
  SingleBoardRuntime,
  BoardRuntimeNonCorePublic,
  MultiBoardRuntime,
  RuntimeRequest,
  RuntimeResponse,
  RuntimeLogger,
  BoardContextConfig,
  InvocationAdapter,
  NotificationTransport,
};

// Re-export types for hosts
export * from './types.js';
export * from './queue-lanes.js';

const DEFAULT_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type,x-file-name',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
};

const CHAT_HANDLER_FLOW_QUEUE_TARGET = 'chat-handler-flow-queue';

// ============================================================================
// Internal types
// ============================================================================

/**
 * Internal Awaitable<T> alias. Wrappers on BoardContext (boardOps, cardStoreOps)
 * always expose Promise-returning shapes so runtime paths can `await` them
 * uniformly. The underlying public surface is still sync today; this gives us
 * the seam to swap in an async hosted board without changing call sites again.
 */
type Awaitable<T> = T | Promise<T>;

type BoardStatusObjectInternal = import('../cli/common/board-live-cards-lib.js').BoardStatusObject;

/** Awaitable mirror of the BoardLiveCardsPublic methods the runtime needs. */
interface BoardOpsAwaitable {
  init(input: CommandInput): Awaitable<CommandResult>;
  status(input: CommandInput): Awaitable<CommandResult<BoardStatusObjectInternal>>;
  getConfig(input: CommandInput): Awaitable<CommandResult<{ value: unknown }>>;
  getAllOutputsDataObjects(input: CommandInput): Awaitable<CommandResult<Record<string, unknown>>>;
  getAllOutputsComputedValues(input: CommandInput): Awaitable<CommandResult<Record<string, unknown>>>;
  getOutputsFetchedSources(input: CommandInput): Awaitable<CommandResult<Record<string, string>>>;
  upsertCard(input: CommandInput): Awaitable<CommandResult>;
  removeCard(input: CommandInput): Awaitable<CommandResult>;
  cardRefreshedNotify(input: CommandInput): Awaitable<CommandResult>;
  sourceDataFetched(input: CommandInput): Awaitable<CommandResult>;
  sourceDataFetchFailure(input: CommandInput): Awaitable<CommandResult>;
}

/** Awaitable mirror of the CardStorePublic methods the runtime needs. */
interface CardStoreOpsAwaitable {
  get(input: CommandInput): Awaitable<CommandResult<{ cards: Array<Record<string, unknown>> }>>;
  set(input: CommandInput): Awaitable<CommandResult<{ count: number }>>;
  del(input: CommandInput): Awaitable<CommandResult<{ count: number }>>;
  patch(input: CommandInput): Awaitable<CommandResult<{ count: number }>>;
  appendFiles(input: CommandInput): Awaitable<CommandResult<{ files_added: Array<{ idx: number; entry: unknown }> }>>;
}

interface RuntimeFilesArtifactsStore {
  putBytes(key: string, content: Uint8Array, contentType?: string): Awaitable<void>;
  getBytes(key: string): Awaitable<Uint8Array | null>;
  listKeys(prefix?: string): Awaitable<string[]>;
}

interface BoardContext {
  label: string;
  board: ReturnType<typeof createBoardLiveCardsPublic> | AsyncBoardLiveCardsPublic;
  nonCore: BoardRuntimeNonCorePublic | null;
  publicCardStore: SingleBoardRuntime['cardStore'];
  /** Awaitable wrapper around `board` for runtime-internal call sites. */
  boardOps: BoardOpsAwaitable;
  /** Awaitable wrapper around `cardStore` for runtime-internal call sites. */
  cardStoreOps: CardStoreOpsAwaitable;
  readonly filesArtifacts: RuntimeFilesArtifactsStore | null;
  boardAdapter: BoardRuntimePlatformAdapter;
  cardStoreRef: string;
  outputsStoreRef: string;
  artifactsStoreRef?: string;
  chatStoreRef?: string;
  scratchStoreRef?: string;
  archiveStoreRef?: string;
  notifyRef?: import('./types.js').KindValueRef;
  taskExecutorRef?: import('./types.js').ExecutionRef;
  chatHandlerRef?: import('./types.js').ExecutionRef;
  chatHandlerFlow?: unknown;
  inferenceAdapterRef?: import('./types.js').ExecutionRef;
  notification: NotificationState;
  notificationTeardown: (() => void) | null;
  initialized: boolean;
  cardsBootstrapped: boolean;
}

// ============================================================================
// createSingleBoardServerRuntime
// ============================================================================

export function createSingleBoardServerRuntime(options: SingleBoardRuntimeOptions): SingleBoardRuntime {
  const apiBasePath = String(options.apiBasePath || '/api/board').replace(/\/$/, '');
  const corsHeaders = { ...DEFAULT_CORS_HEADERS, ...(options.corsHeaders || {}) };
  const queueLaneTuning = options.queueLaneTuning ?? {};
  const boardId = options.boardId || '';
  const logger: RuntimeLogger = options.logger || { info: console.log, warn: console.warn, error: console.error };
  const invocationAdapter = options.invocationAdapter;
  const chatFlowRunner = options.chatFlowRunner || null;
  const chatStorage: ChatStorage = options.chatStorage ?? createInMemoryChatStorage();
  const chatStorePublic = createChatStorePublic(chatStorage);
  const notificationTransport = options.notificationTransport || null;
  const serverUrl = options.serverUrl || null;
  const executionExtra = options.executionExtra || {};
  const onSseClientConnected = options.onSseClientConnected;
  const onSseClientDisconnected = options.onSseClientDisconnected;
  const onChannelSubscribed = options.onChannelSubscribed;
  const onChannelUnsubscribed = options.onChannelUnsubscribed;

  // SSE hub: owns the client registry, broadcast helpers, and chat-subscription scanner.
  // Constructed lazily-bound to readChatRecords (defined further down in the closure).
  const sseHub = createSseHub({
    chatStorage,
    readChatRecords: (cardId: string) => readChatRecords(cardId),
    onSseClientDisconnected,
  });

  // ── Build board contexts from injected configs ───────────────────────────

  function buildContext(cfg: BoardContextConfig): BoardContext {
    function normalizeFilesBody(body: unknown): Array<Record<string, unknown>> | null {
      if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
      if (body && typeof body === 'object') {
        const obj = body as { files?: unknown };
        if (Array.isArray(obj.files)) return obj.files as Array<Record<string, unknown>>;
        return [body as Record<string, unknown>];
      }
      return null;
    }

    function createSyncCardStoreOps(store: ReturnType<typeof createCardStorePublic>): CardStoreOpsAwaitable {
      return {
        async get(input) { return store.get(input) as CommandResult<{ cards: Array<Record<string, unknown>> }>; },
        async set(input) { return store.set(input); },
        async del(input) { return store.del(input); },
        async patch(input) { return store.patch(input); },
        async appendFiles(input) { return store.appendFiles(input); },
      };
    }

    function createAsyncCardStoreOps(store: AsyncCardAdminStore): CardStoreOpsAwaitable {
      function ok<T>(data: T): CommandResult<T> { return { status: 'success', data } as CommandResult<T>; }
      function fail<T>(error: string): CommandResult<T> { return { status: 'fail', error } as CommandResult<T>; }
      function oops<T>(e: unknown): CommandResult<T> { return { status: 'error', error: e instanceof Error ? e.message : String(e) } as CommandResult<T>; }

      return {
        async get(input) {
          try {
            const id = input.params?.id as string | undefined;
            if (id) {
              const card = await store.readCard(id);
              if (!card) return fail(`card "${id}" not found`);
              return ok({ cards: [card as Record<string, unknown>] });
            }
            return ok({ cards: await store.readAllCards() as Array<Record<string, unknown>> });
          } catch (e) { return oops(e); }
        },
        async set(input) {
          try {
            const body = input.body;
            if (body == null) return fail('set requires a body (card object or array of cards)');
            const cards = Array.isArray(body) ? body as Array<Record<string, unknown>> : [body as Record<string, unknown>];
            for (const card of cards) {
              if (typeof card.id !== 'string') return fail('each card must have a string `id` field');
              await store.writeCard(card.id, card as import('../cli/common/board-live-cards-lib.js').LiveCard);
            }
            return ok({ count: cards.length });
          } catch (e) { return oops(e); }
        },
        async del(input) {
          try {
            const bodyIds = (input.body as { ids?: string[] } | undefined)?.ids ?? [];
            const paramId = input.params?.id as string | undefined;
            const ids = paramId ? [...bodyIds, paramId] : bodyIds;
            if (ids.length === 0) return fail('del requires body.ids (string[]) or params.id');
            for (const id of ids) await store.removeCard(id);
            return ok({ count: ids.length });
          } catch (e) { return oops(e); }
        },
        async patch(input) {
          try {
            const id = input.params?.id as string | undefined;
            const jsonPath = input.params?.path as string | undefined;
            if (!id) return fail('patch requires params.id');
            if (!jsonPath) return fail('patch requires params.path');
            const body = input.body as { value?: unknown } | undefined;
            const value = body && Object.prototype.hasOwnProperty.call(body, 'value') ? body.value : input.body;
            await store.patchCard(id, jsonPath, value);
            return ok({ count: 1 });
          } catch (e) { return oops(e); }
        },
        async appendFiles(input) {
          try {
            const id = input.params?.id as string | undefined;
            if (!id) return fail('appendFiles requires params.id');
            const card = await store.readCard(id);
            if (!card) return fail(`card "${id}" not found`);
            const files = normalizeFilesBody(input.body);
            if (!files || files.length === 0) return fail('appendFiles requires a file metadata object, array, or body.files array');
            const cardData = (card.card_data && typeof card.card_data === 'object' && !Array.isArray(card.card_data))
              ? card.card_data as Record<string, unknown>
              : {};
            const existingFiles = Array.isArray(cardData.files) ? cardData.files : [];
            const nextFiles = [...existingFiles, ...files];
            await store.patchCard(id, 'card_data.files', nextFiles);
            return ok({ files_added: files.map((entry, offset) => ({ idx: existingFiles.length + offset, entry })) });
          } catch (e) { return oops(e); }
        },
      };
    }

    const board = isAsyncBoardPlatformAdapter(cfg.boardAdapter)
      ? createAsyncBoardLiveCardsPublic(cfg.baseRef, cfg.boardAdapter)
      : createBoardLiveCardsPublic(cfg.baseRef, cfg.boardAdapter);
    const nonCoreAdapter = cfg.nonCoreAdapter
      ?? (!isAsyncBoardPlatformAdapter(cfg.boardAdapter) && isBoardNonCorePlatformAdapter(cfg.boardAdapter) ? cfg.boardAdapter : null);
    const nonCore = cfg.nonCore ?? (nonCoreAdapter ? createBoardLiveCardsNonCorePublic(cfg.baseRef, nonCoreAdapter) : null);
    let publicCardStore: SingleBoardRuntime['cardStore'];
    const cardStoreOps = isAsyncBoardPlatformAdapter(cfg.boardAdapter)
      ? (() => {
        const asyncStore = createAsyncCardStore(
          createAsyncCardStorageAdapter(createAsyncJsonStorage(cfg.boardAdapter.kvStorageForRef(cfg.cardStoreRef)), cfg.boardAdapter.hashFn),
          logger.warn,
        );
        const ops = createAsyncCardStoreOps(asyncStore);
        publicCardStore = {
          get(input) { return ops.get(input); },
          set(input) { return ops.set(input); },
        };
        return ops;
      })()
      : (() => {
        const kv = cfg.boardAdapter.kvStorageForRef(cfg.cardStoreRef);
        const cardAdapterObj = {
          readIndex: () => kv.read('_index'),
          writeIndex: (idx: unknown) => kv.write('_index', idx),
          readCard: (id: string) => kv.read(id),
          writeCard: (id: string, card: unknown) => { kv.write(id, card); return id; },
          removeCard: (id: string) => { kv.delete(id); },
          cardExists: (id: string) => kv.read(id) !== null,
          defaultCardKey: (id: string) => id,
        };
        const syncStore = createCardStorePublic(createCardStore(cardAdapterObj as any, logger.warn));
        publicCardStore = syncStore;
        return createSyncCardStoreOps(syncStore);
      })();
    const artAdapter = cfg.artifactsAdapter || cfg.boardAdapter;
    const callerFilesArtifactsStore = cfg.filesArtifactsStore ?? null;
    let _filesArtifacts: RuntimeFilesArtifactsStore | null = callerFilesArtifactsStore
      ? {
        putBytes(key, content, contentType) { callerFilesArtifactsStore.putBytes(key, content, contentType); },
        getBytes(key) { return callerFilesArtifactsStore.getBytes(key); },
        listKeys(prefix) { return callerFilesArtifactsStore.list(prefix).map((entry) => entry.key); },
      }
      : null;
    if (!_filesArtifacts && !isAsyncBoardPlatformAdapter(artAdapter)) {
      const filesBlob = cfg.artifactsAdapter ? artAdapter.blobStorage('') : artAdapter.blobStorage('files');
      const filesStore = createArtifactsStore(filesBlob);
      _filesArtifacts = {
        putBytes(key, content, contentType) { filesStore.putBytes(key, content, contentType); },
        getBytes(key) { return filesStore.getBytes(key); },
        listKeys(prefix) { return filesStore.list(prefix).map((entry) => entry.key); },
      };
    } else if (!_filesArtifacts && isAsyncBoardPlatformAdapter(artAdapter)) {
      const filesBlob = cfg.artifactsAdapter ? artAdapter.blobStorage('') : artAdapter.blobStorage('files');
      _filesArtifacts = {
        async putBytes(key, content) {
          if (filesBlob.writeBytes) {
            await filesBlob.writeBytes(key, content);
            return;
          }
          const envelope = JSON.stringify({ __kind: 'bytes-array', data: [...content] });
          await filesBlob.write(key, envelope);
        },
        async getBytes(key) {
          if (filesBlob.readBytes) {
            const bytes = await filesBlob.readBytes(key);
            if (bytes !== null) return bytes;
          }
          const raw = await filesBlob.read(key);
          if (raw === null) return null;
          try {
            const parsed = JSON.parse(raw) as { __kind?: string; data?: number[] };
            if (parsed && parsed.__kind === 'bytes-array' && Array.isArray(parsed.data)) {
              return new Uint8Array(parsed.data);
            }
          } catch {
            // plain text path
          }
          return new TextEncoder().encode(raw);
        },
        async listKeys(prefix) { return await filesBlob.listKeys(prefix); },
      };
    }

    const boardOps: BoardOpsAwaitable = {
      async init(input) { return board.init(input); },
      async status(input) { return board.status(input); },
      async getConfig(input) { return board.getConfig(input); },
      async getAllOutputsDataObjects(input) { return board.getAllOutputsDataObjects(input); },
      async getAllOutputsComputedValues(input) { return board.getAllOutputsComputedValues(input); },
      async getOutputsFetchedSources(input) { return board.getOutputsFetchedSources(input); },
      async upsertCard(input) { return board.upsertCard(input); },
      async removeCard(input) { return board.removeCard(input); },
      async cardRefreshedNotify(input) { return board.cardRefreshedNotify(input); },
      async sourceDataFetched(input) { return board.sourceDataFetched(input); },
      async sourceDataFetchFailure(input) { return board.sourceDataFetchFailure(input); },
    };
    return {
      label: cfg.label,
      board,
      nonCore,
      publicCardStore,
      boardOps,
      cardStoreOps,
      get filesArtifacts() { return _filesArtifacts; },
      boardAdapter: cfg.boardAdapter,
      cardStoreRef: cfg.cardStoreRef,
      outputsStoreRef: cfg.outputsStoreRef,
      artifactsStoreRef: cfg.artifactsStoreRef,
      chatStoreRef: cfg.chatStoreRef,
      scratchStoreRef: cfg.scratchStoreRef,
      archiveStoreRef: cfg.archiveStoreRef,
      notifyRef: cfg.notifyRef,
      taskExecutorRef: cfg.taskExecutorRef,
      chatHandlerRef: cfg.chatHandlerRef,
      chatHandlerFlow: cfg.chatHandlerFlow,
      inferenceAdapterRef: cfg.inferenceAdapterRef,
      notification: makeNotificationState(),
      notificationTeardown: null,
      initialized: false,
      cardsBootstrapped: false,
    };
  }

  const boardContexts: BoardContext[] = options.boards.map(buildContext);
  const cardOwnerIndex = new Map<string, number>();

  function ownerIndex(cardId: string): number { return cardOwnerIndex.get(cardId) ?? 0; }

  function isBoardNonCorePlatformAdapter(adapter: import('./types.js').BoardPlatformAdapter): adapter is import('./types.js').BoardNonCorePlatformAdapter {
    const maybe = adapter as import('./types.js').BoardNonCorePlatformAdapter;
    return typeof maybe.invokeExecutor === 'function' && typeof maybe.validateSchema === 'function';
  }

  // ── Artifacts stores ─────────────────────────────────────────────────────

  function artifactsStores(cardId: string) {
    const ctx = boardContexts[ownerIndex(cardId)];
    return {
      files: ctx ? ctx.filesArtifacts : null,
    };
  }

  function cardFileMetadataStoreInstance() {
    return createCardFileMetadataStore();
  }

  // ── Card ID tracking ─────────────────────────────────────────────────────

  function safeCardId(cardId: string): string {
    return String(cardId || '').replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown-card';
  }

  // ── Notification transport ───────────────────────────────────────────────

  async function ensureNotificationConsumer(ctx: BoardContext): Promise<void> {
    if (!ctx || ctx.notificationTeardown) return;
    if (!notificationTransport || !ctx.notifyRef) return;
    const teardown = await notificationTransport.subscribe(ctx.notifyRef, (event) => {
      appendNotification(ctx.notification, event);
      // Broadcast incremental notifications to SSE clients so shells can use
      // applyNotification instead of re-deriving the full payload each time.
      const notifications = (event as Record<string, unknown>).kind === 'notification-batch'
        ? (event as Record<string, unknown[]>).notifications as unknown[]
        : [event];
      sseHub.broadcastNotificationBatch(notifications);
    });
    ctx.notificationTeardown = teardown;
  }

  // ── Init & bootstrap ─────────────────────────────────────────────────────

  async function initContext(ctx: BoardContext): Promise<void> {
    if (!ctx) return;
    if (ctx.initialized) return;

    const params: Record<string, string> = {
      cardStoreRef: ctx.cardStoreRef,
      outputsStoreRef: ctx.outputsStoreRef,
    };
    if (ctx.artifactsStoreRef) params.artifactsStoreRef = ctx.artifactsStoreRef;
    if (ctx.chatStoreRef) params.chatStoreRef = ctx.chatStoreRef;
    if (ctx.scratchStoreRef) params.scratchStoreRef = ctx.scratchStoreRef;
    if (ctx.archiveStoreRef) params.archiveStoreRef = ctx.archiveStoreRef;
    const body: Record<string, unknown> = {};
    if (ctx.taskExecutorRef) body['task-executor-ref'] = ctx.taskExecutorRef;
    if (ctx.chatHandlerFlow !== undefined) body['chat-handler-flow'] = ctx.chatHandlerFlow;
    if (ctx.inferenceAdapterRef) body['inference-adapter-ref'] = ctx.inferenceAdapterRef;

    const initResult = await ctx.boardOps.init({ params, body });
    if (initResult.status !== 'success') {
      throw Object.assign(
        new Error((initResult as any).error || `init failed for ${ctx.label}`),
        { statusCode: 500 },
      );
    }

    await ensureNotificationConsumer(ctx);

    if (!ctx.chatHandlerFlow && ctx.chatHandlerRef && invocationAdapter.describe) {
      try {
        const desc = await invocationAdapter.describe(ctx.chatHandlerRef);
        if (desc && desc.kind !== 'chat-handler') {
          logger.warn(`[init] chat-handler describe returned kind="${desc.kind}", expected "chat-handler" for ${ctx.label}`);
        } else if (desc) {
          logger.info(`[init] chat-handler validated: ${desc.name} (protocol ${desc.protocolVersion}) for ${ctx.label}`);
        }
      } catch (err: unknown) {
        logger.warn(`[init] chat-handler describe failed for ${ctx.label}: ${(err as Error)?.message || String(err)}`);
      }
    }

    ctx.initialized = true;
  }

  async function publishPersistedStateSnapshot(ctx: BoardContext): Promise<void> {
    if (!ctx.boardAdapter.publishBoardChangeNotifications) return;
    const notifications: Array<{ kind: string; [k: string]: unknown }> = [];
    // 1. Status
    const statusResult = await ctx.boardOps.status({});
    if (statusResult.status === 'success' && statusResult.data != null) {
      if (hasNonEmptyCardCountStatus(statusResult.data)) {
        notifications.push({ kind: 'status', status: statusResult.data });
      }
    }
    // 2. All data objects
    const dataResult = await ctx.boardOps.getAllOutputsDataObjects({});
    if (dataResult.status === 'success' && dataResult.data != null) {
      for (const [token, payload] of Object.entries(dataResult.data as Record<string, unknown>)) {
        if (token) notifications.push({ kind: 'data_object', key: token, payload });
      }
    }
    // 3. All computed values
    const cvResult = await ctx.boardOps.getAllOutputsComputedValues({});
    if (cvResult.status === 'success' && cvResult.data != null) {
      for (const [cardId, values] of Object.entries(cvResult.data as Record<string, unknown>)) {
        if (cardId) notifications.push({ kind: 'computed_values', cardId, values });
      }
    }
    if (notifications.length > 0) {
      ctx.boardAdapter.publishBoardChangeNotifications(notifications as import('../cli/common/board-live-cards-public.js').BoardChangeNotification[]);
    }
  }

  async function upsertCardsFromSource(ctx: BoardContext, ctxIndex: number): Promise<void> {
    if (!ctx) return;
    if (ctx.cardsBootstrapped) return;
    const result = await ctx.cardStoreOps.get({});
    const cards: Array<Record<string, unknown>> = (result.status === 'success' && Array.isArray((result as any).data?.cards))
      ? (result as any).data.cards
      : [];
    for (const card of cards) {
      if (typeof card.id !== 'string') continue;
      cardOwnerIndex.set(card.id as string, ctxIndex);
      await ctx.boardOps.upsertCard({ params: { cardId: card.id as string } });
    }
    ctx.cardsBootstrapped = true;
  }

  async function initBoardAndSetup(): Promise<void> {
    for (const ctx of boardContexts) {
      await initContext(ctx);
    }
  }

  async function bootstrapBoard(): Promise<void> {
    await initBoardAndSetup();
    for (let i = 0; i < boardContexts.length; i++) {
      // Publish persisted state snapshot first — gives clients the last-known
      // state immediately via SSE before any async drain completes.
      await publishPersistedStateSnapshot(boardContexts[i]);
      await upsertCardsFromSource(boardContexts[i], i);
      await publishPersistedStateSnapshot(boardContexts[i]);
    }
  }

  async function processAccumulatedLaneInternal(skipInit = false): Promise<CommandResult> {
    if (!skipInit) await initBoardAndSetup();
    for (const ctx of boardContexts) {
      const result = await ctx.board.processAccumulatedEvents({});
      if (result.status !== 'success') return result;
    }
    return { status: 'success' };
  }

  async function processAccumulatedEventsInternal(): Promise<CommandResult> {
    await initBoardAndSetup();
      return processAccumulatedLaneInternal(true);
  }

  // ── Card reads ───────────────────────────────────────────────────────────

  function cardContextForCard(cardId: string): BoardContext | null {
    return boardContexts[ownerIndex(cardId)] ?? null;
  }

  async function readCardFromStore(cardId: string): Promise<Record<string, unknown> | null> {
    const ctx = cardContextForCard(cardId);
    if (!ctx) return null;
    const result = await ctx.cardStoreOps.get({ params: { id: cardId } });
    if (result.status !== 'success') return null;
    const cards = Array.isArray((result as any).data?.cards) ? (result as any).data.cards : [];
    return cards.length > 0 ? cards[0] : null;
  }

  async function readCardDefinitions(): Promise<Array<Record<string, unknown>>> {
    const fromCtx = async (ctx: BoardContext | null): Promise<Array<Record<string, unknown>>> => {
      if (!ctx) return [];
      const result = await ctx.cardStoreOps.get({});
      if (result.status !== 'success' || !Array.isArray((result as any).data?.cards)) {
        return [];
      }
      return (result as any).data.cards;
    };
    const all: Array<Record<string, unknown>> = [];
    for (const ctx of boardContexts) {
      all.push(...await fromCtx(ctx));
    }
    return all;
  }

  function primaryContext(): BoardContext | null {
    return boardContexts[0] ?? null;
  }

  // MCP facade wiring lives in ./mcp-facade.ts. The factory takes narrow
  // callbacks for every closure-owned helper the facade reaches into;
  // returned methods are re-bound to local names so existing call sites
  // (createMcpFacade(), mcpCardStoreFacade(), etc.) are unchanged.
  const mcpFacadeModule = createMcpFacadeModule({
    boardContexts: boardContexts as unknown as McpFacadeBoardContextLike[],
    cardOwnerIndex,
    cardContextForCard: (cardId) => cardContextForCard(cardId) as McpFacadeBoardContextLike | null,
    readStatusSnapshot: () => readStatusSnapshot(),
    readDataObjectsByToken: () => readDataObjectsByToken(),
    readCardRuntimeArtifacts: () => readCardRuntimeArtifacts(),
    readCardFromStore: (cardId) => readCardFromStore(cardId),
    readCardDefinitions: () => readCardDefinitions(),
    processAccumulatedLaneInternal: (skipInit) => processAccumulatedLaneInternal(skipInit),
    reportSourceFetched: (token, ref) => reportSourceFetchedInternal(token, { ref }),
    reportSourceFetchFailure: (token, reason) => reportSourceFetchFailureInternal(token, { reason }),
    uploadCardFile: (cardId, fileName, contentType, bytes, opts) => uploadCardFile(cardId, fileName, contentType, bytes, opts),
    chatStorePublic,
    serverUrl,
    apiBasePath,
  });

  const mcpCardStoreFacade = mcpFacadeModule.mcpCardStoreFacade;
  const createMcpFacade = mcpFacadeModule.createMcpFacade;
  const controlplaneToolHandlers = createControlplaneToolHandlers({
    boardId,
    getMcpFacade: () => createMcpFacade(),
    getMcpCardStoreFacade: () => mcpCardStoreFacade(),
  });

  function createMcpToolRegistry(mcp: ReturnType<typeof createMcpFacade>) {
    return createMcpToolRegistryImpl(mcp);
  }

  function createMcpWebhookToolRegistry() {
    return createMcpWebhookToolRegistryImpl(createMcpFacade());
  }

  function createMcpControlplaneToolRegistry() {
    return createMcpControlplaneToolRegistryImpl({
      boardId,
      uploadCardFile,
      getMcpFacade: () => createMcpFacade(),
      controlplane: controlplaneToolHandlers,
    });
  }
  // ── Status & runtime artifacts ───────────────────────────────────────────
  // Read-only payload aggregation lives in ./runtime-payload.ts. The module
  // takes a live reference to boardContexts plus narrow callbacks for chat
  // reads and chat-processing state.

  const runtimePayloadModule = createRuntimePayloadModule({
    boardId,
    boardContexts,
    readCardDefinitions: () => readCardDefinitions(),
    readChatRecords: (cardId) => readChatRecords(cardId),
    getChatProcessing: (cardId) => createMcpFacade().getChatProcessing({ cardId }).active,
  });

  const readStatusSnapshot = runtimePayloadModule.readStatusSnapshot;
  const readCardRuntimeArtifacts = runtimePayloadModule.readCardRuntimeArtifacts;
  const readDataObjectsByToken = runtimePayloadModule.readDataObjectsByToken;
  const buildPublishedRuntimePayload = runtimePayloadModule.buildPublishedRuntimePayload;

  // ── Card mutations ───────────────────────────────────────────────────────

  async function mutateCard(cardId: string, updateFn: (card: Record<string, unknown>) => Record<string, unknown> | void, opts?: { syncBoard?: boolean; restartOnlyIfChanged?: boolean }): Promise<void> {
    const syncBoard = opts?.syncBoard !== false;
    const restartOnlyIfChanged = opts?.restartOnlyIfChanged === true;
    const ctx = cardContextForCard(cardId);
    if (!ctx) throw Object.assign(new Error(`Card not found: ${cardId}`), { statusCode: 404 });

    const card = await readCardFromStore(cardId);
    if (!card) throw Object.assign(new Error(`Card not found: ${cardId}`), { statusCode: 404 });

    const beforeJson = restartOnlyIfChanged ? JSON.stringify(card) : null;
    const nextCard = updateFn(card) || card;

    // If restartOnlyIfChanged and the card content is identical, skip the write and the board sync entirely.
    if (restartOnlyIfChanged && JSON.stringify(nextCard) === beforeJson) return;

    const setResult = await ctx.cardStoreOps.set({ body: nextCard });
    if (setResult.status !== 'success') {
      throw Object.assign(new Error((setResult as any).error || `Failed to persist card: ${cardId}`), { statusCode: 500 });
    }

    if (syncBoard) {
      const upsertResult = await ctx.boardOps.upsertCard({ params: { cardId, restart: true } });
      if (upsertResult.status !== 'success') {
        throw Object.assign(new Error((upsertResult as any).error || `Failed to upsert card: ${cardId}`), { statusCode: 500 });
      }
    }
  }

  async function updateCard(cardId: string, updateFn: (card: Record<string, unknown>) => Record<string, unknown> | void): Promise<void> {
    await mutateCard(cardId, updateFn, { syncBoard: true });
  }

  async function updateCardLocalOnly(cardId: string, updateFn: (card: Record<string, unknown>) => Record<string, unknown> | void): Promise<void> {
    await mutateCard(cardId, updateFn, { syncBoard: false });
  }

  async function retriggerCard(cardId: string): Promise<void> {
    const ctx = cardContextForCard(cardId);
    if (!ctx) throw Object.assign(new Error(`Card not found: ${cardId}`), { statusCode: 404 });
    const card = await readCardFromStore(cardId);
    if (!card) throw Object.assign(new Error(`Card not found: ${cardId}`), { statusCode: 404 });
    const upsertResult = await ctx.boardOps.upsertCard({ params: { cardId, restart: true } });
    if (upsertResult.status !== 'success') {
      throw Object.assign(new Error((upsertResult as any).error || `Failed to retrigger card: ${cardId}`), { statusCode: 500 });
    }
  }

  async function patchCard(cardId: string, patch: Record<string, unknown>): Promise<void> {
    await mutateCard(cardId, (card) => {
      if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) return card;

      function deepSet(obj: Record<string, unknown>, dottedPath: string, value: unknown): void {
        const parts = String(dottedPath || '').split('.').filter(Boolean);
        if (!parts.length) return;
        let target = obj;
        for (let i = 0; i < parts.length - 1; i++) {
          const key = parts[i];
          if (!target[key] || typeof target[key] !== 'object') target[key] = {};
          target = target[key] as Record<string, unknown>;
        }
        target[parts[parts.length - 1]] = value;
      }

      if (patch.fieldValues !== undefined && patch.fieldValues !== null) {
        // fieldValues can be: plain object (form/filter), array (editable-table), or primitive (notes).
        let writeTo: string | null = null;
        const view = card.view as Record<string, unknown> | undefined;
        if (view && Array.isArray(view.elements)) {
          for (const elem of view.elements) {
            if (elem?.data && (elem as any).data.writeTo) { writeTo = (elem as any).data.writeTo; break; }
          }
        }
        if (writeTo) {
          // writeTo present: deepSet handles any value type (object, array, primitive)
          deepSet(card, writeTo, patch.fieldValues);
        } else if (typeof patch.fieldValues === 'object' && !Array.isArray(patch.fieldValues)) {
          // No writeTo + plain object: merge-spread into card_data
          card.card_data = { ...((card.card_data || {}) as Record<string, unknown>), ...(patch.fieldValues as Record<string, unknown>) };
        }
        // No writeTo + array or primitive: skip — no safe implicit target
      } else if (Array.isArray(patch._stagedFiles) && (patch._stagedFiles as unknown[]).length > 0) {
        return card;
      } else {
        for (const [key, value] of Object.entries(patch)) {
          if (key === '_stagedFiles') continue;
          if (value !== null && typeof value === 'object' && !Array.isArray(value) &&
              card[key] !== null && typeof card[key] === 'object' && !Array.isArray(card[key])) {
            card[key] = { ...(card[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
          } else {
            card[key] = value;
          }
        }
      }
      return card;
    }, { syncBoard: true, restartOnlyIfChanged: true });
  }

  // ── Chat & file operations ───────────────────────────────────────────────

  function clearChatRecords(cardId: string): void {
    chatStorage.clear(cardId);
    try { createMcpFacade().setChatProcessing({ cardId, active: false }); } catch {}
  }

  /** Append a chat message; returns the new entry id (used as cursor). */
  function writeChatRecord(cardId: string, role: string, text: string, files: Array<Record<string, unknown>>, turn = ''): string {
    const msg = typeof text === 'string' ? text.trim() : '';
    return chatStorage.append(cardId, role || 'system', msg, files, turn);
  }

  function readChatRecords(cardId: string): Array<Record<string, unknown>> {
    return chatStorage.readAll(cardId) as unknown as Array<Record<string, unknown>>;
  }

  // File operations live in ./card-file-ops.ts. The factory takes narrow
  // callbacks for the closure-owned helpers it needs.
  const cardFileOps = createCardFileOps({
    safeCardId: (cardId) => safeCardId(cardId),
    artifactsStores: (cardId) => artifactsStores(cardId),
    cardFileMetadataStore: () => cardFileMetadataStoreInstance(),
    readCardFromStore: (cardId) => readCardFromStore(cardId),
    updateCardLocalOnly: (cardId, fn) => updateCardLocalOnly(cardId, fn),
    writeChatRecord: (cardId, role, text, files, turnId) => writeChatRecord(cardId, role, text, files as Array<Record<string, unknown>>, turnId),
  });

  const uploadCardFile = cardFileOps.uploadCardFile;

  async function resolveChatHandlerTarget(cardId: string): Promise<{
    ctx: BoardContext;
    handlerFlow: unknown;
    handlerRef: import('./types.js').ExecutionRef;
  } | null> {
    const ctx = cardContextForCard(cardId);
    if (!ctx) return null;

    const flowResult = await ctx.boardOps.getConfig({ params: { key: 'chat-handler-flow' } });
    const handlerFlow = flowResult.status === 'success' ? (flowResult as any).data?.value : null;
    const handlerRef = ctx.chatHandlerRef;
    if (handlerFlow == null && (!handlerRef || typeof handlerRef !== 'object')) return null;

    return {
      ctx,
      handlerFlow,
      handlerRef: handlerRef as import('./types.js').ExecutionRef,
    };
  }

  // ── Chat handler queueing + dispatch ─────────────────────────────────────

  async function queueChatHandler(cardId: string, lastEntryId: string, processingAlreadySet = false, turnId = ''): Promise<void> {
    const target = await resolveChatHandlerTarget(cardId);
    if (!target) return;
    const { ctx, handlerFlow, handlerRef } = target;

    if (!processingAlreadySet) {
      try { createMcpFacade().setChatProcessing({ cardId, active: true }); } catch {}
    }

    const args: Record<string, unknown> = {
      boardId,
      cardId: String(cardId),
      lastChatEntryId: lastEntryId,
      ...(turnId ? { turnId } : {}),
      ...executionExtra,
      ...(serverUrl ? { serverUrl } : {}),
    };

    const executionRef = handlerFlow != null
      ? {
          meta: 'chat-handler-flow',
          howToRun: 'built-in' as const,
          whatToRun: { kind: 'built-in', value: CHAT_HANDLER_FLOW_QUEUE_TARGET },
        }
      : handlerRef;

    try {
      if (isAsyncBoardPlatformAdapter(ctx.boardAdapter)) {
        await ctx.boardAdapter.chatAgentStore().enqueueRequest({
          boardId,
          ref: executionRef,
          args: handlerFlow != null ? { ...args, __chatHandlerFlow: handlerFlow } : args,
        });
      } else {
        ctx.boardAdapter.chatAgentStore().enqueueRequest({
          boardId,
          ref: executionRef,
          args: handlerFlow != null ? { ...args, __chatHandlerFlow: handlerFlow } : args,
        });
      }
      await Promise.resolve(ctx.boardAdapter.requestProcessAccumulated?.());
    } catch (err) {
      try { createMcpFacade().setChatProcessing({ cardId, active: false }); } catch {}
      logger.warn(`[chat-handler] queue failed for card "${cardId}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function dispatchQueuedChatHandler(
    ctx: BoardContext,
    ref: import('./types.js').ExecutionRef,
    args: Record<string, unknown>,
  ): Promise<{ dispatched: boolean; error?: string }> {
    if (ref.howToRun === 'built-in' && executionWhatToRunValue(ref) === CHAT_HANDLER_FLOW_QUEUE_TARGET) {
      const flowRunner = chatFlowRunner;
      const handlerFlow = args.__chatHandlerFlow;
      const cleanArgs = { ...args };
      delete cleanArgs.__chatHandlerFlow;
      if (!flowRunner) {
        return { dispatched: false, error: 'chat-handler-flow configured but no chatFlowRunner was provided' };
      }
      return flowRunner.run(handlerFlow, cleanArgs, {
        boardId,
        cardId: String(cleanArgs.cardId || ''),
        label: ctx.label,
        logger,
        serverUrl,
        executionExtra,
      });
    }

    return invocationAdapter.invoke(ref, args);
  }

  async function handleChatAgentRequestInternal(request: BoardWorkerRequest, skipInit = false): Promise<void> {
    if (!skipInit) await initBoardAndSetup();
    const cardId = typeof request.args?.cardId === 'string' ? request.args.cardId : '';
    const ctx = cardId ? cardContextForCard(cardId) : primaryContext();
    if (!ctx) {
      throw new Error(cardId
        ? `Board context is unavailable for chat-agent request: ${cardId}`
        : 'Board context is unavailable for chat-agent request');
    }
    const result = await dispatchQueuedChatHandler(ctx, request.ref, request.args);
    if (result.dispatched) return;
    if (cardId) {
      try { chatStorage.setProcessing(cardId, false); } catch {}
    }
    throw new Error(result.error || `chat-agent dispatch failed for card "${cardId || 'unknown'}"`);
  }

  // ── Card actions ─────────────────────────────────────────────────────────

  async function applyCardAction(cardId: string, actionType: string, payload: Record<string, unknown> | null): Promise<void> {
    const persistCard = actionType === 'chat-send' ? updateCardLocalOnly : updateCard;
    let chatHandlerResult: { cardId: string; lastEntryId: string; processingAlreadySet: boolean } | undefined;

    await persistCard(cardId, (card) => {
      const now = new Date().toISOString();
      const cardData = card.card_data && typeof card.card_data === 'object' ? card.card_data as Record<string, unknown> : {};
      card.card_data = cardData;

      if (actionType === 'chat-send') {
        const text = payload && typeof payload.text === 'string' ? payload.text.trim() : '';
        const turnId = payload && typeof payload['turn-id'] === 'string'
          ? payload['turn-id']
          : payload && typeof payload.turnId === 'string'
            ? payload.turnId
            : payload && typeof payload.turn === 'string'
              ? payload.turn
              : '';
        const files: Array<Record<string, unknown>> = [];
        if (Array.isArray(payload?.files)) {
          for (const f of payload.files as unknown[]) {
            if (!f) continue;
            if (typeof f === 'string') { files.push({ name: f }); continue; }
            if (typeof f === 'object') {
              const fo = f as Record<string, unknown>;
              if (typeof fo.name === 'string') files.push({ name: fo.name, size: fo.size, mime_type: fo.mime_type, uploaded_at: fo.uploaded_at, stored_name: fo.stored_name, chat: fo.chat === true });
            }
          }
        }

        if (text || files.length > 0) {
          const batchResult = chatStorePublic.runBatch({
            cardId,
            commands: [
              { command: 'append', role: 'user', text, files, turn: turnId },
              { command: 'set-processing', active: true },
            ],
          });
          if (batchResult.status !== 'success') {
            throw new Error(batchResult.error);
          }
          const appendId = (batchResult.data.results[0]?.data as { id?: unknown } | undefined)?.id;
          if (typeof appendId !== 'string' || !appendId) {
            throw new Error(`chat-send did not return an append id for card ${cardId}`);
          }
          const entryId = appendId;
          const processingAlreadySet = true;

          chatHandlerResult = { cardId, lastEntryId: entryId, processingAlreadySet, turnId } as typeof chatHandlerResult & { turnId: string };
          // Immediately broadcast processing=true to subscribed SSE clients.
          // The scan loop runs every ~1s; for fast (sub-second) flows the
          // processing flag is already cleared by the time the loop fires,
          // so clients would never see the processing-started transition.
          try { sseHub.broadcastCardChats(cardId); } catch { /* best-effort */ }
        }
        return card;
      }

      if (actionType === 'file-upload') {
        const files = cardFileMetadataStoreInstance().normalizeIncoming(payload?.files, now);
        if (files.length > 0) cardFileMetadataStoreInstance().merge(cardData, files);
        return card;
      }

      if (actionType === 'action') {
        const buttonId = payload && typeof payload.buttonId === 'string' ? payload.buttonId : '';
        if (!buttonId) return card;
        cardData.lastAction = { buttonId, at: now };
        cardData.lastActionText = `${buttonId} @ ${now}`;
      }

      return card;
    });

    if (chatHandlerResult) {
      void queueChatHandler(chatHandlerResult.cardId, chatHandlerResult.lastEntryId, chatHandlerResult.processingAlreadySet, (chatHandlerResult as { turnId?: string }).turnId ?? '');
    }
  }

  // ── HTTP helpers ─────────────────────────────────────────────────────────

  function json(res: RuntimeResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    const byteLen = typeof Buffer !== 'undefined' ? Buffer.byteLength(body) : new TextEncoder().encode(body).length;
    res.writeHead(status, {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': byteLen,
    });
    res.end(body);
  }

  async function resolveCardFileDownloadPayload(cardId: string, idx: number, expectedStoredName: string | null): Promise<{
    fileRecord: Record<string, unknown>;
    bytes: Uint8Array;
  }> {
    const card = await readCardFromStore(cardId);
    if (!card) throw Object.assign(new Error('Card not found'), { statusCode: 404 });

    const resolved = cardFileMetadataStoreInstance().resolve(card.card_data, idx, expectedStoredName);
    if (!resolved.ok && (resolved as any).reason === 'stale_reference') {
      throw Object.assign(new Error('File reference is stale. Refresh and try again.'), { statusCode: 409 });
    }
    if (!resolved.ok) throw Object.assign(new Error('File not found'), { statusCode: 404 });

    const fileRecord = (resolved as any).file as Record<string, unknown>;
    const sid = safeCardId(cardId);
    const stores = artifactsStores(cardId);
    const storedName = String(fileRecord.stored_name || '');
    const fileKey = `${sid}/${storedName}`;
    const bytes = stores.files ? await stores.files.getBytes(fileKey) : null;
    if (!bytes) throw Object.assign(new Error('File not found'), { statusCode: 404 });

    return { fileRecord, bytes };
  }

  async function sendCardFileDownloadResponse(res: RuntimeResponse, cardId: string, idx: number, expectedStoredName: string | null): Promise<void> {
    const { fileRecord, bytes } = await resolveCardFileDownloadPayload(cardId, idx, expectedStoredName);

    const filename = String(fileRecord.name || fileRecord.stored_name || 'download.bin');
    const mimeType = String(fileRecord.mime_type || 'application/octet-stream');
    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': bytes.length,
    });
    res.end(bytes as unknown as Buffer);
  }

  function isLikelyTextMimeType(mimeType: string): boolean {
    const normalized = String(mimeType || '').toLowerCase();
    return normalized.startsWith('text/')
      || normalized.includes('json')
      || normalized.includes('xml')
      || normalized.includes('javascript')
      || normalized.includes('typescript')
      || normalized.includes('yaml')
      || normalized.includes('csv');
  }

  function sliceTextByLines(text: string, mode: 'head' | 'tail', count: number): string {
    const lines = text.split(/\r?\n/);
    const selected = mode === 'head' ? lines.slice(0, count) : lines.slice(-count);
    return selected.join('\n');
  }

  async function readJsonBody(req: RuntimeRequest): Promise<Record<string, unknown>> {
    const chunks: Array<Buffer | Uint8Array> = [];
    for await (const c of req) chunks.push(c);
    const raw = typeof Buffer !== 'undefined'
      ? Buffer.concat(chunks as Buffer[]).toString('utf-8').trim()
      : new TextDecoder().decode(concatUint8Arrays(chunks as Uint8Array[])).trim();
    if (!raw) return {};
    return JSON.parse(raw);
  }

  async function readRawBody(req: RuntimeRequest): Promise<Uint8Array> {
    const chunks: Array<Buffer | Uint8Array> = [];
    for await (const c of req) chunks.push(c);
    if (typeof Buffer !== 'undefined') return Buffer.concat(chunks as Buffer[]);
    return concatUint8Arrays(chunks as Uint8Array[]);
  }

  async function reportSourceFetchedInternal(token: string, payload: Record<string, unknown>): Promise<CommandResult> {
    const ref = typeof payload.ref === 'string' ? payload.ref.trim() : '';
    if (!ref) return { status: 'fail', error: 'board-worker success callback requires body.ref' };
    const ctx = boardContexts[0];
    if (!ctx) return { status: 'fail', error: 'no board context' };
    return ctx.boardOps.sourceDataFetched({ params: { token, ref } });
  }

  async function reportSourceFetchFailureInternal(token: string, payload: Record<string, unknown>): Promise<CommandResult> {
    const reason = typeof payload.reason === 'string' && payload.reason.trim()
      ? payload.reason
      : 'unknown';
    const ctx = boardContexts[0];
    if (!ctx) return { status: 'fail', error: 'no board context' };
    return ctx.boardOps.sourceDataFetchFailure({ params: { token, reason } });
  }

  // ── SSE + watcher routes ─────────────────────────────────────────────────
  // createRoutesWatchers composes routes-sse.ts internally and adds the
  // HTTP subscription management endpoints on top. It is the sole owner
  // of sseHub from a routing perspective.
  const routesWatchers = createRoutesWatchers({
    sseHub,
    corsHeaders,
    json,
    buildPublishedRuntimePayload: () => buildPublishedRuntimePayload(),
    onSseClientConnected,
    onChannelSubscribed,
    onChannelUnsubscribed,
    apiBasePath,
    readJsonBody: (req) => readJsonBody(req),
    initBoardAndSetup: () => initBoardAndSetup(),
    bootstrapBoard: () => bootstrapBoard(),
    boardContexts,
    publishPersistedStateSnapshot: (ctx) => publishPersistedStateSnapshot(ctx as BoardContext),
    upsertCardsFromSource: (ctx, idx) => upsertCardsFromSource(ctx as BoardContext, idx),
  });
  const handleWatchersRoutes = routesWatchers.handleWatchersRoutes;

  // ── Agent-face routes ──────────────────────────────────────────────────
  // POST /mcp, POST /mcp-raw
  const routesAgentface = createRoutesAgentface({
    apiBasePath,
    json,
    readJsonBody: (req) => readJsonBody(req),
    bootstrapBoard: () => bootstrapBoard(),
    createMcpFacade: () => createMcpFacade(),
    createMcpToolRegistry: (mcp) => createMcpToolRegistry(mcp as ReturnType<typeof createMcpFacade>),
    resolveCardFileDownloadPayload: (cardId, idx, expectedStoredName) => resolveCardFileDownloadPayload(cardId, idx, expectedStoredName),
    isLikelyTextMimeType: (mimeType) => isLikelyTextMimeType(mimeType),
    sliceTextByLines: (text, mode, count) => sliceTextByLines(text, mode, count),
  });
  const handleAgentfaceApi = routesAgentface.handleAgentfaceApi;

  // ── Webhook routes ─────────────────────────────────────────────────────
  // POST /mcp-webhooks
  const routesWebhooks = createRoutesWebhooks({
    apiBasePath,
    json,
    readJsonBody: (req) => readJsonBody(req),
    initBoardAndSetup: () => initBoardAndSetup(),
    createMcpWebhookToolRegistry: () => createMcpWebhookToolRegistry(),
  });
  const handleWebhooksApi = routesWebhooks.handleWebhooksApi;

  // ── Control-face routes ────────────────────────────────────────────────
  // The single-board HTTP route table lives in ./routes-runtime-api.ts.
  const routesRuntimeApi = createRoutesRuntimeApi({
    apiBasePath,
    json,
    readJsonBody: (req) => readJsonBody(req),
    readRawBody: (req) => readRawBody(req),
    initBoardAndSetup: () => initBoardAndSetup(),
    bootstrapBoard: () => bootstrapBoard(),
    buildPublishedRuntimePayload: () => buildPublishedRuntimePayload(),
    createMcpControlplaneToolRegistry: () => createMcpControlplaneToolRegistry(),
    readCardFromStore: (cardId) => readCardFromStore(cardId),
    patchCard: (cardId, patch) => patchCard(cardId, patch),
    retriggerCard: (cardId) => retriggerCard(cardId),
    applyCardAction: (cardId, actionType, payload) => applyCardAction(cardId, actionType, payload),
    resolveChatHandlerTarget: (cardId) => resolveChatHandlerTarget(cardId),
    createMcpFacade: () => createMcpFacade(),
    chatStorePublic,
    uploadCardFile: (cardId, fileName, contentType, bytes, opts) => uploadCardFile(cardId, fileName, contentType, bytes, opts),
    sendCardFileDownloadResponse: (res, cardId, idx, expectedStoredName) => sendCardFileDownloadResponse(res, cardId, idx, expectedStoredName),
  });
  const handleRuntimeApi = routesRuntimeApi.handleRuntimeApi;

  // ── Full request dispatcher ──────────────────────────────────────────────
  // Chains all 4 faces. Exposed as handleRuntimeApi on the service object so
  // that the host (HTTP server / createMultiBoardServerRuntime) has a single
  // entry point.
  async function handleAllRoutes(req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL): Promise<boolean> {
    if (await handleAgentfaceApi(req, res, parsedUrl)) return true;
    if (await handleWebhooksApi(req, res, parsedUrl)) return true;
    if (await handleWatchersRoutes(req, res, parsedUrl)) return true;
    if (await handleRuntimeApi(req, res, parsedUrl)) return true;
    return false;
  }

  return {
    get apiBasePath() { return apiBasePath; },
    get corsHeaders() { return corsHeaders; },
    get queueLaneTuning() { return queueLaneTuning; },
    handleRuntimeApi: handleAllRoutes,
    buildPublishedRuntimePayload,
    processAccumulatedEvents: processAccumulatedEventsInternal,
    processAccumulatedLane: processAccumulatedLaneInternal,
    handleChatAgentRequest: handleChatAgentRequestInternal,
    clearChatRecords,
    reportSourceFetched(token: string, ref: string) {
      return reportSourceFetchedInternal(token, { ref });
    },
    reportSourceFetchFailure(token: string, reason: string) {
      return reportSourceFetchFailureInternal(token, { reason });
    },
    get cardStore() {
      return boardContexts[0]?.publicCardStore ?? {
        get() { return Promise.resolve({ status: 'fail', error: 'no board context' }); },
        set() { return Promise.resolve({ status: 'fail', error: 'no board context' }); },
      };
    },
  };
}

// ============================================================================
// createMultiBoardServerRuntime
// ============================================================================

export function createMultiBoardServerRuntime(options: MultiBoardRuntimeOptions): MultiBoardRuntime {
  const apiBasePath = String(options.apiBasePath || '/api/boards').replace(/\/$/, '');
  const corsHeaders = { ...DEFAULT_CORS_HEADERS, ...(options.corsHeaders || {}) };
  const serverMetaStore = options.serverMetaStore;
  const boardRuntimeFactory = options.boardRuntimeFactory;
  const boardServiceCache = new Map<string, SingleBoardRuntime>();

  const boardsRegistryKey = 'boards-config.json';

  function readBoardsConfig(): { boards: Array<Record<string, unknown>> } {
    const raw = serverMetaStore.getText(boardsRegistryKey);
    if (!raw) return { boards: [{ id: 'default', label: 'Default Board' }] };
    try { return JSON.parse(raw); } catch { return { boards: [{ id: 'default', label: 'Default Board' }] }; }
  }

  function writeBoardsConfig(config: unknown): void {
    serverMetaStore.putText(boardsRegistryKey, JSON.stringify(config, null, 2));
  }

  function safeBoardId(raw: unknown): string | null {
    const sanitized = String(raw || '').replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
    return sanitized.length > 0 && sanitized.length <= 64 ? sanitized : null;
  }

  function getBoardService(boardId: string): SingleBoardRuntime {
    if (boardServiceCache.has(boardId)) return boardServiceCache.get(boardId)!;
    const config = readBoardsConfig();
    const entry = config.boards.find((b) => b.id === boardId) || {};
    const service = boardRuntimeFactory(boardId, entry);
    boardServiceCache.set(boardId, service);
    return service;
  }

  function json(res: RuntimeResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload);
    const byteLen = typeof Buffer !== 'undefined' ? Buffer.byteLength(body) : new TextEncoder().encode(body).length;
    res.writeHead(status, {
      ...corsHeaders,
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': byteLen,
    });
    res.end(body);
  }

  async function handleBoardsRegistryApi(req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL): Promise<boolean> {
    const method = req.method || 'GET';
    const p = parsedUrl.pathname;

    if (method === 'GET' && p === apiBasePath) {
      json(res, 200, { ok: true, boards: readBoardsConfig().boards });
      return true;
    }

    if (method === 'POST' && p === apiBasePath) {
      const chunks: Array<Buffer | Uint8Array> = [];
      for await (const c of req) chunks.push(c);
      const raw = typeof Buffer !== 'undefined'
        ? Buffer.concat(chunks as Buffer[]).toString('utf-8').trim()
        : new TextDecoder().decode(concatUint8Arrays(chunks as Uint8Array[])).trim();
      let body: Record<string, unknown> = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }

      const id = safeBoardId(body.id);
      if (!id) { json(res, 400, { error: 'board id must be 1-64 alphanumeric/dash/underscore characters' }); return true; }

      const config = readBoardsConfig();
      if (config.boards.some((b) => b.id === id)) { json(res, 409, { error: `Board "${id}" is already registered` }); return true; }

      const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : id;
      const entry: Record<string, unknown> = { id, label };
      for (const [key, val] of Object.entries(body)) {
        if (key === 'id' || key === 'label') continue;
        if (val !== undefined && val !== null) entry[key] = val;
      }
      config.boards.push(entry);
      writeBoardsConfig(config);
      json(res, 200, { ok: true, board: entry });
      return true;
    }

    return false;
  }

  async function handleBoardApi(req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL): Promise<boolean> {
    const p = parsedUrl.pathname;
    const boardSegMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/([^/]+)(/|$)`));
    if (!boardSegMatch) return false;

    const boardId = safeBoardId(decodeURIComponent(boardSegMatch[1]));
    if (!boardId) { json(res, 400, { error: 'Invalid board id' }); return true; }

    const config = readBoardsConfig();
    if (!config.boards.some((b) => b.id === boardId)) {
      json(res, 404, { error: `Board "${boardId}" not registered. POST ${apiBasePath} with {id} to register it first.` });
      return true;
    }

    const service = getBoardService(boardId);
    if (await service.handleRuntimeApi(req, res, parsedUrl)) return true;
    return false;
  }

  async function handleApi(req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL): Promise<boolean> {
    if (await handleBoardsRegistryApi(req, res, parsedUrl)) return true;
    if (await handleBoardApi(req, res, parsedUrl)) return true;
    return false;
  }

  function requireBoardService(boardId: string): { service: SingleBoardRuntime } {
    const config = readBoardsConfig();
    if (!config.boards.some((b) => b.id === boardId)) {
      throw Object.assign(new Error(`Board "${boardId}" not registered`), { statusCode: 404 });
    }
    return { service: getBoardService(boardId) };
  }

  return {
    get apiBasePath() { return apiBasePath; },
    get corsHeaders() { return corsHeaders; },
    handleApi,
    requireBoardService,
  };
}

