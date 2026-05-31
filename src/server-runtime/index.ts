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
import type { CommandResult } from '../cli/common/board-live-cards-public.js';
import { createBoardLiveCardsMcp } from '../cli/common/board-live-cards-mcp.js';
import { parseRef } from '../cli/common/storage-interface.js';

import { createCardStorePublic } from '../cli/common/card-store-lib-public.js';
import { createCardStore } from '../cli/common/board-live-cards-lib.js';

import {
  createArtifactsStore,
  createFileArtifactsStore,
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
  InvocationAdapter,
  NotificationTransport,
} from './types.js';

export type {
  SingleBoardRuntimeOptions,
  MultiBoardRuntimeOptions,
  SingleBoardRuntime,
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

const DEFAULT_CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type,x-file-name',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
};

const MAX_STORED_FILE_NAME_LEN = 32;

// ============================================================================
// Internal types
// ============================================================================

interface BoardContext {
  label: string;
  board: ReturnType<typeof createBoardLiveCardsPublic>;
  nonCore: ReturnType<typeof createBoardLiveCardsNonCorePublic> | null;
  cardStore: ReturnType<typeof createCardStorePublic>;
  readonly filesArtifacts: ReturnType<typeof createArtifactsStore>;
  boardAdapter: import('./types.js').BoardPlatformAdapter;
  cardStoreRef: string;
  outputsStoreRef: string;
  artifactsStoreRef?: string;
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

interface NotificationState {
  status: unknown;
  computedValues: Record<string, unknown>;
  dataObjects: Record<string, unknown>;
  cards: Record<string, unknown>;
}

interface SseClientState {
  res: RuntimeResponse;
  subscribedChatCardIds: Set<string>;
}

// ============================================================================
// Notification helpers
// ============================================================================

function makeNotificationState(): NotificationState {
  return { status: null, computedValues: {}, dataObjects: {}, cards: {} };
}

function hasNonEmptyCardCountStatus(status: unknown): boolean {
  if (!status || typeof status !== 'object') return false;
  const summary = (status as Record<string, unknown>).summary;
  if (!summary || typeof summary !== 'object') return false;
  return Number((summary as Record<string, unknown>).card_count || 0) > 0;
}

function appendNotification(state: NotificationState, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const e = event as Record<string, unknown>;
  // Unpack notification-batch so individual items update ctx.notification.*
  if (e.kind === 'notification-batch' && Array.isArray(e.notifications)) {
    for (const n of e.notifications) appendNotification(state, n);
    return;
  }
  if (e.kind === 'status') {
    // Ignore empty status snapshots (e.g. auxiliary contexts)
    // so they do not overwrite the primary board status.
    if (hasNonEmptyCardCountStatus(e.status)) state.status = e.status;
  }
  if (e.kind === 'computed_values' && e.cardId) state.computedValues[e.cardId as string] = e.values;
  if (e.kind === 'data_object' && e.key) state.dataObjects[e.key as string] = e.payload;
  if (e.kind === 'card_refreshed' && e.cardId) state.cards[e.cardId as string] = e.card;
  if (e.kind === 'card_removed' && e.cardId) {
    delete state.cards[e.cardId as string];
    delete state.computedValues[e.cardId as string];
  }
}

// ============================================================================
// createSingleBoardServerRuntime
// ============================================================================

export function createSingleBoardServerRuntime(options: SingleBoardRuntimeOptions): SingleBoardRuntime {
  const apiBasePath = String(options.apiBasePath || '/api/board').replace(/\/$/, '');
  const corsHeaders = { ...DEFAULT_CORS_HEADERS, ...(options.corsHeaders || {}) };
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

  const sseClients = new Map<string, SseClientState>();
  const lastChatCursorByCardId = new Map<string, string | null>();
  const lastChatProcessingByCardId = new Map<string, boolean>();
  let chatSubscriptionScanTimer: ReturnType<typeof setInterval> | null = null;

  // ── Build board contexts from injected configs ───────────────────────────

  function buildContext(cfg: BoardContextConfig): BoardContext {
    const board = createBoardLiveCardsPublic(cfg.baseRef, cfg.boardAdapter);
    const nonCoreAdapter = cfg.nonCoreAdapter
      ?? (isBoardNonCorePlatformAdapter(cfg.boardAdapter) ? cfg.boardAdapter : null);
    const nonCore = nonCoreAdapter ? createBoardLiveCardsNonCorePublic(cfg.baseRef, nonCoreAdapter) : null;
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
    const cardStore = createCardStorePublic(createCardStore(cardAdapterObj as any, logger.warn));
    const artAdapter = cfg.artifactsAdapter || cfg.boardAdapter;
    const callerFilesArtifactsStore = cfg.filesArtifactsStore ?? null;
    const filesBlob = cfg.artifactsAdapter ? artAdapter.blobStorage('') : artAdapter.blobStorage('files');

    // Lazy artifact stores — only created on first access (saves ~5KB in bundles
    // that never use file features).
    let _filesArtifacts: ReturnType<typeof createArtifactsStore> | null = null;

    return {
      label: cfg.label,
      board,
      nonCore,
      cardStore,
      get filesArtifacts() { return _filesArtifacts ??= (callerFilesArtifactsStore ?? createArtifactsStore(filesBlob)); },
      boardAdapter: cfg.boardAdapter,
      cardStoreRef: cfg.cardStoreRef,
      outputsStoreRef: cfg.outputsStoreRef,
      artifactsStoreRef: cfg.artifactsStoreRef,
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

  function fileArtifactsForCard(cardId: string) {
    const stores = artifactsStores(cardId);
    if (!stores.files) return null;
    return createFileArtifactsStore(stores.files);
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
      broadcastNotificationBatchToSseClients(notifications);
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
    if (ctx.scratchStoreRef) params.scratchStoreRef = ctx.scratchStoreRef;
    if (ctx.archiveStoreRef) params.archiveStoreRef = ctx.archiveStoreRef;
    const body: Record<string, unknown> = {};
    if (ctx.taskExecutorRef) body['task-executor-ref'] = ctx.taskExecutorRef;
    if (ctx.chatHandlerFlow !== undefined) body['chat-handler-flow'] = ctx.chatHandlerFlow;
    if (ctx.inferenceAdapterRef) body['inference-adapter-ref'] = ctx.inferenceAdapterRef;

    const initResult = ctx.board.init({ params, body });
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

  function publishPersistedStateSnapshot(ctx: BoardContext): void {
    if (!ctx.boardAdapter.publishBoardChangeNotifications) return;
    const notifications: Array<{ kind: string; [k: string]: unknown }> = [];
    // 1. Status
    const statusResult = ctx.board.status({});
    if (statusResult.status === 'success' && statusResult.data != null) {
      if (hasNonEmptyCardCountStatus(statusResult.data)) {
        notifications.push({ kind: 'status', status: statusResult.data });
      }
    }
    // 2. All data objects
    const dataResult = ctx.board.getAllOutputsDataObjects({});
    if (dataResult.status === 'success' && dataResult.data != null) {
      for (const [token, payload] of Object.entries(dataResult.data as Record<string, unknown>)) {
        if (token) notifications.push({ kind: 'data_object', key: token, payload });
      }
    }
    // 3. All computed values
    const cvResult = ctx.board.getAllOutputsComputedValues({});
    if (cvResult.status === 'success' && cvResult.data != null) {
      for (const [cardId, values] of Object.entries(cvResult.data as Record<string, unknown>)) {
        if (cardId) notifications.push({ kind: 'computed_values', cardId, values });
      }
    }
    if (notifications.length > 0) {
      ctx.boardAdapter.publishBoardChangeNotifications(notifications as import('../cli/common/board-live-cards-public.js').BoardChangeNotification[]);
    }
  }

  function upsertCardsFromSource(ctx: BoardContext, ctxIndex: number): void {
    if (!ctx) return;
    if (ctx.cardsBootstrapped) return;
    const result = ctx.cardStore.get({});
    const cards: Array<Record<string, unknown>> = (result.status === 'success' && Array.isArray((result as any).data?.cards))
      ? (result as any).data.cards
      : [];
    for (const card of cards) {
      if (typeof card.id !== 'string') continue;
      cardOwnerIndex.set(card.id as string, ctxIndex);
      ctx.board.upsertCard({ params: { cardId: card.id as string } });
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
      publishPersistedStateSnapshot(boardContexts[i]);
      upsertCardsFromSource(boardContexts[i], i);
    }
  }

  // ── Card reads ───────────────────────────────────────────────────────────

  function cardContextForCard(cardId: string): BoardContext | null {
    return boardContexts[ownerIndex(cardId)] ?? null;
  }

  function readCardFromStore(cardId: string): Record<string, unknown> | null {
    const ctx = cardContextForCard(cardId);
    if (!ctx) return null;
    const result = ctx.cardStore.get({ params: { id: cardId } });
    if (result.status !== 'success') return null;
    const cards = Array.isArray((result as any).data?.cards) ? (result as any).data.cards : [];
    return cards.length > 0 ? cards[0] : null;
  }

  function readCardDefinitions(): Array<Record<string, unknown>> {
    const fromCtx = (ctx: BoardContext | null): Array<Record<string, unknown>> => {
      if (!ctx || !ctx.cardStore) return [];
      const result = ctx.cardStore.get({});
      if (result.status !== 'success' || !Array.isArray((result as any).data?.cards)) {
        return [];
      }
      return (result as any).data.cards;
    };
    const all: Array<Record<string, unknown>> = [];
    for (const ctx of boardContexts) {
      all.push(...fromCtx(ctx));
    }
    return all;
  }

  function primaryContext(): BoardContext | null {
    return boardContexts[0] ?? null;
  }

  function mcpBoardFacade(): import('../cli/common/board-live-cards-mcp.js').BoardLiveCardsMcpBoardDeps {
    return {
      status() {
        const status = readStatusSnapshot();
        return status == null
          ? { status: 'fail', error: 'Board status is unavailable' }
          : { status: 'success', data: status };
      },
      getOutputsDataObject(input) {
        const key = input?.params?.key;
        if (!key) return { status: 'fail', error: 'getOutputsDataObject requires params.key' };
        const dataObjects = readDataObjectsByToken();
        return { status: 'success', data: dataObjects[key] };
      },
      getOutputsComputedValues(input) {
        const key = input?.params?.key;
        if (!key) return { status: 'fail', error: 'getOutputsComputedValues requires params.key' };
        const artifacts = readCardRuntimeArtifacts();
        const entry = artifacts[key] as Record<string, unknown> | undefined;
        return { status: 'success', data: entry?.computed_values };
      },
      getOutputsFetchedSources(input) {
        const key = input?.params?.key;
        if (!key) return { status: 'fail', error: 'getOutputsFetchedSources requires params.key' };
        const ctx = cardContextForCard(key) ?? primaryContext();
        if (!ctx) return { status: 'fail', error: 'Board context is unavailable' };
        return ctx.board.getOutputsFetchedSources({ params: { key } });
      },
      removeCard(input) {
        const id = input?.params?.id;
        if (!id) return { status: 'fail', error: 'removeCard requires params.id' };
        const ctx = cardContextForCard(id) ?? primaryContext();
        if (!ctx) return { status: 'fail', error: 'Board context is unavailable' };
        return ctx.board.removeCard({ params: { id } });
      },
      cardRefreshedNotify(input) {
        const cardId = input?.params?.cardId;
        if (!cardId) return { status: 'fail', error: 'cardRefreshedNotify requires params.cardId' };
        const ctx = cardContextForCard(cardId) ?? primaryContext();
        if (!ctx) return { status: 'fail', error: 'Board context is unavailable' };
        return ctx.board.cardRefreshedNotify({ params: { cardId } });
      },
      upsertCard(input) {
        const cardId = input?.params?.cardId;
        if (!cardId) return { status: 'fail', error: 'upsertCard requires params.cardId' };
        const ctx = cardContextForCard(cardId) ?? primaryContext();
        if (!ctx) return { status: 'fail', error: 'Board context is unavailable' };
        return ctx.board.upsertCard({ params: { cardId, restart: input.params.restart === true } });
      },
    };
  }

  function mcpNonCoreFacade(): import('../cli/common/board-live-cards-mcp.js').BoardLiveCardsMcpNonCoreDeps {
    const getNonCore = () => {
      const ctx = primaryContext();
      if (!ctx?.nonCore) throw new Error('Board non-core adapter is not configured for MCP preflight/discovery tools');
      return ctx.nonCore;
    };
    return {
      describeTaskExecutorCapabilities(input) { return getNonCore().describeTaskExecutorCapabilities(input); },
      validateCardPreflight(input) { return getNonCore().validateCardPreflight(input); },
      evalCardCompute(input) { return getNonCore().evalCardCompute(input); },
      probeSourcePreflight(input) { return getNonCore().probeSourcePreflight(input); },
      runSourcePreflight(input) { return getNonCore().runSourcePreflight(input); },
      simulateCardCycle(input) { return getNonCore().simulateCardCycle(input); },
    };
  }

  function mcpCardStoreFacade(): import('../cli/common/card-store-lib-public.js').CardStorePublic {
    return {
      get(input) {
        const id = typeof input.params?.id === 'string' ? input.params.id : undefined;
        if (id) {
          const card = readCardFromStore(id);
          if (!card) return { status: 'success', data: { cards: [] } };
          return { status: 'success', data: { cards: [card as import('../cli/common/board-live-cards-lib.js').LiveCard] } };
        }
        return { status: 'success', data: { cards: readCardDefinitions() as import('../cli/common/board-live-cards-lib.js').LiveCard[] } };
      },
      set(input) {
        const body = input.body;
        if (body == null) return { status: 'fail', error: 'set requires a body (card object or array of cards)' };
        const cards = Array.isArray(body) ? body : [body];
        for (const rawCard of cards) {
          const card = rawCard as Record<string, unknown>;
          const cardId = typeof card.id === 'string' ? card.id : '';
          if (!cardId) return { status: 'fail', error: 'each card must have a string `id` field' };
          const ctxIndex = cardOwnerIndex.get(cardId) ?? 0;
          const ctx = boardContexts[ctxIndex] ?? primaryContext();
          if (!ctx) return { status: 'fail', error: 'Board context is unavailable' };
          const setResult = ctx.cardStore.set({ body: card });
          if (setResult.status !== 'success') return setResult;
          cardOwnerIndex.set(cardId, ctxIndex);
        }
        return { status: 'success', data: { count: cards.length } };
      },
      del(input) {
        const ids = [input.params?.id, ...(((input.body as { ids?: string[] } | undefined)?.ids) ?? [])].filter((id): id is string => typeof id === 'string' && !!id);
        if (ids.length === 0) return { status: 'fail', error: 'del requires body.ids (string[]) or params.id' };
        for (const id of ids) {
          const ctx = cardContextForCard(id) ?? primaryContext();
          if (!ctx) return { status: 'fail', error: 'Board context is unavailable' };
          const delResult = ctx.cardStore.del({ params: { id } });
          if (delResult.status !== 'success') return delResult;
          cardOwnerIndex.delete(id);
        }
        return { status: 'success', data: { count: ids.length } };
      },
      patch(input) {
        const id = typeof input.params?.id === 'string' ? input.params.id : undefined;
        const path = typeof input.params?.path === 'string' ? input.params.path : undefined;
        if (!id || !path) return { status: 'fail', error: 'patch requires params.id and params.path' };
        const ctx = cardContextForCard(id) ?? primaryContext();
        if (!ctx) return { status: 'fail', error: 'Board context is unavailable' };
        return ctx.cardStore.patch(input);
      },
      appendFiles(input) {
        const id = typeof input.params?.id === 'string' ? input.params.id : undefined;
        if (!id) return { status: 'fail', error: 'appendFiles requires params.id' };
        const ctx = cardContextForCard(id) ?? primaryContext();
        if (!ctx) return { status: 'fail', error: 'Board context is unavailable' };
        return ctx.cardStore.appendFiles(input);
      },
    };
  }

  function createMcpFacade() {
    return createBoardLiveCardsMcp({
      board: mcpBoardFacade(),
      nonCore: mcpNonCoreFacade(),
      cardStore: mcpCardStoreFacade(),
      chatStore: chatStorePublic,
      uploadCardFile({ cardId, fileName, contentType, bytes }) {
        return uploadCardFile(cardId, fileName, contentType, bytes, { inChat: false });
      },
      buildFileDownloadUrl({ cardId, fileIdx, storedName }) {
        const base = `${serverUrl || ''}${apiBasePath}/cards/${encodeURIComponent(cardId)}/files/${fileIdx}`;
        return storedName ? `${base}?sn=${encodeURIComponent(storedName)}` : base;
      },
      readFetchedSourceJsonByRef({ cardId, ref }) {
        const ctx = cardContextForCard(cardId) ?? primaryContext();
        if (!ctx) return null;
        const text = ctx.boardAdapter.resolveBlob(parseRef(ref));
        const trimmed = text.trim();
        return trimmed ? JSON.parse(trimmed) : null;
      },
    });
  }

  function getMcpArgString(args: Record<string, unknown>, ...keys: string[]): string {
    for (const key of keys) {
      if (typeof args[key] === 'string') return String(args[key]);
    }
    return '';
  }

  function getMcpArgNumber(args: Record<string, unknown>, ...keys: string[]): number | undefined {
    for (const key of keys) {
      if (args[key] !== undefined) return Number(args[key]);
    }
    return undefined;
  }

  function getMcpArgRecord(args: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
    for (const key of keys) {
      const value = args[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    }
    return {};
  }

  function getRequiredMcpArgRecord(args: Record<string, unknown>, errorKey: string, ...keys: string[]): Record<string, unknown> {
    for (const key of keys) {
      const value = args[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    }
    throw Object.assign(new Error(`MCP tool requires ${errorKey}`), { statusCode: 400 });
  }

  function getRequiredMcpArgNumber(args: Record<string, unknown>, errorKey: string, ...keys: string[]): number {
    for (const key of keys) {
      const value = args[key];
      if (value !== undefined) {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    throw Object.assign(new Error(`MCP tool requires ${errorKey}`), { statusCode: 400 });
  }

  function parseMcpUploadBytes(args: Record<string, unknown>): Uint8Array | null {
    if (Array.isArray(args.bytes)) {
      return new Uint8Array((args.bytes as unknown[]).map((value) => Math.max(0, Math.min(255, Number(value) || 0))));
    }
    if (typeof args.text === 'string') {
      return new TextEncoder().encode(args.text);
    }
    if (typeof args.base64 === 'string') {
      const base64 = String(args.base64).replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
      const binStr = atob(padded);
      return Uint8Array.from(binStr, (ch) => ch.charCodeAt(0));
    }
    return null;
  }

  function setChatProcessingFromControlplane(args: Record<string, unknown>, active: boolean): { status: 'success'; data: { boardId: string; cardId: string; active: boolean } } {
    const requestBoardId = getMcpArgString(args, 'board_id');
    const cardId = getMcpArgString(args, 'card_id');
    if (!requestBoardId) throw Object.assign(new Error('MCP tool requires board_id'), { statusCode: 400 });
    if (!cardId) throw Object.assign(new Error('MCP tool requires card_id'), { statusCode: 400 });
    if (requestBoardId !== boardId) throw Object.assign(new Error(`Unknown board_id: ${requestBoardId}`), { statusCode: 400 });
    createMcpFacade().setChatProcessing({ cardId, active });
    return { status: 'success', data: { boardId, cardId, active } };
  }

  function requireControlplaneCardArgs(args: Record<string, unknown>): { cardId: string } {
    const requestBoardId = getMcpArgString(args, 'board_id');
    const cardId = getMcpArgString(args, 'card_id');
    if (!requestBoardId) throw Object.assign(new Error('MCP tool requires board_id'), { statusCode: 400 });
    if (!cardId) throw Object.assign(new Error('MCP tool requires card_id'), { statusCode: 400 });
    if (requestBoardId !== boardId) throw Object.assign(new Error(`Unknown board_id: ${requestBoardId}`), { statusCode: 400 });
    return { cardId };
  }

  function expectControlplaneSuccess<T>(result: CommandResult<T>, commandName: string): T {
    if (result?.status === 'success') {
      return Object.prototype.hasOwnProperty.call(result, 'data')
        ? (result as { data: T }).data
        : (undefined as T);
    }
    if (result?.status === 'fail' || result?.status === 'error') {
      throw Object.assign(new Error(result.error || `${commandName} failed`), { statusCode: 400 });
    }
    throw Object.assign(new Error(`${commandName} returned an unexpected response`), { statusCode: 500 });
  }

  function getCardMetaKey(args: Record<string, unknown>): string {
    const key = getMcpArgString(args, 'key');
    if (!key) throw Object.assign(new Error('MCP tool requires key'), { statusCode: 400 });
    const segments = key.split('.');
    const valid = segments.length >= 2
      && segments[0] === 'chat'
      && segments.every((segment) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment));
    if (!valid) throw Object.assign(new Error('MCP tool only supports card meta keys under chat.*'), { statusCode: 400 });
    return key;
  }

  function readCardMetaValue(card: Record<string, unknown>, key: string): { exists: boolean; value: unknown } {
    let target: unknown = card.meta;
    for (const segment of key.split('.')) {
      if (!target || typeof target !== 'object' || Array.isArray(target) || !Object.prototype.hasOwnProperty.call(target, segment)) {
        return { exists: false, value: null };
      }
      target = (target as Record<string, unknown>)[segment];
    }
    return { exists: true, value: target };
  }

  function getChatProcessingFromControlplane(args: Record<string, unknown>): { status: 'success'; data: { boardId: string; cardId: string; active: boolean } } {
    const { cardId } = requireControlplaneCardArgs(args);
    const data = createMcpFacade().getChatProcessing({ cardId });
    return { status: 'success', data: { boardId, cardId, active: data.active } };
  }

  function setCardMetaFromControlplane(args: Record<string, unknown>): { status: 'success'; data: { boardId: string; cardId: string; key: string } } {
    const { cardId } = requireControlplaneCardArgs(args);
    const key = getCardMetaKey(args);
    if (!Object.prototype.hasOwnProperty.call(args, 'value')) throw Object.assign(new Error('MCP tool requires value'), { statusCode: 400 });
    expectControlplaneSuccess(mcpCardStoreFacade().patch({
      params: { id: cardId, path: `meta.${key}` },
      body: { value: args.value },
    }), 'cardStore.patch');
    return { status: 'success', data: { boardId, cardId, key } };
  }

  function getCardMetaFromControlplane(args: Record<string, unknown>): { status: 'success'; data: { boardId: string; cardId: string; key: string; exists: boolean; value: unknown } } {
    const { cardId } = requireControlplaneCardArgs(args);
    const key = getCardMetaKey(args);
    const result = expectControlplaneSuccess<{ cards?: unknown[] }>(mcpCardStoreFacade().get({ params: { id: cardId } }), 'cardStore.get');
    const card = Array.isArray(result.cards) && result.cards.length > 0 && result.cards[0] && typeof result.cards[0] === 'object' && !Array.isArray(result.cards[0])
      ? result.cards[0] as Record<string, unknown>
      : null;
    if (!card) throw Object.assign(new Error(`Card "${cardId}" not found`), { statusCode: 404 });
    const metaValue = readCardMetaValue(card, key);
    return { status: 'success', data: { boardId, cardId, key, exists: metaValue.exists, value: metaValue.value } };
  }

  function createMcpToolRegistry(mcp: ReturnType<typeof createMcpFacade>): Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>> {
    return {
      'discover.source-kinds': () => mcp.discoverSourceKinds(),
      'inspect.board-runtime-status': () => mcp.inspectBoardRuntimeStatus(),
      'inspect.card-definition-and-runtime': (args) => mcp.inspectCardDefinitionAndRuntime({ cardId: getMcpArgString(args, 'card_id') }),
      'inspect.chat-messages-on-cards': (args) => {
        const lastUserTurns = getMcpArgNumber(args, 'tail_turns');
        const tail = getMcpArgNumber(args, 'tail');
        const turnId = getMcpArgString(args, 'turn_id');
        const allTurns = args['all_turns'] === true;
        const tailTurnsBeforeId = getMcpArgString(args, 'tail_turns_before_id');
        return mcp.inspectChatMessagesOnCards({
          cardId: getMcpArgString(args, 'card_id'),
          ...(lastUserTurns !== undefined ? { lastUserTurns } : {}),
          ...(tail !== undefined ? { tail } : {}),
          ...(turnId ? { turnId } : {}),
          ...(allTurns ? { allTurns: true } : {}),
          ...(tailTurnsBeforeId ? { tailTurnsBeforeId } : {}),
        });
      },
      'inspect.file-contents': (args) => mcp.inspectFileContents({
        cardId: getMcpArgString(args, 'card_id'),
        fileIdx: Number(getMcpArgNumber(args, 'file_idx')),
      }),
      'preflight.validate-candidate-card-definition': (args) => mcp.preflightValidateCandidateCardDefinition({
        candidateCardContent: getRequiredMcpArgRecord(args, 'candidate_card_content', 'candidate_card_content'),
      }),
      'preflight.materialize-candidate-card': (args) => mcp.preflightMaterializeCandidateCard({
        candidateCardContent: getRequiredMcpArgRecord(args, 'candidate_card_content', 'candidate_card_content'),
        mockRequires: getRequiredMcpArgRecord(args, 'mock_requires', 'mock_requires'),
        mockFetchedSources: getRequiredMcpArgRecord(args, 'mock_fetched_sources', 'mock_fetched_sources'),
      }),
      'preflight.probe-single-source-in-candidate-card': (args) => mcp.preflightProbeSingleSourceInCandidateCard({
        candidateCardContent: getRequiredMcpArgRecord(args, 'candidate_card_content', 'candidate_card_content'),
        mockProjections: getMcpArgRecord(args, 'mock_projections'),
        sourceIdx: getRequiredMcpArgNumber(args, 'source_idx', 'source_idx'),
      }),
      'preflight.run-single-source-in-candidate-card': (args) => mcp.preflightRunSingleSourceInCandidateCard({
        candidateCardContent: getRequiredMcpArgRecord(args, 'candidate_card_content', 'candidate_card_content'),
        mockProjections: getMcpArgRecord(args, 'mock_projections'),
        sourceIdx: getRequiredMcpArgNumber(args, 'source_idx', 'source_idx'),
      }),
      'preflight.run-single-source-in-live-card': (args) => mcp.preflightRunSingleSourceInLiveCard({
        cardId: getMcpArgString(args, 'card_id'),
        sourceIdx: getRequiredMcpArgNumber(args, 'source_idx', 'source_idx'),
        mockRequires: getRequiredMcpArgRecord(args, 'mock_requires', 'mock_requires'),
      }),
      'preflight.run-one-cycle-with-candidate-card': (args) => mcp.preflightRunOneCycleWithCandidateCard({
        candidateCardContent: getRequiredMcpArgRecord(args, 'candidate_card_content', 'candidate_card_content'),
        mockRequires: getMcpArgRecord(args, 'mock_requires'),
      }),
      'manage.read-card': (args) => mcp.manageReadCard({ cardId: getMcpArgString(args, 'card_id') }),
      'stage-ai-response-and-any-attachments': (args) => {
        const turnId = getMcpArgString(args, 'turn_id');
        if (!turnId) {
          throw Object.assign(
            new Error('stage-ai-response-and-any-attachments requires a non-empty turn_id'),
            { statusCode: 400 },
          );
        }
        return mcp.manageAddChatEntryAndAnyAttachments({
          cardId: getMcpArgString(args, 'card_id'),
          role: 'assistant',
          ...(typeof args.text === 'string' ? { text: args.text } : {}),
          ...(turnId ? { turn: turnId } : {}),
          ...(Array.isArray(args.files) ? { files: args.files as unknown[] } : {}),
        });
      },
      'manage.upsert-card': (args) => mcp.manageUpsertCard({
        cardId: getMcpArgString(args, 'card_id'),
        candidateCardContent: getMcpArgRecord(args, 'candidate_card_content'),
      }),
      'manage.remove-card': (args) => mcp.manageRemoveCard({ cardId: getMcpArgString(args, 'card_id') }),
    };
  }

  function createMcpControlplaneToolRegistry(): Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>> {
    return {
      'getstate.is-chat-processing': (args) => getChatProcessingFromControlplane(args),
      'setstate.chat-processing-started': (args) => setChatProcessingFromControlplane(args, true),
      'setstate.chat-processing-done': (args) => setChatProcessingFromControlplane(args, false),
      'getstate.card-meta': (args) => getCardMetaFromControlplane(args),
      'setstate.card-meta': (args) => setCardMetaFromControlplane(args),
      'manage.upload-card-file': (args) => {
        const requestBoardId = getMcpArgString(args, 'board_id');
        const cardId = getMcpArgString(args, 'card_id');
        const fileName = getMcpArgString(args, 'file_name');
        const contentType = getMcpArgString(args, 'content_type') || 'application/octet-stream';
        const bytes = parseMcpUploadBytes(args);

        if (!requestBoardId) throw Object.assign(new Error('manage.upload-card-file requires board_id'), { statusCode: 400 });
        if (requestBoardId !== boardId) throw Object.assign(new Error(`Unknown board_id: ${requestBoardId}`), { statusCode: 400 });
        if (!cardId) throw Object.assign(new Error('manage.upload-card-file requires card_id'), { statusCode: 400 });
        if (!fileName) throw Object.assign(new Error('manage.upload-card-file requires file_name'), { statusCode: 400 });
        if (!bytes) throw Object.assign(new Error('manage.upload-card-file requires args.bytes, args.text, or args.base64'), { statusCode: 400 });

        return uploadCardFile(cardId, fileName, contentType, bytes, { inChat: false });
      },
    };
  }

  async function invokeMcpTool(tool: string, args: Record<string, unknown>, registry: Record<string, (args: Record<string, unknown>) => unknown | Promise<unknown>>): Promise<unknown> {
    const handler = registry[tool];
    if (!handler) {
      throw Object.assign(new Error(`Unknown MCP tool: ${tool}`), { statusCode: 400 });
    }
    const result = await handler(args);
    if (result && typeof result === 'object' && !Array.isArray(result)) {
      const record = result as Record<string, unknown>;
      const status = record.status;
      if (status === 'success') {
        return Object.prototype.hasOwnProperty.call(record, 'data')
          ? result
          : { status: 'success', data: {} };
      }
      if (status === 'fail' || status === 'error') {
        return result;
      }
    }
    return { status: 'success', data: result };
  }

  function extractMcpFailureMessage(result: unknown, fallback: string): string {
    if (!result || typeof result !== 'object' || Array.isArray(result)) return fallback;
    const record = result as Record<string, unknown>;
    if (typeof record.error === 'string' && record.error.trim()) return record.error;
    if (record.step === 'validate') {
      const validation = record.validation;
      if (validation && typeof validation === 'object' && !Array.isArray(validation)) {
        const validationRecord = validation as Record<string, unknown>;
        const validationData = validationRecord.data;
        if (validationData && typeof validationData === 'object' && !Array.isArray(validationData)) {
          const issues = (validationData as Record<string, unknown>).issues;
          if (Array.isArray(issues)) {
            const firstIssue = issues.find((issue) => typeof issue === 'string' && issue.trim());
            if (typeof firstIssue === 'string') return `Validation failed: ${firstIssue}`;
          }
          const errors = (validationData as Record<string, unknown>).errors;
          if (Array.isArray(errors) && errors.length > 0) {
            return 'Validation failed';
          }
        }
      }
      return 'Validation failed';
    }
    return fallback;
  }

  // ── Status & runtime artifacts ───────────────────────────────────────────

  function readStatusSnapshot(): unknown {
    const statuses = boardContexts.map((ctx) => {
      try {
        const kv = ctx.boardAdapter.kvStorageForRef(ctx.outputsStoreRef);
        const persisted = kv.read('status');
        if (persisted !== null && persisted !== undefined) return persisted;
      } catch {
        // Fall back to notification memory if direct KV read fails.
      }
      return ctx.notification.status;
    }).filter(Boolean);
    if (statuses.length === 0) return null;
    if (statuses.length === 1) return statuses[0];

    // Merge multiple board statuses into a single snapshot
    const mergedCards: unknown[] = [];
    const summaryKeys = ['completed', 'eligible', 'pending', 'blocked', 'unresolved', 'failed', 'in_progress', 'orphan_cards'];
    const totals: Record<string, number> = {};
    for (const k of summaryKeys) totals[k] = 0;

    for (const status of statuses) {
      const obj = status as Record<string, unknown>;
      const cards = Array.isArray(obj.cards) ? obj.cards : [];
      mergedCards.push(...cards);
      for (const k of summaryKeys) {
        totals[k] += Number((obj as any)?.summary?.[k] || 0);
      }
    }

    const first = statuses[0] as Record<string, unknown>;
    return {
      ...first,
      cards: mergedCards,
      summary: {
        ...((first.summary || {}) as Record<string, unknown>),
        card_count: mergedCards.length,
        ...totals,
      },
    };
  }

  function readCardRuntimeArtifacts(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const process = (ctx: BoardContext) => {
      for (const [cardId, values] of Object.entries(ctx.notification.computedValues)) {
        const card = ctx.notification.cards[cardId] as Record<string, unknown> | undefined;
        out[cardId] = {
          schema_version: 'v1',
          card_id: cardId,
          card_data: card?.card_data ?? {},
          computed_values: values ?? {},
        };
      }
    };
    for (const ctx of boardContexts) process(ctx);
    return out;
  }

  function readDataObjectsByToken(): Record<string, unknown> {
    const merged: Record<string, unknown> = {};
    for (const ctx of boardContexts) {
      Object.assign(merged, ctx.notification.dataObjects || {});
    }
    return merged;
  }

  function buildPublishedRuntimePayload(): unknown {
    const cardDefinitions = readCardDefinitions();
    const rawArtifacts = readCardRuntimeArtifacts();
    const dataObjectsByToken = readDataObjectsByToken();
    const cardRuntimeById: Record<string, unknown> = {};

    for (const cardDef of cardDefinitions) {
      if (!cardDef?.id) continue;
      const id = cardDef.id as string;
      const raw = (rawArtifacts[id] || {}) as Record<string, unknown>;
      const cardData: Record<string, unknown> = {
        ...((raw.card_data && typeof raw.card_data === 'object' ? raw.card_data
          : cardDef.card_data && typeof cardDef.card_data === 'object' ? cardDef.card_data
            : {}) as Record<string, unknown>),
      };
      cardRuntimeById[id] = {
        schema_version: raw.schema_version || 'v1',
        card_id: raw.card_id || id,
        card_data: cardData,
        computed_values: raw.computed_values && typeof raw.computed_values === 'object' ? raw.computed_values : {},
      };
    }

    const cardChatsByCardId: Record<string, unknown> = {};
    for (const cardDef of cardDefinitions) {
      if (!cardDef?.id) continue;
      const id = cardDef.id as string;
      try {
        const records = readChatRecords(id);
        const processing = createMcpFacade().getChatProcessing({ cardId: id }).active;
        if (records.length > 0 || processing) {
          cardChatsByCardId[id] = {
            messages: records.map((r: Record<string, unknown>) => ({
              role: String(r.role || 'system'),
              text: String(r.text || ''),
              files: Array.isArray(r.files) ? r.files : [],
            })),
            receiving: false,
            processing,
          };
        }
      } catch { /* ignore errors reading chat records for this card */ }
    }

    return {
      boardId,
      cardDefinitions,
      statusSnapshot: readStatusSnapshot(),
      dataObjectsByToken,
      cardRuntimeById,
      cardChatsByCardId,
    };
  }

  // ── Card mutations ───────────────────────────────────────────────────────

  function mutateCard(cardId: string, updateFn: (card: Record<string, unknown>) => Record<string, unknown> | void, opts?: { syncBoard?: boolean; restartOnlyIfChanged?: boolean }): void {
    const syncBoard = opts?.syncBoard !== false;
    const restartOnlyIfChanged = opts?.restartOnlyIfChanged === true;
    const ctx = cardContextForCard(cardId);
    if (!ctx) throw Object.assign(new Error(`Card not found: ${cardId}`), { statusCode: 404 });

    const card = readCardFromStore(cardId);
    if (!card) throw Object.assign(new Error(`Card not found: ${cardId}`), { statusCode: 404 });

    const beforeJson = restartOnlyIfChanged ? JSON.stringify(card) : null;
    const nextCard = updateFn(card) || card;

    // If restartOnlyIfChanged and the card content is identical, skip the write and the board sync entirely.
    if (restartOnlyIfChanged && JSON.stringify(nextCard) === beforeJson) return;

    const setResult = ctx.cardStore.set({ body: nextCard });
    if (setResult.status !== 'success') {
      throw Object.assign(new Error((setResult as any).error || `Failed to persist card: ${cardId}`), { statusCode: 500 });
    }

    if (syncBoard) {
      const upsertResult = ctx.board.upsertCard({ params: { cardId, restart: true } });
      if (upsertResult.status !== 'success') {
        throw Object.assign(new Error((upsertResult as any).error || `Failed to upsert card: ${cardId}`), { statusCode: 500 });
      }
    }
  }

  function updateCard(cardId: string, updateFn: (card: Record<string, unknown>) => Record<string, unknown> | void): void {
    mutateCard(cardId, updateFn, { syncBoard: true });
  }

  function updateCardLocalOnly(cardId: string, updateFn: (card: Record<string, unknown>) => Record<string, unknown> | void): void {
    mutateCard(cardId, updateFn, { syncBoard: false });
  }

  function retriggerCard(cardId: string): void {
    const ctx = cardContextForCard(cardId);
    if (!ctx) throw Object.assign(new Error(`Card not found: ${cardId}`), { statusCode: 404 });
    const card = readCardFromStore(cardId);
    if (!card) throw Object.assign(new Error(`Card not found: ${cardId}`), { statusCode: 404 });
    const upsertResult = ctx.board.upsertCard({ params: { cardId, restart: true } });
    if (upsertResult.status !== 'success') {
      throw Object.assign(new Error((upsertResult as any).error || `Failed to retrigger card: ${cardId}`), { statusCode: 500 });
    }
  }

  function patchCard(cardId: string, patch: Record<string, unknown>): void {
    mutateCard(cardId, (card) => {
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

  function normalizeDisplayFileName(name: string): string {
    const input = String(name || '').trim();
    if (!input) return 'upload.bin';
    // Extract basename: take last segment after / or \
    const lastSlash = Math.max(input.lastIndexOf('/'), input.lastIndexOf('\\'));
    const base = lastSlash >= 0 ? input.slice(lastSlash + 1) : input;
    return base || 'upload.bin';
  }

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

  function readCardStoredFileNames(cardId: string): string[] {
    const names: string[] = [];
    try {
      const card = readCardFromStore(cardId);
      if (!card) return names;
      const metadata = cardFileMetadataStoreInstance().read(card.card_data && typeof card.card_data === 'object' ? card.card_data : null);
      for (const entry of metadata) names.push((entry as any).stored_name);
    } catch { /* ignore */ }
    return names;
  }

  function persistUploadedFile(cardId: string, requestedName: string, contentType: string, buffer: Uint8Array): Record<string, unknown> {
    const sid = safeCardId(cardId);
    const stores = artifactsStores(cardId);
    const displayName = normalizeDisplayFileName(requestedName);
    const fileStore = fileArtifactsForCard(cardId);
    const storedName = fileStore
      ? fileStore.allocateStoredName(sid, displayName, {
        seedNames: readCardStoredFileNames(cardId),
        maxLen: MAX_STORED_FILE_NAME_LEN,
      })
      : `${String(Date.now())}-${displayName}`;

    if (stores.files) {
      stores.files.putBytes(`${sid}/${storedName}`, new Uint8Array(buffer), contentType || 'application/octet-stream');
    }

    return {
      name: displayName,
      stored_name: storedName,
      size: buffer.length,
      mime_type: contentType || 'application/octet-stream',
      uploaded_at: new Date().toISOString(),
    };
  }

  function uploadCardFile(
    cardId: string,
    requestedName: string,
    contentType: string,
    buffer: Uint8Array,
    opts?: { inChat?: boolean; turnId?: string },
  ): { ok: true; file: Record<string, unknown> } {
    if (!buffer.length) {
      throw Object.assign(new Error('Empty upload body'), { statusCode: 400 });
    }

    const inChat = opts?.inChat === true;
    const file = persistUploadedFile(cardId, requestedName, contentType, buffer);
    let uploadedFileIndex: number | null = null;

    updateCardLocalOnly(cardId, (card) => {
      const now = new Date().toISOString();
      const cardData = card.card_data && typeof card.card_data === 'object' ? card.card_data as Record<string, unknown> : {};
      card.card_data = cardData;
      const incoming = cardFileMetadataStoreInstance().normalizeIncoming([{
        name: file.name,
        stored_name: file.stored_name,
        size: file.size,
        mime_type: file.mime_type,
        uploaded_at: file.uploaded_at || now,
        chat: inChat,
      }], now);
      const merged = cardFileMetadataStoreInstance().merge(cardData, incoming);
      uploadedFileIndex = merged.findIndex((entry) => entry.stored_name === file.stored_name);
      return card;
    });

    if (inChat) {
      const idxSuffix = typeof uploadedFileIndex === 'number' && uploadedFileIndex >= 0 ? ` #${uploadedFileIndex}` : '';
      writeChatRecord(cardId, 'system', `file uploaded: ${file.name} as ${file.stored_name}${idxSuffix}`, [], opts?.turnId ?? '');
    }

    return { ok: true, file };
  }

  function resolveChatHandlerTarget(cardId: string): {
    ctx: BoardContext;
    handlerFlow: unknown;
    handlerRef: import('./types.js').ExecutionRef;
  } | null {
    const ctx = cardContextForCard(cardId);
    if (!ctx) return null;

    const flowResult = ctx.board.getConfig({ params: { key: 'chat-handler-flow' } });
    const handlerFlow = flowResult.status === 'success' ? (flowResult as any).data?.value : null;
    const handlerRef = ctx.chatHandlerRef;
    if (handlerFlow == null && (!handlerRef || typeof handlerRef !== 'object')) return null;

    return {
      ctx,
      handlerFlow,
      handlerRef: handlerRef as import('./types.js').ExecutionRef,
    };
  }

  // ── Chat handler invocation ──────────────────────────────────────────────

  function invokeChatHandler(cardId: string, lastEntryId: string, processingAlreadySet = false, turnId = ''): void {
    const target = resolveChatHandlerTarget(cardId);
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

    if (!chatFlowRunner) {
      if (handlerFlow != null) {
        try { createMcpFacade().setChatProcessing({ cardId, active: false }); } catch {}
        logger.warn(`[chat-handler-flow] configured for card "${cardId}" but no chatFlowRunner was provided`);
        return;
      }
    }

    if (handlerFlow != null) {
      const flowRunner = chatFlowRunner;
      if (!flowRunner) return;
      flowRunner.run(handlerFlow, args, {
        boardId,
        cardId: String(cardId),
        label: ctx.label,
        logger,
        serverUrl,
        executionExtra,
      }).then(
        (result) => {
          if (result.dispatched) {
            logger.info(`[chat-handler-flow] invoked for card "${cardId}" (boardId: "${boardId}")`);
          } else {
            try { chatStorage.setProcessing(cardId, false); } catch {}
            logger.warn(`[chat-handler-flow] dispatch failed for card "${cardId}": ${result.error || 'unknown'}`);
          }
        },
        (err) => {
          try { chatStorage.setProcessing(cardId, false); } catch {}
          logger.warn(`[chat-handler-flow] invoke failed for card "${cardId}": ${err?.message || String(err)}`);
        },
      );
      return;
    }

    const executionRef = handlerRef;
    if (!executionRef) return;
    invocationAdapter.invoke(executionRef, args).then(
      (result) => {
        if (result.dispatched) {
          logger.info(`[chat-handler] invoked for card "${cardId}" (boardId: "${boardId}")`);
        } else {
          try { chatStorage.setProcessing(cardId, false); } catch {}
          logger.warn(`[chat-handler] dispatch failed for card "${cardId}": ${result.error || 'unknown'}`);
        }
      },
      (err) => {
        try { chatStorage.setProcessing(cardId, false); } catch {}
        logger.warn(`[chat-handler] invoke failed for card "${cardId}": ${err?.message || String(err)}`);
      },
    );
  }

  // ── Card actions ─────────────────────────────────────────────────────────

  function applyCardAction(cardId: string, actionType: string, payload: Record<string, unknown> | null): void {
    const persistCard = actionType === 'chat-send' ? updateCardLocalOnly : updateCard;
    let chatHandlerResult: { cardId: string; lastEntryId: string; processingAlreadySet: boolean } | undefined;

    persistCard(cardId, (card) => {
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
          // Emit SSE notification so connected clients receive updated chat state immediately
          try {
            const allRecords = readChatRecords(cardId);
            broadcastNotificationBatchToSseClients([{
              kind: 'card_chats',
              cardId,
              messages: allRecords.map((r: Record<string, unknown>) => ({
                role: String(r.role || 'system'),
                text: String(r.text || ''),
                files: Array.isArray(r.files) ? r.files : [],
              })),
              receiving: true,
              processing: chatStorage.isProcessing(cardId),
            }]);
          } catch { /* best-effort SSE broadcast */ }
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
      invokeChatHandler(chatHandlerResult.cardId, chatHandlerResult.lastEntryId, chatHandlerResult.processingAlreadySet, (chatHandlerResult as { turnId?: string }).turnId ?? '');
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

  function resolveCardFileDownloadPayload(cardId: string, idx: number, expectedStoredName: string | null): {
    fileRecord: Record<string, unknown>;
    bytes: Uint8Array;
  } {
    const card = readCardFromStore(cardId);
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
    const bytes = stores.files ? stores.files.getBytes(fileKey) : null;
    if (!bytes) throw Object.assign(new Error('File not found'), { statusCode: 404 });

    return { fileRecord, bytes };
  }

  function sendCardFileDownloadResponse(res: RuntimeResponse, cardId: string, idx: number, expectedStoredName: string | null): void {
    const { fileRecord, bytes } = resolveCardFileDownloadPayload(cardId, idx, expectedStoredName);

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

  function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
    const totalLen = arrays.reduce((acc, a) => acc + a.length, 0);
    const result = new Uint8Array(totalLen);
    let offset = 0;
    for (const a of arrays) { result.set(a, offset); offset += a.length; }
    return result;
  }

  function reportSourceFetchedInternal(token: string, payload: Record<string, unknown>): CommandResult {
    const ref = typeof payload.ref === 'string' ? payload.ref.trim() : '';
    if (!ref) return { status: 'fail', error: 'board-worker success callback requires body.ref' };
    const ctx = boardContexts[0];
    if (!ctx) return { status: 'fail', error: 'no board context' };
    return ctx.board.sourceDataFetched({ params: { token, ref } });
  }

  function reportSourceFetchFailureInternal(token: string, payload: Record<string, unknown>): CommandResult {
    const reason = typeof payload.reason === 'string' && payload.reason.trim()
      ? payload.reason
      : 'unknown';
    const ctx = boardContexts[0];
    if (!ctx) return { status: 'fail', error: 'no board context' };
    return ctx.board.sourceDataFetchFailure({ params: { token, reason } });
  }

  function applyBoardWorkerCallback(
    token: string,
    outcome: 'success' | 'failure',
    payload: Record<string, unknown>,
  ): { statusCode: number; body: unknown } {
    const trimmedToken = String(token || '').trim();
    if (!trimmedToken) {
      return { statusCode: 400, body: { error: 'callback token is required' } };
    }
    const result = outcome === 'success'
      ? reportSourceFetchedInternal(trimmedToken, payload)
      : reportSourceFetchFailureInternal(trimmedToken, payload);
    if (result.status === 'success') return { statusCode: 200, body: result };
    if (result.status === 'fail') return { statusCode: 400, body: { error: result.error } };
    return { statusCode: 500, body: { error: result.error } };
  }

  // ── SSE ──────────────────────────────────────────────────────────────────

  let sseEventId = 0;

  function buildSseFrame(payload: unknown): string {
    const jsonStr = JSON.stringify(payload);
    sseEventId++;
    return `id: ${sseEventId}\ndata: ${jsonStr}\n\n`;
  }

  function flushSseTransport(res: RuntimeResponse): void {
    const resWithTransport = res as RuntimeResponse & {
      flushHeaders?: () => void;
      flush?: () => void;
      socket?: {
        setNoDelay?: (noDelay?: boolean) => void;
        uncork?: () => void;
      } | null;
    };
    try { resWithTransport.flushHeaders?.(); } catch { /* ignore */ }
    try { resWithTransport.flush?.(); } catch { /* ignore */ }
    try { resWithTransport.socket?.setNoDelay?.(true); } catch { /* ignore */ }
    try { resWithTransport.socket?.uncork?.(); } catch { /* ignore */ }
  }

  function disconnectSseClient(clientId: string, expectedRes?: RuntimeResponse): void {
    const client = sseClients.get(clientId);
    if (!client) return;
    if (expectedRes && client.res !== expectedRes) return;
    sseClients.delete(clientId);
    stopChatSubscriptionScanIfIdle();
    try { onSseClientDisconnected?.(clientId); } catch { /* ignore host hook failures */ }
    try { client.res.end(); } catch { /* ignore */ }
  }

  function writeSseFrame(clientId: string, payload: unknown): void {
    const client = sseClients.get(clientId);
    if (!client) return;
    const frame = buildSseFrame(payload);
    try {
      client.res.write(frame);
      flushSseTransport(client.res);
    } catch {
      disconnectSseClient(clientId, client.res);
    }
  }

  function handleChannelSubscription(
    res: RuntimeResponse,
    clientId: string,
    channelName: string,
    params: { cardId?: string },
    subscribed: boolean,
  ): void {
    if (!sseClients.has(clientId)) {
      json(res, 404, { error: `SSE client not connected: ${clientId}` });
      return;
    }
    if (subscribed) {
      onChannelSubscribed?.(clientId, channelName, params);
    } else {
      onChannelUnsubscribed?.(clientId, channelName, params);
    }
    json(res, 200, {
      ok: true,
      clientId,
      channelName,
      ...(params.cardId ? { cardId: params.cardId } : {}),
      subscribed,
    });
  }

  function currentSubscribedChatCardIds(): string[] {
    const ids = new Set<string>();
    for (const client of sseClients.values()) {
      for (const cardId of client.subscribedChatCardIds) ids.add(cardId);
    }
    return Array.from(ids);
  }

  /** Returns true when there are new messages or the processing flag changed since last call. Advances cursor as a side effect. */
  function hasChatChanges(cardId: string): boolean {
    const lastCursor = lastChatCursorByCardId.has(cardId) ? lastChatCursorByCardId.get(cardId)! : null;
    const { cursor: newCursor } = chatStorage.readAfter(cardId, lastCursor);
    const processing = chatStorage.isProcessing(cardId);
    const processingChanged = processing !== (lastChatProcessingByCardId.get(cardId) ?? false);
    const hasNewRecords = newCursor !== lastCursor;
    if (hasNewRecords) lastChatCursorByCardId.set(cardId, newCursor);
    lastChatProcessingByCardId.set(cardId, processing);
    return hasNewRecords || processingChanged;
  }

  function buildCardChatsNotification(cardId: string, receiving = true): Record<string, unknown> {
    const records = readChatRecords(cardId);
    const sentAtMs = Date.now();
    return {
      kind: 'card_chats',
      cardId,
      sentAt: new Date(sentAtMs).toISOString(),
      sentAtMs,
      messages: records.map((r: Record<string, unknown>) => ({
        role: String(r.role || 'system'),
        text: String(r.text || ''),
        files: Array.isArray(r.files) ? r.files : [],
      })),
      receiving,
      processing: chatStorage.isProcessing(cardId),
    };
  }

  function broadcastCardChatsToSubscribedSseClients(cardId: string, receiving = true): void {
    const payload = { kind: 'notification-batch', notifications: [buildCardChatsNotification(cardId, receiving)] };
    for (const [clientId, client] of sseClients.entries()) {
      if (!client.subscribedChatCardIds.has(cardId)) continue;
      writeSseFrame(clientId, payload);
    }
  }

  function stopChatSubscriptionScanIfIdle(): void {
    if (currentSubscribedChatCardIds().length > 0) return;
    if (chatSubscriptionScanTimer) {
      clearInterval(chatSubscriptionScanTimer);
      chatSubscriptionScanTimer = null;
    }
    lastChatCursorByCardId.clear();
    lastChatProcessingByCardId.clear();
  }

  function ensureChatSubscriptionScan(): void {
    if (chatSubscriptionScanTimer) return;
    const scan = () => {
      const activeCardIds = currentSubscribedChatCardIds();
      if (activeCardIds.length === 0) {
        stopChatSubscriptionScanIfIdle();
        return;
      }
      const activeSet = new Set(activeCardIds);
      for (const cardId of Array.from(lastChatCursorByCardId.keys())) {
        if (!activeSet.has(cardId)) lastChatCursorByCardId.delete(cardId);
      }
      for (const cardId of Array.from(lastChatProcessingByCardId.keys())) {
        if (!activeSet.has(cardId)) lastChatProcessingByCardId.delete(cardId);
      }
      for (const cardId of activeCardIds) {
        if (hasChatChanges(cardId)) {
          broadcastCardChatsToSubscribedSseClients(cardId, true);
        }
      }
    };
    scan();
    chatSubscriptionScanTimer = setInterval(scan, 1000);
  }

  function subscribeClientToCardChats(clientId: string, cardId: string): boolean {
    const client = sseClients.get(clientId);
    if (!client) return false;
    client.subscribedChatCardIds.add(cardId);
    // Initialise cursor to latest so we only push deltas from this point forward.
    const { cursor: latestCursor } = chatStorage.readAfter(cardId, null);
    lastChatCursorByCardId.set(cardId, latestCursor);
    lastChatProcessingByCardId.set(cardId, chatStorage.isProcessing(cardId));
    ensureChatSubscriptionScan();
    writeSseFrame(clientId, { kind: 'notification-batch', notifications: [buildCardChatsNotification(cardId, true)] });
    return true;
  }

  function unsubscribeClientFromCardChats(clientId: string, cardId: string): boolean {
    const client = sseClients.get(clientId);
    if (!client) return false;
    client.subscribedChatCardIds.delete(cardId);
    if (!currentSubscribedChatCardIds().includes(cardId)) {
      lastChatCursorByCardId.delete(cardId);
      lastChatProcessingByCardId.delete(cardId);
    }
    stopChatSubscriptionScanIfIdle();
    return true;
  }

  function isChatScopedNotification(notification: unknown): notification is Record<string, unknown> {
    if (!notification || typeof notification !== 'object') return false;
    const kind = (notification as Record<string, unknown>).kind;
    return kind === 'card_chats' || kind === 'chat_messages';
  }

  function broadcastNotificationBatchToSseClients(notifications: unknown[]): void {
    if (!notifications || notifications.length === 0) return;
    const generalNotifications: unknown[] = [];
    const chatCardIds = new Set<string>();
    for (const note of notifications) {
      if (isChatScopedNotification(note) && typeof (note as Record<string, unknown>).cardId === 'string') {
        chatCardIds.add(String((note as Record<string, unknown>).cardId));
      } else {
        generalNotifications.push(note);
      }
    }
    if (generalNotifications.length > 0) {
      const payload = { kind: 'notification-batch', notifications: generalNotifications };
      for (const clientId of sseClients.keys()) writeSseFrame(clientId, payload);
    }
    for (const cardId of chatCardIds) broadcastCardChatsToSubscribedSseClients(cardId, true);
  }

  function handleSse(req: RuntimeRequest, res: RuntimeResponse, clientId: string): void {
    const existing = sseClients.get(clientId);
    const subscribedChatCardIds = existing ? new Set(existing.subscribedChatCardIds) : new Set<string>();
    if (existing) {
      disconnectSseClient(clientId, existing.res);
    }
    res.writeHead(200, {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    flushSseTransport(res);
    sseClients.set(clientId, { res, subscribedChatCardIds });

    // On reconnect, Last-Event-ID tells us the client's last received id.
    // We always send the current full snapshot (replay = latest state).
    const payload = buildPublishedRuntimePayload();
    const frame = buildSseFrame(payload);
    res.write(frame);
    try { onSseClientConnected?.(clientId, (customPayload: unknown) => { writeSseFrame(clientId, customPayload); }); } catch { /* ignore host hook failures */ }

    const keepAlive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* ignore */ }
    }, 15_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      disconnectSseClient(clientId, res);
    });
  }

  // ── Route handler ────────────────────────────────────────────────────────

  async function handleRuntimeApi(req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL): Promise<boolean> {
    const method = req.method || 'GET';
    const url = parsedUrl;
    const p = url.pathname;

    try {
      if (method === 'GET' && p === `${apiBasePath}/init-board`) {
        await initBoardAndSetup();
        json(res, 200, buildPublishedRuntimePayload());
        return true;
      }

      if (method === 'GET' && p === `${apiBasePath}/sse`) {
        // Initialize runtime first, then register SSE client, then bootstrap.
        // This prevents a race where bootstrap emits early notifications before
        // the newly connected SSE client is added to sseClients.
        await initBoardAndSetup();
        const clientId = String(url.searchParams.get('clientId') || '').trim();
        if (!clientId) {
          json(res, 400, { error: 'clientId query param is required for SSE' });
          return true;
        }
        handleSse(req, res, clientId);
        for (let i = 0; i < boardContexts.length; i++) {
          publishPersistedStateSnapshot(boardContexts[i]);
          upsertCardsFromSource(boardContexts[i], i);
        }
        return true;
      }

      if (method === 'GET' && p === `${apiBasePath}/board-status`) {
        json(res, 200, buildPublishedRuntimePayload());
        return true;
      }

      const boardWorkerCallbackMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/callback/board-worker/([^/]+)/(success|failure)$`));
      if (method === 'POST' && boardWorkerCallbackMatch) {
        await initBoardAndSetup();
        const token = decodeURIComponent(boardWorkerCallbackMatch[1]);
        const outcome = boardWorkerCallbackMatch[2] as 'success' | 'failure';
        const body = await readJsonBody(req);
        const callbackResult = applyBoardWorkerCallback(token, outcome, body);
        json(res, callbackResult.statusCode, callbackResult.body);
        return true;
      }

      if (method === 'POST' && p === `${apiBasePath}/mcp`) {
        await bootstrapBoard();
        const body = await readJsonBody(req);
        const tool = typeof body.tool === 'string' ? body.tool.trim() : '';
        const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
          ? body.args as Record<string, unknown>
          : {};
        if (!tool) {
          json(res, 400, { error: 'tool is required' });
          return true;
        }
        if (tool === 'inspect.file-contents') {
          json(res, 400, { error: 'inspect.file-contents is only available on /mcp-raw' });
          return true;
        }
        try {
          const result = await invokeMcpTool(tool, args, createMcpToolRegistry(createMcpFacade()));
          if (result && typeof result === 'object' && !Array.isArray(result)) {
            const record = result as Record<string, unknown>;
            if (record.status === 'fail') {
              json(res, 400, { error: extractMcpFailureMessage(result, 'Request failed') });
              return true;
            }
            if (record.status === 'error') {
              json(res, 500, { error: extractMcpFailureMessage(result, 'Internal error') });
              return true;
            }
          }
          json(res, 200, result);
        } catch (error) {
          const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
            ? Number((error as { statusCode: number }).statusCode)
            : 500;
          const message = error instanceof Error ? error.message : String(error);
          json(res, statusCode, { error: message });
        }
        return true;
      }

      if (method === 'POST' && p === `${apiBasePath}/mcp-controlplane`) {
        await bootstrapBoard();
        const body = await readJsonBody(req);
        const tool = typeof body.tool === 'string' ? body.tool.trim() : '';
        const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
          ? body.args as Record<string, unknown>
          : {};
        if (!tool) {
          json(res, 400, { error: 'tool is required' });
          return true;
        }
        try {
          const result = await invokeMcpTool(tool, args, createMcpControlplaneToolRegistry());
          if (result && typeof result === 'object' && !Array.isArray(result)) {
            const record = result as Record<string, unknown>;
            if (record.status === 'fail') {
              json(res, 400, { error: extractMcpFailureMessage(result, 'Request failed') });
              return true;
            }
            if (record.status === 'error') {
              json(res, 500, { error: extractMcpFailureMessage(result, 'Internal error') });
              return true;
            }
          }
          json(res, 200, result);
        } catch (error) {
          const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
            ? Number((error as { statusCode: number }).statusCode)
            : 500;
          const message = error instanceof Error ? error.message : String(error);
          json(res, statusCode, { error: message });
        }
        return true;
      }

      if (method === 'POST' && p === `${apiBasePath}/mcp-raw`) {
        await bootstrapBoard();
        const body = await readJsonBody(req);
        const tool = typeof body.tool === 'string' ? body.tool.trim() : '';
        const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
          ? body.args as Record<string, unknown>
          : {};
        if (!tool) {
          json(res, 400, { error: 'tool is required' });
          return true;
        }
        if (tool !== 'inspect.file-contents') {
          json(res, 400, { error: `Tool does not support raw response: ${tool}` });
          return true;
        }
        const cardId = getMcpArgString(args, 'card_id', 'cardId');
        const fileIdx = getMcpArgNumber(args, 'file_idx', 'fileIdx');
        const headLines = getMcpArgNumber(args, 'head-lines', 'headLines');
        const tailLines = getMcpArgNumber(args, 'tail-lines', 'tailLines');
        const headBytes = getMcpArgNumber(args, 'head-bytes', 'headBytes');
        const tailBytes = getMcpArgNumber(args, 'tail-bytes', 'tailBytes');
        if (!cardId) {
          json(res, 400, { error: 'inspect.file-contents requires card_id' });
          return true;
        }
        if (fileIdx === undefined || !Number.isInteger(fileIdx) || fileIdx < 0) {
          json(res, 400, { error: 'inspect.file-contents requires file_idx to be a non-negative integer' });
          return true;
        }
        const rawModes = [headLines, tailLines, headBytes, tailBytes].filter((value) => value !== undefined);
        if (rawModes.length > 1) {
          json(res, 400, { error: 'inspect.file-contents accepts at most one of head-lines, tail-lines, head-bytes, tail-bytes' });
          return true;
        }
        for (const [name, value] of [['head-lines', headLines], ['tail-lines', tailLines], ['head-bytes', headBytes], ['tail-bytes', tailBytes]] as const) {
          if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
            json(res, 400, { error: `inspect.file-contents requires ${name} to be a non-negative integer` });
            return true;
          }
        }
        const descriptor = createMcpFacade().inspectFileContents({ cardId, fileIdx }) as { stored_name?: unknown; mime_type?: unknown; name?: unknown };
        const expectedStoredName = typeof descriptor?.stored_name === 'string' ? descriptor.stored_name : null;
        const { fileRecord, bytes } = resolveCardFileDownloadPayload(cardId, fileIdx, expectedStoredName);
        const filename = String(fileRecord.name || fileRecord.stored_name || 'download.bin');
        const mimeType = String(fileRecord.mime_type || 'application/octet-stream');
        const respMode = (url.searchParams.get('resp') || '').trim().toLowerCase();
        if (respMode && respMode !== 'json-b64') {
          json(res, 400, { error: `unsupported resp mode: ${respMode}` });
          return true;
        }
        const wantBase64 = respMode === 'json-b64';
        let outBytes: Uint8Array;
        if (headLines !== undefined || tailLines !== undefined) {
          if (!isLikelyTextMimeType(mimeType)) {
            json(res, 400, { error: 'head-lines/tail-lines are only supported for text-like files; use head-bytes/tail-bytes for binary content' });
            return true;
          }
          const text = new TextDecoder().decode(bytes);
          const slicedText = headLines !== undefined
            ? sliceTextByLines(text, 'head', headLines)
            : sliceTextByLines(text, 'tail', tailLines as number);
          outBytes = typeof Buffer !== 'undefined' ? Buffer.from(slicedText, 'utf8') : new TextEncoder().encode(slicedText);
        } else if (headBytes !== undefined || tailBytes !== undefined) {
          const count = (headBytes ?? tailBytes) as number;
          outBytes = headBytes !== undefined ? bytes.slice(0, count) : bytes.slice(Math.max(0, bytes.length - count));
        } else {
          outBytes = bytes;
        }
        if (wantBase64) {
          const bodyBase64 = typeof Buffer !== 'undefined'
            ? Buffer.from(outBytes).toString('base64')
            : btoa(String.fromCharCode(...outBytes));
          json(res, 200, { bodyBase64, mimeType, filename, byteLength: outBytes.length });
          return true;
        }
        res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': outBytes.length,
        });
        res.end(outBytes as unknown as Buffer);
        return true;
      }

      const cardMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)$`));
      if (method === 'GET' && cardMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardMatch[1]);
        const card = readCardFromStore(cardId);
        if (!card) { json(res, 404, { error: `card not found: ${cardId}` }); return true; }
        json(res, 200, card);
        return true;
      }

      if (method === 'PATCH' && cardMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardMatch[1]);
        const body = await readJsonBody(req);
        patchCard(cardId, body);
        // No immediate broadcast — patchCard triggers an async drain that will
        // produce card_refreshed + other notifications via the transport subscription.
        // upsertCard restart:true is skipped when the card content is unchanged.
        json(res, 200, { ok: true });
        return true;
      }

      const cardRetriggerMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/retrigger$`));
      if (method === 'POST' && cardRetriggerMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardRetriggerMatch[1]);
        retriggerCard(cardId);
        json(res, 200, { ok: true });
        return true;
      }

      const cardActionMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/actions$`));
      if (method === 'POST' && cardActionMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardActionMatch[1]);
        const requestReceivedAtMs = Date.now();
        const requestReceivedAt = new Date(requestReceivedAtMs).toISOString();
        const body = await readJsonBody(req);
        const actionType = body?.actionType as string;
        if (actionType === 'chat-send' && !resolveChatHandlerTarget(cardId)) {
          const responseSentAtMs = Date.now();
          json(res, 409, {
            error: `chat handler is not configured for card: ${cardId}`,
            requestReceivedAt,
            requestReceivedAtMs,
            responseSentAt: new Date(responseSentAtMs).toISOString(),
            responseSentAtMs,
            responseStatus: 409,
          });
          return true;
        }
        if (actionType === 'chat-send') {
          const p = (body?.payload ?? {}) as Record<string, unknown>;
          const rawTurnId = typeof p['turn-id'] === 'string'
            ? p['turn-id']
            : typeof p.turnId === 'string'
              ? p.turnId
              : typeof p.turn === 'string'
                ? p.turn
                : '';
          if (!rawTurnId || !String(rawTurnId).trim()) {
            const responseSentAtMs = Date.now();
            json(res, 400, {
              error: `chat-send requires a non-empty 'turn-id' (or 'turnId'/'turn') in payload for card: ${cardId}`,
              requestReceivedAt,
              requestReceivedAtMs,
              responseSentAt: new Date(responseSentAtMs).toISOString(),
              responseSentAtMs,
              responseStatus: 400,
            });
            return true;
          }
        }
        applyCardAction(cardId, actionType, body?.payload as Record<string, unknown> | null);
        const responseSentAtMs = Date.now();
        json(res, 200, {
          ok: true,
          requestReceivedAt,
          requestReceivedAtMs,
          responseSentAt: new Date(responseSentAtMs).toISOString(),
          responseSentAtMs,
          responseStatus: 200,
        });
        return true;
      }

      const cardChatsMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/chats$`));
      if (method === 'GET' && cardChatsMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardChatsMatch[1]);
        const turnId = String(url.searchParams.get('turn-id') || '');
        const allTurns = String(url.searchParams.get('all-turns') || '').toLowerCase() === 'true';
        const tailTurnsBeforeId = String(url.searchParams.get('tail-turns-before-id') || '');
        const lastUserTurnsRaw = url.searchParams.get('tail-turns');
        const lastUserTurns = lastUserTurnsRaw == null || lastUserTurnsRaw === ''
          ? (allTurns ? undefined : (turnId ? undefined : 1))
          : Number.parseInt(lastUserTurnsRaw, 10);
        const readResult = chatStorePublic.readAll({
          params: { cardId },
          body: {
            ...(lastUserTurns === undefined ? {} : { tailTurns: lastUserTurns }),
            ...(turnId ? { turnId } : {}),
            ...(allTurns ? { allTurns: true } : {}),
            ...(tailTurnsBeforeId ? { tailTurnsBeforeId } : {}),
          },
        });
        if (readResult.status !== 'success') {
          json(res, 400, { error: readResult.error || 'Failed to read chats' });
          return true;
        }
        const messages = readResult.data.records as unknown as Array<Record<string, unknown>>;
        json(res, 200, { ok: true, messages });
        return true;
      }

      if (method === 'POST' && cardChatsMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardChatsMatch[1]);
        const body = await readJsonBody(req);
        const role = typeof body?.role === 'string' ? body.role : 'assistant';
        const text = typeof body?.text === 'string' ? body.text : '';
        const files = Array.isArray(body?.files) ? body.files : [];
        const turn = typeof body?.turn === 'string'
          ? body.turn
          : typeof body?.['turn-id'] === 'string'
            ? body['turn-id']
            : typeof body?.turnId === 'string'
              ? body.turnId
              : '';
        const done = body?.done === true;
        const entryId = chatStorage.append(cardId, role, text, files, turn);
        if (done) chatStorage.setProcessing(cardId, false);
        broadcastCardChatsToSubscribedSseClients(cardId, !done);
        json(res, 200, { ok: true, id: entryId });
        return true;
      }

      const cardChatsSubscribeMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/chats/subscribe-sse$`));
      if (method === 'POST' && cardChatsSubscribeMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardChatsSubscribeMatch[1]);
        const body = await readJsonBody(req);
        const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
        if (!clientId) { json(res, 400, { error: 'clientId is required' }); return true; }
        if (!subscribeClientToCardChats(clientId, cardId)) {
          json(res, 404, { error: `SSE client not connected: ${clientId}` });
          return true;
        }
        json(res, 200, { ok: true, clientId, cardId, subscribed: true });
        return true;
      }

      const cardChatsUnsubscribeMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/chats/unsubscribe-sse$`));
      if (method === 'POST' && cardChatsUnsubscribeMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardChatsUnsubscribeMatch[1]);
        const body = await readJsonBody(req);
        const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
        if (!clientId) { json(res, 400, { error: 'clientId is required' }); return true; }
        if (!unsubscribeClientFromCardChats(clientId, cardId)) {
          json(res, 404, { error: `SSE client not connected: ${clientId}` });
          return true;
        }
        json(res, 200, { ok: true, clientId, cardId, subscribed: false });
        return true;
      }

      const boardWatchChannelMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/watch-channel/([^/]+)/(subscribe|unsubscribe)-sse$`));
      if (method === 'POST' && boardWatchChannelMatch) {
        await bootstrapBoard();
        const channelName = decodeURIComponent(boardWatchChannelMatch[1]);
        const subscribed = boardWatchChannelMatch[2] === 'subscribe';
        const body = await readJsonBody(req);
        const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
        if (!clientId) { json(res, 400, { error: 'clientId is required' }); return true; }
        handleChannelSubscription(res, clientId, channelName, {}, subscribed);
        return true;
      }

      const cardWatchChannelMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/watch-channel/([^/]+)/(subscribe|unsubscribe)-sse$`));
      if (method === 'POST' && cardWatchChannelMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardWatchChannelMatch[1]);
        const channelName = decodeURIComponent(cardWatchChannelMatch[2]);
        const subscribed = cardWatchChannelMatch[3] === 'subscribe';
        const body = await readJsonBody(req);
        const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
        if (!clientId) { json(res, 400, { error: 'clientId is required' }); return true; }
        handleChannelSubscription(res, clientId, channelName, { cardId }, subscribed);
        return true;
      }

      const cardFileMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/files$`));
      if (method === 'POST' && cardFileMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardFileMatch[1]);
        const inChat = String(url.searchParams.get('inChat') || '').toLowerCase() === 'true';
        const turnId = String(url.searchParams.get('turn-id') || '').trim();
        if (inChat && !turnId) {
          json(res, 400, {
            error: `file upload with inChat=true requires a non-empty 'turn-id' query parameter for card: ${cardId}`,
          });
          return true;
        }
        const encodedName = req.headers['x-file-name'];
        const contentType = String(req.headers['content-type'] || 'application/octet-stream');
        const rawName = Array.isArray(encodedName) ? encodedName[0] : encodedName;
        const requestedName = rawName ? decodeURIComponent(String(rawName)) : 'upload.bin';
        const body = await readRawBody(req);
        json(res, 200, uploadCardFile(cardId, requestedName, contentType, body, { inChat, turnId }));
        return true;
      }

      const cardFileDownloadMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/files/(\\d+)$`));
      if (method === 'GET' && cardFileDownloadMatch) {
        const cardId = decodeURIComponent(cardFileDownloadMatch[1]);
        const idx = parseInt(cardFileDownloadMatch[2], 10);
        const expectedStoredName = url.searchParams.get('sn');
        sendCardFileDownloadResponse(res, cardId, idx, expectedStoredName);
        return true;
      }

      return false;
    } catch (err: unknown) {
      const statusCode = (err as any)?.statusCode || 500;
      json(res, statusCode, { error: String((err as Error)?.message || err) });
      return true;
    }
  }

  return {
    get apiBasePath() { return apiBasePath; },
    get corsHeaders() { return corsHeaders; },
    handleRuntimeApi,
    buildPublishedRuntimePayload,
    clearChatRecords,
    reportSourceFetched(token: string, ref: string) {
      return reportSourceFetchedInternal(token, { ref });
    },
    reportSourceFetchFailure(token: string, reason: string) {
      return reportSourceFetchFailureInternal(token, { reason });
    },
    get cardStore() { return boardContexts[0]?.cardStore ?? { set() { return { status: 'fail', error: 'no board context' }; } }; },
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

// ============================================================================
// Helpers
// ============================================================================

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLen = arrays.reduce((acc, a) => acc + a.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) { result.set(a, offset); offset += a.length; }
  return result;
}
