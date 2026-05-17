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
} from '../cli/common/board-live-cards-public.js';

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
  cardStore: ReturnType<typeof createCardStorePublic>;
  readonly filesArtifacts: ReturnType<typeof createArtifactsStore>;
  boardAdapter: import('./types.js').BoardPlatformAdapter;
  cardStoreRef: string;
  outputsStoreRef: string;
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

  const sseClients = new Map<string, { res: RuntimeResponse; subscribedChatCardIds: Set<string> }>();
  const lastChatCursorByCardId = new Map<string, string | null>();
  const lastChatProcessingByCardId = new Map<string, boolean>();
  let chatSubscriptionScanTimer: ReturnType<typeof setInterval> | null = null;

  // ── Build board contexts from injected configs ───────────────────────────

  function buildContext(cfg: BoardContextConfig): BoardContext {
    const board = createBoardLiveCardsPublic(cfg.baseRef, cfg.boardAdapter);
    const kv = cfg.boardAdapter.kvStorageForRef(cfg.cardStoreRef);
    const cardAdapterObj = {
      readIndex: () => kv.read('_index'),
      writeIndex: (idx: unknown) => kv.write('_index', idx),
      readCard: (id: string) => kv.read(id),
      writeCard: (id: string, card: unknown) => { kv.write(id, card); return id; },
      cardExists: (id: string) => kv.read(id) !== null,
      defaultCardKey: (id: string) => id,
    };
    const cardStore = createCardStorePublic(createCardStore(cardAdapterObj as any, logger.warn));
    const artAdapter = cfg.artifactsAdapter || cfg.boardAdapter;
    const callerFilesArtifactsStore = cfg.filesArtifactsStore ?? null;

    // Lazy artifact stores — only created on first access (saves ~5KB in bundles
    // that never use file features).
    let _filesArtifacts: ReturnType<typeof createArtifactsStore> | null = null;

    return {
      label: cfg.label,
      board,
      cardStore,
      get filesArtifacts() { return _filesArtifacts ??= (callerFilesArtifactsStore ?? createArtifactsStore(artAdapter.blobStorage('files'))); },
      boardAdapter: cfg.boardAdapter,
      cardStoreRef: cfg.cardStoreRef,
      outputsStoreRef: cfg.outputsStoreRef,
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

    const params = {
      cardStoreRef: ctx.cardStoreRef,
      outputsStoreRef: ctx.outputsStoreRef,
    };
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
        const processing = chatStorage.isProcessing(id);
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

  function mutateCard(cardId: string, updateFn: (card: Record<string, unknown>) => Record<string, unknown> | void, opts?: { syncBoard?: boolean }): void {
    const syncBoard = opts?.syncBoard !== false;
    const ctx = cardContextForCard(cardId);
    if (!ctx) throw Object.assign(new Error(`Card not found: ${cardId}`), { statusCode: 404 });

    const card = readCardFromStore(cardId);
    if (!card) throw Object.assign(new Error(`Card not found: ${cardId}`), { statusCode: 404 });

    const nextCard = updateFn(card) || card;
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

  function patchCard(cardId: string, patch: Record<string, unknown>): void {
    updateCard(cardId, (card) => {
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
    });
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
    chatStorage.setProcessing(cardId, false);
  }

  /** Append a chat message; returns the new entry id (used as cursor). */
  function writeChatRecord(cardId: string, role: string, text: string, files: Array<Record<string, unknown>>): string {
    const msg = typeof text === 'string' ? text.trim() : '';
    return chatStorage.append(cardId, role || 'system', msg, files);
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
      path: `${cardId}/files/${storedName}`,
      uploaded_at: new Date().toISOString(),
    };
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

  function invokeChatHandler(cardId: string, lastEntryId: string, processingAlreadySet = false): void {
    const target = resolveChatHandlerTarget(cardId);
    if (!target) return;
    const { ctx, handlerFlow, handlerRef } = target;

    if (!processingAlreadySet) {
      try { chatStorage.setProcessing(cardId, true); } catch {}
    }

    const args: Record<string, unknown> = {
      boardId,
      cardId: String(cardId),
      lastChatEntryId: lastEntryId,
      ...executionExtra,
      ...(serverUrl ? { serverUrl } : {}),
    };

    if (!chatFlowRunner) {
      if (handlerFlow != null) {
        try { chatStorage.setProcessing(cardId, false); } catch {}
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
        const files: Array<Record<string, unknown>> = [];
        if (Array.isArray(payload?.files)) {
          for (const f of payload.files as unknown[]) {
            if (!f) continue;
            if (typeof f === 'string') { files.push({ name: f }); continue; }
            if (typeof f === 'object') {
              const fo = f as Record<string, unknown>;
              if (typeof fo.name === 'string') files.push({ name: fo.name, size: fo.size, mime_type: fo.mime_type, path: fo.path, uploaded_at: fo.uploaded_at, stored_name: fo.stored_name });
            }
          }
        }

        if (text || files.length > 0) {
          const batchResult = chatStorePublic.runBatch({
            cardId,
            commands: [
              { command: 'append', role: 'user', text, files },
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

          chatHandlerResult = { cardId, lastEntryId: entryId, processingAlreadySet };
          for (const file of files) {
            if (!file || typeof file !== 'object') continue;
            const display = typeof file.name === 'string' ? file.name : 'file';
            const stored = typeof file.stored_name === 'string' ? file.stored_name : null;
            if (!stored) continue;
            writeChatRecord(cardId, 'system', `File ${display} uploaded as ${stored}.`, []);
          }
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
      invokeChatHandler(chatHandlerResult.cardId, chatHandlerResult.lastEntryId, chatHandlerResult.processingAlreadySet);
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

  function writeSseFrame(clientId: string, payload: unknown): void {
    const client = sseClients.get(clientId);
    if (!client) return;
    const frame = buildSseFrame(payload);
    try {
      client.res.write(frame);
      flushSseTransport(client.res);
    } catch {
      sseClients.delete(clientId);
    }
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
      try { existing.res.end(); } catch { /* ignore */ }
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

    const keepAlive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* ignore */ }
    }, 15_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      const current = sseClients.get(clientId);
      if (current?.res === res) {
        sseClients.delete(clientId);
        stopChatSubscriptionScanIfIdle();
      }
      try { res.end(); } catch { /* ignore */ }
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
        json(res, 200, { ok: true, messages: readChatRecords(cardId) });
        return true;
      }

      if (method === 'POST' && cardChatsMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardChatsMatch[1]);
        const body = await readJsonBody(req);
        const role = typeof body?.role === 'string' ? body.role : 'assistant';
        const text = typeof body?.text === 'string' ? body.text : '';
        const files = Array.isArray(body?.files) ? body.files : [];
        const done = body?.done === true;
        const entryId = chatStorage.append(cardId, role, text, files);
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

      const cardFileMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/files$`));
      if (method === 'POST' && cardFileMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardFileMatch[1]);
        const inChat = String(url.searchParams.get('inChat') || '').toLowerCase() === 'true';
        const encodedName = req.headers['x-file-name'];
        const contentType = String(req.headers['content-type'] || 'application/octet-stream');
        const rawName = Array.isArray(encodedName) ? encodedName[0] : encodedName;
        const requestedName = rawName ? decodeURIComponent(String(rawName)) : 'upload.bin';
        const body = await readRawBody(req);
        if (!body.length) { json(res, 400, { error: 'Empty upload body' }); return true; }

        const file = persistUploadedFile(cardId, requestedName, contentType, body);
        // Always register the file in card_data.files regardless of inChat flag,
        // so GET /cards/:id and GET /cards/:id/files/:idx work unconditionally.
        updateCardLocalOnly(cardId, (card) => {
          const now = new Date().toISOString();
          const cardData = card.card_data && typeof card.card_data === 'object' ? card.card_data as Record<string, unknown> : {};
          card.card_data = cardData;
          const incoming = cardFileMetadataStoreInstance().normalizeIncoming([{
            name: file.name, stored_name: file.stored_name, size: file.size,
            mime_type: file.mime_type, path: file.path, uploaded_at: file.uploaded_at || now,
          }], now);
          cardFileMetadataStoreInstance().merge(cardData, incoming);
          return card;
        });
        // inChat: additionally record a system chat message so the upload appears in the chat thread.
        if (inChat) {
          writeChatRecord(cardId, 'system', `file uploaded: ${file.name} as ${file.stored_name}`, []);
        }
        json(res, 200, { ok: true, file });
        return true;
      }

      const cardFileDownloadMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/files/(\\d+)$`));
      if (method === 'GET' && cardFileDownloadMatch) {
        const cardId = decodeURIComponent(cardFileDownloadMatch[1]);
        const idx = parseInt(cardFileDownloadMatch[2], 10);
        const expectedStoredName = url.searchParams.get('sn');
        const card = readCardFromStore(cardId);
        if (!card) { json(res, 404, { error: 'Card not found' }); return true; }

        const resolved = cardFileMetadataStoreInstance().resolve(card.card_data, idx, expectedStoredName);
        if (!resolved.ok && (resolved as any).reason === 'stale_reference') {
          json(res, 409, { error: 'File reference is stale. Refresh and try again.' });
          return true;
        }
        if (!resolved.ok) { json(res, 404, { error: 'File not found' }); return true; }

        const fileRecord = (resolved as any).file;
        const sid = safeCardId(cardId);
        const stores = artifactsStores(cardId);
        const fileKey = `${sid}/${fileRecord.stored_name}`;
        const bytes = stores.files ? stores.files.getBytes(fileKey) : null;
        if (!bytes) { json(res, 404, { error: 'File not found' }); return true; }

        const filename = fileRecord.name || fileRecord.stored_name;
        const mimeType = fileRecord.mime_type || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': bytes.length,
        });
        res.end(bytes as unknown as Buffer);
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
      const ctx = boardContexts[0];
      if (!ctx) return { status: 'fail', error: 'no board context' };
      return ctx.board.sourceDataFetched({ params: { token, ref } });
    },
    reportSourceFetchFailure(token: string, reason: string) {
      const ctx = boardContexts[0];
      if (!ctx) return { status: 'fail', error: 'no board context' };
      return ctx.board.sourceDataFetchFailure({ params: { token, reason } });
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
