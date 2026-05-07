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
  createChatArtifactsStore,
  createFileArtifactsStore,
  createCardFileMetadataStore,
} from '../cli/common/artifacts-store-lib.js';

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
  CardSourceAdapter,
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
  CardSourceAdapter,
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
  filesArtifacts: ReturnType<typeof createArtifactsStore>;
  chatsArtifacts: ReturnType<typeof createArtifactsStore>;
  cardSource: CardSourceAdapter;
  cardStoreRef: string;
  outputsStoreRef: string;
  notifyRef?: import('./types.js').KindValueRef;
  taskExecutorRef?: import('./types.js').ExecutionRef;
  chatHandlerRef?: import('./types.js').ExecutionRef;
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

function appendNotification(state: NotificationState, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const e = event as Record<string, unknown>;
  if (e.kind === 'status') state.status = e.status;
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
  const notificationTransport = options.notificationTransport || null;
  const serverUrl = options.serverUrl || null;
  const executionExtra = options.executionExtra || {};

  const sseClients = new Set<RuntimeResponse>();

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
    const filesArtifacts = createArtifactsStore(artAdapter.blobStorage('files'));
    const chatsArtifacts = createArtifactsStore(artAdapter.blobStorage('chats'));

    return {
      label: cfg.label,
      board,
      cardStore,
      filesArtifacts,
      chatsArtifacts,
      cardSource: cfg.cardSource,
      cardStoreRef: cfg.cardStoreRef,
      outputsStoreRef: cfg.outputsStoreRef,
      notifyRef: cfg.notifyRef,
      taskExecutorRef: cfg.taskExecutorRef,
      chatHandlerRef: cfg.chatHandlerRef,
      inferenceAdapterRef: cfg.inferenceAdapterRef,
      notification: makeNotificationState(),
      notificationTeardown: null,
      initialized: false,
      cardsBootstrapped: false,
    };
  }

  const baseCtx = buildContext(options.base);
  const gandalfCtx = options.gandalf ? buildContext(options.gandalf) : null;
  const gandalfCardIdSet = new Set<string>();

  function isGandalfCard(cardId: string): boolean { return gandalfCardIdSet.has(cardId); }

  // ── Artifacts stores ─────────────────────────────────────────────────────

  function artifactsStores(cardId: string) {
    const ctx = isGandalfCard(cardId) ? gandalfCtx : baseCtx;
    return {
      files: ctx ? ctx.filesArtifacts : null,
      chats: ctx ? ctx.chatsArtifacts : null,
    };
  }

  function chatArtifactsForCard(cardId: string) {
    const stores = artifactsStores(cardId);
    if (!stores.chats) return null;
    return createChatArtifactsStore(stores.chats, { indexFileName: '.index.json' });
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
      broadcastToSseClients();
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
    if (ctx.chatHandlerRef) body['chat-handler-ref'] = ctx.chatHandlerRef;
    if (ctx.inferenceAdapterRef) body['inference-adapter-ref'] = ctx.inferenceAdapterRef;

    const initResult = ctx.board.init({ params, body });
    if (initResult.status !== 'success') {
      throw Object.assign(
        new Error((initResult as any).error || `init failed for ${ctx.label}`),
        { statusCode: 500 },
      );
    }

    await ensureNotificationConsumer(ctx);

    // Pre-init validation: describe chat-handler if adapter supports it
    if (ctx.chatHandlerRef && invocationAdapter.describe) {
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

  async function upsertCardsFromSource(ctx: BoardContext, idSet: Set<string>): Promise<void> {
    if (!ctx) return;
    if (ctx.cardsBootstrapped) return;
    const cards = ctx.cardSource.listCards();
    for (const card of cards) {
      if (typeof card.id !== 'string') continue;
      idSet.add(card.id as string);
      const setResult = ctx.cardStore.set({ body: card });
      if (setResult.status !== 'success') continue;
      ctx.board.upsertCard({ params: { cardId: card.id as string, restart: true } });
    }
    await ctx.board.processAccumulatedEvents({});
    ctx.cardsBootstrapped = true;
  }

  const cardIdSet = new Set<string>();

  async function initBoardAndSetup(): Promise<void> {
    await initContext(baseCtx);
    if (gandalfCtx && gandalfCtx.taskExecutorRef) {
      await initContext(gandalfCtx);
    }
  }

  async function bootstrapBoard(): Promise<void> {
    await initBoardAndSetup();
    await upsertCardsFromSource(baseCtx, cardIdSet);
    if (gandalfCtx) await upsertCardsFromSource(gandalfCtx, gandalfCardIdSet);
  }

  // ── Card reads ───────────────────────────────────────────────────────────

  function cardContextForCard(cardId: string): BoardContext | null {
    return isGandalfCard(cardId) ? gandalfCtx : baseCtx;
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
        return ctx.cardSource.listCards();
      }
      return (result as any).data.cards;
    };
    const base = fromCtx(baseCtx);
    const side = gandalfCtx ? fromCtx(gandalfCtx) : [];
    return [...base, ...side];
  }

  // ── Status & runtime artifacts ───────────────────────────────────────────

  function readStatusSnapshot(): unknown {
    const base = baseCtx.notification.status;
    const side = gandalfCtx ? gandalfCtx.notification.status : null;
    if (!base && !side) return null;
    if (!side) return base;
    if (!base) return side;

    const baseObj = base as Record<string, unknown>;
    const sideObj = side as Record<string, unknown>;
    const baseCards = Array.isArray(baseObj.cards) ? baseObj.cards : [];
    const sideCards = Array.isArray(sideObj.cards) ? sideObj.cards : [];
    const mergedCards = [...baseCards, ...sideCards];
    const sum = (obj: unknown, k: string) => Number((obj as any)?.summary?.[k] || 0);
    return {
      ...baseObj,
      cards: mergedCards,
      summary: {
        ...((baseObj.summary || {}) as Record<string, unknown>),
        card_count: mergedCards.length,
        completed: sum(base, 'completed') + sum(side, 'completed'),
        eligible: sum(base, 'eligible') + sum(side, 'eligible'),
        pending: sum(base, 'pending') + sum(side, 'pending'),
        blocked: sum(base, 'blocked') + sum(side, 'blocked'),
        unresolved: sum(base, 'unresolved') + sum(side, 'unresolved'),
        failed: sum(base, 'failed') + sum(side, 'failed'),
        in_progress: sum(base, 'in_progress') + sum(side, 'in_progress'),
        orphan_cards: sum(base, 'orphan_cards') + sum(side, 'orphan_cards'),
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
          fetched_sources: {},
          requires: {},
        };
      }
    };
    process(baseCtx);
    if (gandalfCtx) process(gandalfCtx);
    return out;
  }

  function readSourcePayloads(cardDef: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!Array.isArray(cardDef.source_defs)) return out;
    const ctx = isGandalfCard(cardDef.id as string) ? gandalfCtx : baseCtx;
    const dataObjects = ctx ? ctx.notification.dataObjects : {};
    for (const sd of cardDef.source_defs as Array<Record<string, unknown>>) {
      if (!sd?.bindTo) continue;
      if (Object.prototype.hasOwnProperty.call(dataObjects, sd.bindTo as string)) {
        out[sd.bindTo as string] = dataObjects[sd.bindTo as string];
      }
    }
    return out;
  }

  function readDataObjectsByToken(): Record<string, unknown> {
    return {
      ...(baseCtx.notification.dataObjects || {}),
      ...(gandalfCtx ? gandalfCtx.notification.dataObjects : {}),
    };
  }

  function readChatSignal(cardId: string): { count: number; latest_mtime_ms: number; processing: boolean } {
    const sid = safeCardId(cardId);
    const chatStore = chatArtifactsForCard(cardId);
    if (!chatStore) return { count: 0, latest_mtime_ms: 0, processing: false };
    return chatStore.readSignal(sid);
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
      const sources = readSourcePayloads(cardDef);
      const chatSignal = readChatSignal(id);
      const cardData: Record<string, unknown> = {
        ...((raw.card_data && typeof raw.card_data === 'object' ? raw.card_data
          : cardDef.card_data && typeof cardDef.card_data === 'object' ? cardDef.card_data
            : {}) as Record<string, unknown>),
        __chat_signal: chatSignal,
      };
      cardRuntimeById[id] = {
        schema_version: raw.schema_version || 'v1',
        card_id: raw.card_id || id,
        card_data: cardData,
        computed_values: raw.computed_values && typeof raw.computed_values === 'object' ? raw.computed_values : {},
        fetched_sources: sources,
        requires: raw.requires && typeof raw.requires === 'object' ? raw.requires : {},
      };
    }

    return {
      cardDefinitions,
      statusSnapshot: readStatusSnapshot(),
      dataObjectsByToken,
      cardRuntimeById,
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

      if (patch.fieldValues && typeof patch.fieldValues === 'object') {
        let writeTo: string | null = null;
        const view = card.view as Record<string, unknown> | undefined;
        if (view && Array.isArray(view.elements)) {
          for (const elem of view.elements) {
            if (elem?.data && (elem as any).data.writeTo) { writeTo = (elem as any).data.writeTo; break; }
          }
        }
        if (writeTo) {
          deepSet(card, writeTo, patch.fieldValues);
        } else {
          card.card_data = { ...((card.card_data || {}) as Record<string, unknown>), ...(patch.fieldValues as Record<string, unknown>) };
        }
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

  function parseLeadingSerial(fileName: string): number {
    const m = String(fileName || '').match(/^(\d+)[-_]/);
    return m ? parseInt(m[1], 10) : 0;
  }

  function normalizeDisplayFileName(name: string): string {
    const input = String(name || '').trim();
    if (!input) return 'upload.bin';
    // Extract basename: take last segment after / or \
    const lastSlash = Math.max(input.lastIndexOf('/'), input.lastIndexOf('\\'));
    const base = lastSlash >= 0 ? input.slice(lastSlash + 1) : input;
    return base || 'upload.bin';
  }

  function clearChatRecords(cardId: string): void {
    const sid = safeCardId(cardId);
    const chatStore = chatArtifactsForCard(cardId);
    if (!chatStore) return;
    chatStore.clear(sid);
  }

  function nextChatStoredName(cardId: string, role: string): string {
    const sid = safeCardId(cardId);
    const chatStore = chatArtifactsForCard(cardId);
    const serial = chatStore ? chatStore.nextSerial(sid) : 1;
    const safeRole = String(role || 'system').toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'system';
    return `${String(serial).padStart(3, '0')}_${safeRole}.txt`;
  }

  function writeChatRecord(cardId: string, role: string, text: string, files: Array<Record<string, unknown>>): Record<string, unknown> {
    const now = new Date().toISOString();
    const sid = safeCardId(cardId);
    const stores = artifactsStores(cardId);
    const outName = nextChatStoredName(cardId, role || 'system');
    const artifactKey = `${sid}/${outName}`;

    const lines: string[] = [];
    const msg = typeof text === 'string' ? text.trim() : '';
    if (msg) lines.push(msg);

    const fileList = Array.isArray(files) ? files : [];
    if (fileList.length) {
      if (lines.length) lines.push('');
      lines.push('files:');
      for (const file of fileList) {
        if (!file || typeof file !== 'object') continue;
        const display = typeof file.name === 'string' ? file.name : 'file';
        const stored = typeof file.stored_name === 'string' ? file.stored_name : '';
        lines.push(stored ? `- ${display} -> ${stored}` : `- ${display}`);
      }
    }

    if (stores.chats) stores.chats.putText(artifactKey, `${lines.join('\n')}\n`);
    const serial = parseLeadingSerial(outName);
    const chatStore = chatArtifactsForCard(cardId);
    if (chatStore) {
      chatStore.appendIndexRecord(sid, {
        serial,
        role: role || 'system',
        stored_name: outName,
        path: `${cardId}/chats/${outName}`,
        updated_at: now,
      });
    }
    return { at: now, role: role || 'system', text: msg, files: fileList, path: `${cardId}/chats/${outName}` };
  }

  function readChatRecords(cardId: string): Array<Record<string, unknown>> {
    const sid = safeCardId(cardId);
    const chatStore = chatArtifactsForCard(cardId);
    if (!chatStore) return [];
    return chatStore.readRecords(sid).map((row) => ({
      ...row,
      path: `${cardId}/chats/${row.stored_name}`,
    }));
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

  // ── Chat handler invocation ──────────────────────────────────────────────

  function invokeChatHandler(cardId: string, chatsDir: string, lastChatFile: string): void {
    const ctx = cardContextForCard(cardId);
    if (!ctx) return;

    const cfgResult = ctx.board.getConfig({ params: { key: 'chat-handler' } });
    if (cfgResult.status !== 'success') return;
    const handlerRef = (cfgResult as any).data?.value;
    if (!handlerRef || typeof handlerRef !== 'object') return;

    const sid = safeCardId(cardId);
    const stores = artifactsStores(cardId);
    const processingMarkerKey = `${sid}/.processing`;
    try { stores.chats?.putText(processingMarkerKey, '', 'text/plain; charset=utf-8'); } catch {}

    const args: Record<string, unknown> = {
      boardId,
      cardId: String(cardId),
      chatDir: chatsDir,
      chatProcessingMarkerKey: processingMarkerKey,
      lastChatFile,
      ...executionExtra,
      ...(serverUrl ? { serverUrl } : {}),
    };

    invocationAdapter.invoke(handlerRef, args).then(
      (result) => {
        if (result.dispatched) {
          logger.info(`[chat-handler] invoked for card "${cardId}" (boardId: "${boardId}")`);
        } else {
          try { stores.chats?.remove(processingMarkerKey); } catch {}
          logger.warn(`[chat-handler] dispatch failed for card "${cardId}": ${result.error || 'unknown'}`);
        }
      },
      (err) => {
        try { stores.chats?.remove(processingMarkerKey); } catch {}
        logger.warn(`[chat-handler] invoke failed for card "${cardId}": ${err?.message || String(err)}`);
      },
    );
  }

  // ── Card actions ─────────────────────────────────────────────────────────

  function applyCardAction(cardId: string, actionType: string, payload: Record<string, unknown> | null): void {
    const persistCard = actionType === 'chat-send' ? updateCardLocalOnly : updateCard;
    let chatHandlerResult: { chatsDir: string; lastChatFile: string } | undefined;

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
          const sid = safeCardId(cardId);
          const userRecord = writeChatRecord(cardId, 'user', text, files);
          const recPath = userRecord.path as string;
          const lastSeg = recPath.includes('/') ? recPath.slice(recPath.lastIndexOf('/') + 1) : recPath;
          chatHandlerResult = { chatsDir: `${sid}/chats`, lastChatFile: lastSeg };
          for (const file of files) {
            if (!file || typeof file !== 'object') continue;
            const display = typeof file.name === 'string' ? file.name : 'file';
            const stored = typeof file.stored_name === 'string' ? file.stored_name : null;
            if (!stored) continue;
            writeChatRecord(cardId, 'system', `File ${display} uploaded as ${stored}.`, []);
          }
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
      invokeChatHandler(cardId, chatHandlerResult.chatsDir, chatHandlerResult.lastChatFile);
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

  function broadcastToSseClients(): void {
    const payload = buildPublishedRuntimePayload();
    const data = `data: ${JSON.stringify(payload)}\n\n`;
    for (const client of sseClients) {
      try { client.write(data); } catch { sseClients.delete(client); }
    }
  }

  function handleSse(req: RuntimeRequest, res: RuntimeResponse): void {
    res.writeHead(200, {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    sseClients.add(res);
    res.write(`data: ${JSON.stringify(buildPublishedRuntimePayload())}\n\n`);
    const keepAlive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* ignore */ }
    }, 15_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
      res.end();
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

      if (method === 'GET' && (p === `${apiBasePath}/bootstrap-cards` || p === `${apiBasePath}/bootstrap`)) {
        await bootstrapBoard();
        json(res, 200, buildPublishedRuntimePayload());
        return true;
      }

      if (method === 'GET' && p === `${apiBasePath}/sse`) {
        await bootstrapBoard();
        handleSse(req, res);
        return true;
      }

      if (method === 'GET' && p === `${apiBasePath}/board-status`) {
        json(res, 200, buildPublishedRuntimePayload());
        return true;
      }

      const cardMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)$`));
      if (method === 'PATCH' && cardMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardMatch[1]);
        const body = await readJsonBody(req);
        patchCard(cardId, body);
        broadcastToSseClients();
        json(res, 200, { ok: true });
        return true;
      }

      const cardActionMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/actions$`));
      if (method === 'POST' && cardActionMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardActionMatch[1]);
        const body = await readJsonBody(req);
        applyCardAction(cardId, body?.actionType as string, body?.payload as Record<string, unknown> | null);
        broadcastToSseClients();
        json(res, 200, { ok: true });
        return true;
      }

      const cardChatsMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/chats$`));
      if (method === 'GET' && cardChatsMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardChatsMatch[1]);
        json(res, 200, { ok: true, messages: readChatRecords(cardId) });
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
        if (inChat) {
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
          writeChatRecord(cardId, 'system', `file uploaded: ${file.name} as ${file.stored_name}`, []);
        }
        broadcastToSseClients();
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
      for (const key of ['cardsDir', 'stepMachineCliPath', 'taskExecutorPath', 'chatHandlerPath', 'inferenceAdapterPath']) {
        if (typeof body[key] === 'string') entry[key] = body[key];
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
