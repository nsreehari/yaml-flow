/**
 * board-livecards-client — browser IIFE bundle.
 *
 * Two layers in one bundle:
 *   1. Platform-free state: buildBoardState, applyNotification, selectLiveCardModel,
 *      selectAllLiveCardModels, deriveBoardState, pickBoardState, subtractBoardState
 *      — usable with any transport (Firebase, WebSocket, SSE, etc.)
 *   2. SSE/HTTP transport: createBoardRuntimeClient — for yaml-flow server runtime.
 *   3. Standalone action helpers: buildFileUrlBase, uploadCardFile, prepareActionPayload,
 *      patchCardState, dispatchCardAction — for custom renderers that manage their own
 *      SSE lifecycle (satellite views, plugin boards, etc.)
 *
 * Usage (SSE/HTTP mode):
 *   <script src="board-livecards-client.js"></script>
 *   <script>
 *     const client = BoardLiveCardsClient.createBoardRuntimeClient({
 *       fetchServer, boardPaths: BoardLiveCardsClient.defaultBoardPaths, getServerOrigin,
 *     });
 *     await client.bootstrapBoard({ boardId: 'default', rootElement: el });
 *   </script>
 *
 * Usage (custom transport — e.g. Firebase):
 *   <script src="board-livecards-client.js"></script>
 *   <script>
 *     const { buildBoardState, applyNotification, selectLiveCardModel } = BoardLiveCardsClient;
 *     // apply your own transport; drive UI state with these primitives.
 *   </script>
 *
 * Global: window.BoardLiveCardsClient
 */

import { selectLiveCardModel, selectAllLiveCardModels, type BoardRuntimeArtifactsPayload } from '../board-livegraph-runtime/index.js';
import { buildBoardState, applyNotification, deriveBoardState, type BoardState, type CardModel, type DeriveBoardStateOptions } from '../cli/common/board-state-reducer.js';

// ============================================================================
// Platform-free state exports
// Re-exported so consumers using any transport (Firebase, WS, SSE) can drive
// the LiveCard UI without loading the full localstorage bundle.
// ============================================================================
export { buildBoardState, applyNotification, deriveBoardState, selectLiveCardModel, selectAllLiveCardModels };
export type { BoardState, CardModel, DeriveBoardStateOptions };

// ============================================================================
// Public types
// ============================================================================

export interface BoardPaths {
  stream: string;
  mcpActions: string;
  patchCard: (id: string) => string;
  retriggerCard: (id: string) => string;
  cardAction: (id: string) => string;
  cardChats: (id: string) => string;
  chatSubscribeSse: (id: string) => string;
  chatUnsubscribeSse: (id: string) => string;
  cardFile: (id: string) => string;
}

export interface BoardRuntimeClientOptions {
  /** Authenticated fetch wrapper (handles origin resolution, auth headers, etc). */
  fetchServer: (path: string, init?: RequestInit) => Promise<Response>;
  /** Returns the canonical BoardPaths for a given boardId. */
  boardPaths: (boardId: string) => BoardPaths;
  /** Returns the resolved server origin (e.g. 'http://localhost:7799'). Used for SSE URL. */
  getServerOrigin: () => string | null;
  /** Initial board render mode. Defaults to 'board'. */
  initialMode?: string;
  /** Canvas dimensions. Defaults to { height: '72vh', overflow: 'auto' }. */
  canvas?: { height?: string; overflow?: string };
}

export interface BootstrapBoardParams {
  boardId?: string;
  /** Legacy bootstrap hint. Ignored when using /sse?one-shot. */
  taskExecutorPath?: string;
  mode?: string;
  rootElement: HTMLElement;
}

export interface BoardNotification {
  kind: string;
  [key: string]: unknown;
}

export interface BoardRuntimeSessionBootstrapParams {
  boardId?: string;
  taskExecutorPath?: string;
  initialPayload?: unknown;
  initialState?: BoardState | null;
  skipInitBoard?: boolean;
}

export interface MountBoardViewParams {
  rootElement: HTMLElement;
  mode?: string;
}

export interface DerivedBoardRuntimeOptions extends DeriveBoardStateOptions {
  session: BoardRuntimeSession;
  boardPaths?: (boardId: string) => BoardPaths;
  getServerOrigin?: () => string | null;
}

export interface BoardRuntimeSession {
  bootstrap(params?: BoardRuntimeSessionBootstrapParams): Promise<BoardState | null>;
  attachProvidedState(params: { boardId: string; state?: BoardState | null; payload?: BoardRuntimeArtifactsPayload | null }): BoardState | null;
  applyServerUpdate(update: { kind?: string; notifications?: BoardNotification[]; cardDefinitions?: unknown[]; [key: string]: unknown }): BoardState | null;
  seedStateFromPayload(payload: unknown, prevState?: BoardState | null): BoardState;
  seedState(state: BoardState | null): BoardState | null;
  applyNotificationBatch(notifications: BoardNotification[]): BoardState | null;
  replacePayload(payload: unknown): BoardState;
  subscribe(listener: (state: BoardState | null) => void): () => void;
  closeSse(): void;
  isConnected(): boolean;
  getState(): BoardState | null;
  getPayload(): unknown | null;
  getBoardId(): string | null;
  getClientId(): string;
  getSseClientId(): string;
  patchCardState(cardId: string, patch: Record<string, unknown>): Promise<void>;
  retriggerCard(cardId: string): Promise<void>;
  dispatchCardAction(cardId: string, actionType: string, payload?: Record<string, unknown> | null): Promise<{ payload: Record<string, unknown> }>;
  uploadCardFile(cardId: string, file: File, opts?: { inChat?: boolean; turnId?: string }): Promise<unknown | null>;
  subscribeCardChats(cardId: string): Promise<void>;
  unsubscribeCardChats(cardId: string): Promise<void>;
  dispose(): void;
}

export interface DerivedBoardRuntime {
  mountBoard(params: MountBoardViewParams): unknown;
  subscribe(listener: (state: BoardState | null) => void): () => void;
  getState(): BoardState | null;
  getFullState(): BoardState | null;
  getBoardId(): string | null;
  getClientId(): string;
  getSseClientId(): string;
  patchCardState(cardId: string, patch: Record<string, unknown>): Promise<void>;
  retriggerCard(cardId: string): Promise<void>;
  dispatchCardAction(cardId: string, actionType: string, payload?: Record<string, unknown> | null): Promise<{ payload: Record<string, unknown> }>;
  uploadCardFile(cardId: string, file: File, opts?: { inChat?: boolean; turnId?: string }): Promise<unknown | null>;
  subscribeCardChats(cardId: string): Promise<void>;
  unsubscribeCardChats(cardId: string): Promise<void>;
  setMode(mode: string): void;
  autoLayout(): void;
  setDevMode(enabled: boolean): void;
  getCurrentMode(): string;
  dispose(): void;
}

/**
 * Build the standard BoardPaths for a yaml-flow server runtime board.
 *
 * Covers only the paths owned by the server runtime (SSE, patch, action, files, chats).
 * Demo-server-specific endpoints (demo-setup, board registry
 * CRUD) are not included — add those in the consumer if needed.
 *
 * @example
 * const client = createBoardRuntimeClient({
 *   fetchServer,
 *   boardPaths: defaultBoardPaths,
 *   getServerOrigin: () => activeOrigin,
 * });
 */
export function defaultBoardPaths(boardId: string, apiBase = '/api/boards'): BoardPaths {
  const base_ = apiBase.replace(/\/$/, '');
  const b = encodeURIComponent(boardId || 'default');
  const base = `${base_}/${b}`;
  return {
    stream:    `${base}/sse`,
    mcpActions: `${base}/mcp-actions`,
    patchCard:       (id: string) => `${base}/cards/${encodeURIComponent(id)}`,
    retriggerCard:   (id: string) => `${base}/cards/${encodeURIComponent(id)}/retrigger`,
    cardAction:      (id: string) => `${base}/cards/${encodeURIComponent(id)}/actions`,
    cardFile:    (id: string) => `${base}/cards/${encodeURIComponent(id)}/files`,
    cardChats:   (id: string) => `${base}/cards/${encodeURIComponent(id)}/chats`,
    chatSubscribeSse:   (id: string) => `${base}/cards/${encodeURIComponent(id)}/chats/subscribe-sse`,
    chatUnsubscribeSse: (id: string) => `${base}/cards/${encodeURIComponent(id)}/chats/unsubscribe-sse`,
  };
}

/** Flat path helper for single-board servers (no boardId segment in URL). */
export function singleBoardPaths(apiBase = '/api/board'): BoardPaths {
  const base = apiBase.replace(/\/$/, '');
  return {
    stream:    `${base}/sse`,
    mcpActions: `${base}/mcp-actions`,
    patchCard:       (id: string) => `${base}/cards/${encodeURIComponent(id)}`,
    retriggerCard:   (id: string) => `${base}/cards/${encodeURIComponent(id)}/retrigger`,
    cardAction:      (id: string) => `${base}/cards/${encodeURIComponent(id)}/actions`,
    cardFile:    (id: string) => `${base}/cards/${encodeURIComponent(id)}/files`,
    cardChats:   (id: string) => `${base}/cards/${encodeURIComponent(id)}/chats`,
    chatSubscribeSse:   (id: string) => `${base}/cards/${encodeURIComponent(id)}/chats/subscribe-sse`,
    chatUnsubscribeSse: (id: string) => `${base}/cards/${encodeURIComponent(id)}/chats/unsubscribe-sse`,
  };
}
// ============================================================================
// Standalone action helpers
// For custom board renderers that call server APIs directly without going
// through createBoardRuntimeClient — e.g. satellite views, plugin boards,
// or any shell that manages its own SSE lifecycle.
// ============================================================================

export type FetchServerFn = (path: string, init?: RequestInit) => Promise<Response>;
export type BoardPathsFn = (boardId: string) => BoardPaths;

/**
 * Construct the base URL used to resolve card file download URLs.
 * Pass the result as `fileUrlBase` to `LiveCard.init()` in a custom renderer.
 */
export function buildFileUrlBase(opts: {
  boardPaths: BoardPathsFn;
  getServerOrigin: () => string | null;
  boardId: string;
}): string | null {
  const origin = opts.getServerOrigin();
  if (!origin || !opts.boardId) return null;
  const paths = opts.boardPaths(opts.boardId);
  return `${origin}${paths.stream.replace(/\/sse(?:\?.*)?$/, '')}`;
}

/**
 * Upload a single File to a card's file endpoint.
 * Returns the file metadata object from the server, or null if no file was provided.
 */
export async function uploadCardFile(opts: {
  fetchServer: FetchServerFn;
  boardPaths: BoardPathsFn;
  boardId: string;
  cardId: string;
  file: File;
  inChat?: boolean;
  turnId?: string;
}): Promise<unknown | null> {
  if (!opts.file) return null;
  const paths = opts.boardPaths(opts.boardId);
  const hasTurnId = typeof opts.turnId === 'string' && opts.turnId !== '';
  const uploadPath = opts.inChat
    ? `${paths.cardFile(opts.cardId)}?inChat=true${hasTurnId ? `&turn-id=${encodeURIComponent(opts.turnId as string)}` : ''}`
    : paths.cardFile(opts.cardId);
  const fileName = typeof opts.file.name === 'string' ? opts.file.name : 'upload.bin';
  const contentType = opts.file.type || 'application/octet-stream';
  const res = await opts.fetchServer(uploadPath, {
    method: 'POST',
    headers: { 'content-type': contentType, 'x-file-name': encodeURIComponent(fileName) },
    body: opts.file,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Upload failed for ${opts.cardId} (${res.status})${errText ? ': ' + errText : ''}`);
  }
  const payload = await res.json() as { file?: unknown };
  return payload?.file ?? null;
}

/**
 * Prepare an action payload: if the action carries File objects in `payload.files`,
 * upload them and replace with server-returned metadata objects.
 * Passthrough for action types other than `file-upload` and `chat-send`.
 */
export async function prepareActionPayload(opts: {
  fetchServer: FetchServerFn;
  boardPaths: BoardPathsFn;
  boardId: string;
  cardId: string;
  actionType: string;
  payload?: Record<string, unknown> | null;
}): Promise<Record<string, unknown>> {
  const { actionType } = opts;
  if (actionType !== 'chat-send' && actionType !== 'file-upload') return opts.payload || {};
  const next: Record<string, unknown> = { ...(opts.payload || {}) };
  const turnId = typeof next['turn-id'] === 'string'
    ? String(next['turn-id'])
    : typeof next.turnId === 'string'
      ? String(next.turnId)
      : typeof next.turn === 'string'
        ? String(next.turn)
        : '';
  const rawFiles = Array.isArray(next.files) ? next.files as File[] : [];
  if (!rawFiles.length) { next.files = []; return next; }
  const uploaded: unknown[] = [];
  for (const file of rawFiles) {
    const meta = await uploadCardFile({ ...opts, file, inChat: actionType === 'chat-send', turnId: actionType === 'chat-send' ? turnId : undefined });
    if (meta) uploaded.push(meta);
  }
  next.files = actionType === 'chat-send' ? [] : uploaded;
  return next;
}

/**
 * PATCH a card's state via the server API.
 */
export async function patchCardState(opts: {
  fetchServer: FetchServerFn;
  boardPaths: BoardPathsFn;
  boardId: string;
  cardId: string;
  patch: Record<string, unknown>;
}): Promise<void> {
  const paths = opts.boardPaths(opts.boardId);
  const res = await opts.fetchServer(paths.patchCard(opts.cardId), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(opts.patch || {}),
  });
  if (!res.ok) throw new Error(`PATCH failed for ${opts.cardId} (${res.status})`);
}

/**
 * Trigger a forced card refresh (upsertCard restart:true) via the server's
 * POST /cards/:id/retrigger endpoint. Does not require a body.
 */
export async function retriggerCard(opts: {
  fetchServer: FetchServerFn;
  boardPaths: BoardPathsFn;
  boardId: string;
  cardId: string;
}): Promise<void> {
  const paths = opts.boardPaths(opts.boardId);
  const res = await opts.fetchServer(paths.retriggerCard(opts.cardId), { method: 'POST' });
  if (!res.ok) throw new Error(`retrigger failed for ${opts.cardId} (${res.status})`);
}

/**
 * Dispatch a card action via the server API.
 * File objects in `payload.files` are uploaded first via prepareActionPayload.
 * Returns the processed payload that was sent to the server.
 */
export async function dispatchCardAction(opts: {
  fetchServer: FetchServerFn;
  boardPaths: BoardPathsFn;
  boardId: string;
  cardId: string;
  actionType: string;
  payload?: Record<string, unknown> | null;
}): Promise<{ payload: Record<string, unknown> }> {
  const paths = opts.boardPaths(opts.boardId);
  const processedPayload = await prepareActionPayload(opts);
  const useMcpActions = opts.actionType === 'chat-send';
  const res = await opts.fetchServer(useMcpActions ? paths.mcpActions : paths.cardAction(opts.cardId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(
      useMcpActions
        ? { tool: opts.actionType, args: { card_id: opts.cardId, payload: processedPayload } }
        : { actionType: opts.actionType, payload: processedPayload },
    ),
  });
  if (!res.ok) {
    throw new Error(`${opts.actionType === 'refresh' ? 'Refresh' : 'Action'} failed for ${opts.cardId} (${res.status})`);
  }
  return { payload: processedPayload };
}

export function serverPayloadToBoardState(
  payload: BoardRuntimeArtifactsPayload,
  prevState: BoardState | null = null,
): BoardState {
  return buildBoardState(payload, prevState, selectLiveCardModel as Parameters<typeof buildBoardState>[2]);
}

export function applyBoardNotifications(
  prevState: BoardState,
  notifications: BoardNotification[],
  getFullPayload: () => unknown,
): BoardState {
  return applyNotification(
    prevState,
    notifications,
    selectLiveCardModel as Parameters<typeof applyNotification>[2],
    getFullPayload,
  );
}

/**
 * Return a new BoardState containing only the cards whose ids appear in `ids`.
 * Preserves original ordering.
 */
export function pickBoardState(state: BoardState, ids: string[]): BoardState {
  const idSet = new Set(ids.map(String));
  const nextIds = state.cardIds.filter((id) => idSet.has(id));
  const nextModels: Record<string, CardModel> = {};
  for (const id of nextIds) nextModels[id] = state.modelsById[id];
  return { payload: state.payload, cardIds: nextIds, modelsById: nextModels };
}

/**
 * Return a new BoardState with the cards in `excludeIds` removed.
 * Complement of pickBoardState — useful when a satellite view "consumes" a set of cards
 * and the main view should display the remainder.
 */
export function subtractBoardState(state: BoardState, excludeIds: Set<string> | string[]): BoardState {
  const excSet = excludeIds instanceof Set ? excludeIds : new Set((excludeIds as string[]).map(String));
  const nextIds = state.cardIds.filter((id) => !excSet.has(id));
  const nextModels: Record<string, CardModel> = {};
  for (const id of nextIds) nextModels[id] = state.modelsById[id];
  return { payload: state.payload, cardIds: nextIds, modelsById: nextModels };
}

function notifyBoardEngine(board: { engine?: unknown; core?: unknown } | null): void {
  const core = board?.core as { engine?: unknown } | null | undefined;
  const eng = (board?.engine ?? core?.engine) as { onServerSseEvent?: () => void; refreshOpenChatModal?: () => void } | undefined;
  if (eng && typeof eng.onServerSseEvent === 'function') {
    eng.onServerSseEvent();
  } else if (eng && typeof eng.refreshOpenChatModal === 'function') {
    eng.refreshOpenChatModal();
  }
}

function loadLiveCardGlobal() {
  const LiveCard = (globalThis as unknown as {
    LiveCard?: {
      init: (opts: unknown) => unknown;
      Board: (
        engine: unknown,
        el: HTMLElement,
        opts: unknown,
      ) => { setState: (fn: (prev: BoardState) => BoardState) => void; core?: unknown; engine?: unknown };
    };
  }).LiveCard;
  if (!LiveCard) throw new Error('LiveCard global not loaded — include live-cards.js before this script');
  return LiveCard;
}

export function createBoardRuntimeSession(options: BoardRuntimeClientOptions): BoardRuntimeSession {
  if (!options || typeof options !== 'object') throw new Error('options are required');

  const { fetchServer, boardPaths, getServerOrigin } = options;
  if (typeof fetchServer !== 'function') throw new Error('options.fetchServer is required');
  if (typeof boardPaths !== 'function') throw new Error('options.boardPaths is required');
  if (typeof getServerOrigin !== 'function') throw new Error('options.getServerOrigin is required');

  const stateRef: { current: BoardState | null } = { current: null };
  const listeners = new Set<(state: BoardState | null) => void>();
  let sse: EventSource | null = null;
  let currentBoardId: string | null = null;
  let currentPaths: BoardPaths | null = null;
  const activeChatSubscriptions: Record<string, true> = {};
  const pendingChatSubscriptions: Record<string, Promise<void>> = {};
  const sseClientId = (
    globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `lc-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );

  function emitState(): void {
    for (const listener of listeners) listener(stateRef.current);
  }

  function getFullPayload() {
    return stateRef.current ? stateRef.current.payload : null;
  }

  function setState(next: BoardState | null): BoardState | null {
    stateRef.current = next;
    emitState();
    return stateRef.current;
  }

  function requireBoardContext(): { boardId: string; paths: BoardPaths } {
    const boardId = currentBoardId;
    if (!boardId) throw new Error('Board runtime session is not bound to a board yet');
    const paths = currentPaths ?? boardPaths(boardId);
    currentPaths = paths;
    return { boardId, paths };
  }

  function replacePayload(payload: unknown): BoardState {
    const next = buildBoardState(payload, stateRef.current, selectLiveCardModel as Parameters<typeof buildBoardState>[2]);
    setState(next);
    return next;
  }

  function seedStateFromPayload(payload: unknown, prevState?: BoardState | null): BoardState {
    const next = buildBoardState(payload, prevState ?? stateRef.current, selectLiveCardModel as Parameters<typeof buildBoardState>[2]);
    setState(next);
    return next;
  }

  function seedState(state: BoardState | null): BoardState | null {
    return setState(state);
  }

  function applyNotificationBatch(notifications: BoardNotification[]): BoardState | null {
    if (!stateRef.current) return stateRef.current;
    const next = applyNotification(
      stateRef.current,
      notifications,
      selectLiveCardModel as Parameters<typeof applyNotification>[2],
      getFullPayload,
    );
    setState(next);
    return next;
  }

  async function uploadCardFileForSession(cardId: string, file: File, opts?: { inChat?: boolean; turnId?: string }): Promise<unknown | null> {
    const { boardId } = requireBoardContext();
    return uploadCardFile({ fetchServer, boardPaths, boardId, cardId, file, inChat: opts?.inChat, turnId: opts?.turnId });
  }

  async function dispatchCardActionForSession(
    cardId: string,
    actionType: string,
    payload?: Record<string, unknown> | null,
  ): Promise<{ payload: Record<string, unknown> }> {
    const { boardId } = requireBoardContext();
    if (actionType === 'chat-send') {
      await ensureChatSubscribed(cardId);
    }
    return dispatchCardAction({ fetchServer, boardPaths, boardId, cardId, actionType, payload });
  }

  function trackChatSubscription(cardId: string, request: Promise<void>): Promise<void> {
    pendingChatSubscriptions[cardId] = request;
    return request.finally(() => {
      if (pendingChatSubscriptions[cardId] === request) delete pendingChatSubscriptions[cardId];
    });
  }

  async function ensureChatSubscribed(cardId: string): Promise<void> {
    const pending = pendingChatSubscriptions[cardId];
    if (pending) {
      await pending;
      return;
    }
    if (activeChatSubscriptions[cardId]) return;
    await subscribeCardChats(cardId);
  }

  async function patchCardStateForSession(cardId: string, patch: Record<string, unknown>): Promise<void> {
    const { boardId } = requireBoardContext();
    await patchCardState({ fetchServer, boardPaths, boardId, cardId, patch });
  }

  async function retriggerCardForSession(cardId: string): Promise<void> {
    const { boardId } = requireBoardContext();
    await retriggerCard({ fetchServer, boardPaths, boardId, cardId });
  }

  async function subscribeCardChats(cardId: string): Promise<void> {
    const { paths } = requireBoardContext();
    const pending = pendingChatSubscriptions[cardId];
    if (pending) {
      await pending;
      return;
    }
    if (activeChatSubscriptions[cardId]) return;
    activeChatSubscriptions[cardId] = true;
    const request = (async () => {
      await fetchServer(paths.chatSubscribeSse(cardId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: sseClientId }),
      });
    })().catch(() => {
      delete activeChatSubscriptions[cardId];
    });
    await trackChatSubscription(cardId, request);
  }

  async function unsubscribeCardChats(cardId: string): Promise<void> {
    const { paths } = requireBoardContext();
    const pending = pendingChatSubscriptions[cardId];
    if (pending) {
      try { await pending; } catch { /* ignore pending subscribe errors */ }
    }
    delete activeChatSubscriptions[cardId];
    try {
      await fetchServer(paths.chatUnsubscribeSse(cardId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: sseClientId }),
      });
    } catch { /* ignore unsubscribe errors */ }
  }

  function resubscribeActiveChats(paths: BoardPaths): void {
    Object.keys(activeChatSubscriptions).forEach((cardId) => {
      void fetchServer(paths.chatSubscribeSse(cardId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ clientId: sseClientId }),
      }).catch(() => { /* ignore re-subscribe errors */ });
    });
  }

  function handleIncomingUpdate(update: unknown): void {
    const payload = update as { kind?: string; notifications?: BoardNotification[]; cardDefinitions?: unknown[] };
    if (payload?.kind === 'notification-batch' && Array.isArray(payload.notifications)) {
      applyNotificationBatch(payload.notifications);
    } else if (payload?.cardDefinitions) {
      replacePayload(payload);
    }
  }

  function attachProvidedState(params: { boardId: string; state?: BoardState | null; payload?: BoardRuntimeArtifactsPayload | null }): BoardState | null {
    currentBoardId = String(params.boardId || 'default');
    currentPaths = boardPaths(currentBoardId);
    if (params.state !== undefined) return seedState(params.state ?? null);
    if (params.payload) return seedStateFromPayload(params.payload, stateRef.current);
    return stateRef.current;
  }

  function applyServerUpdate(update: { kind?: string; notifications?: BoardNotification[]; cardDefinitions?: unknown[]; [key: string]: unknown }): BoardState | null {
    handleIncomingUpdate(update);
    return stateRef.current;
  }

  function closeSse(): void {
    if (sse) {
      sse.close();
      sse = null;
    }
  }

  async function bootstrap(params: BoardRuntimeSessionBootstrapParams = {}): Promise<BoardState | null> {
    const boardId = String(params.boardId || currentBoardId || 'default');
    currentBoardId = boardId;
    const paths = boardPaths(boardId);
    currentPaths = paths;

    if (params.initialState !== undefined) {
      seedState(params.initialState ?? null);
    } else if (params.initialPayload !== undefined) {
      seedStateFromPayload(params.initialPayload, stateRef.current);
    }

    if (params.skipInitBoard !== true) {
      const bootstrapPath = `${paths.stream}${paths.stream.includes('?') ? '&' : '?'}one-shot`;
      const bootstrapRes = await fetchServer(bootstrapPath);
      if (!bootstrapRes.ok) throw new Error(`Server one-shot SSE bootstrap failed (${bootstrapRes.status}).`);
    }

    const origin = getServerOrigin();
    if (!origin) throw new Error('Server origin not resolved before SSE start');

    closeSse();

    const waitForInitialPayload = !stateRef.current;
    const streamUrl = `${origin}${paths.stream}${paths.stream.includes('?') ? '&' : '?'}clientId=${encodeURIComponent(sseClientId)}`;

    const initialPayload = await new Promise<unknown | null>((resolve, reject) => {
      const sseConn = new EventSource(streamUrl);
      sse = sseConn;
      let gotInitialPayload = false;
      const timeout = waitForInitialPayload
        ? setTimeout(() => {
            if (!gotInitialPayload) reject(new Error('SSE initial payload timeout (15s)'));
          }, 15_000)
        : null;

      sseConn.onopen = () => {
        resubscribeActiveChats(paths);
        if (!waitForInitialPayload) resolve(stateRef.current?.payload ?? null);
      };

      sseConn.onmessage = (evt) => {
        try {
          const update = JSON.parse(evt.data || '{}');
          handleIncomingUpdate(update);
          if (!gotInitialPayload && waitForInitialPayload && (update?.cardDefinitions || selectAllLiveCardModels(update))) {
            gotInitialPayload = true;
            if (timeout) clearTimeout(timeout);
            resolve(update);
          }
        } catch {
          if (!waitForInitialPayload) return;
        }
      };

      sseConn.onerror = () => {
        if (waitForInitialPayload && !gotInitialPayload) {
          if (timeout) clearTimeout(timeout);
          reject(new Error('SSE connection failed during bootstrap'));
        }
      };
    });

    if (waitForInitialPayload) {
      if (!selectAllLiveCardModels(initialPayload as BoardRuntimeArtifactsPayload)) {
        throw new Error('SSE payload missing published runtime artifacts');
      }
      replacePayload(initialPayload);
    }

    return stateRef.current;
  }

  function subscribe(listener: (state: BoardState | null) => void): () => void {
    listeners.add(listener);
    listener(stateRef.current);
    return () => { listeners.delete(listener); };
  }

  function dispose(): void {
    closeSse();
    Object.keys(activeChatSubscriptions).forEach((cardId) => delete activeChatSubscriptions[cardId]);
    currentPaths = null;
    currentBoardId = null;
    listeners.clear();
    stateRef.current = null;
  }

  return {
    bootstrap,
    attachProvidedState,
    applyServerUpdate,
    seedStateFromPayload,
    seedState,
    applyNotificationBatch,
    replacePayload,
    subscribe,
    closeSse,
    isConnected: () => sse != null,
    getState: () => stateRef.current,
    getPayload: getFullPayload,
    getBoardId: () => currentBoardId,
    getClientId: () => sseClientId,
    getSseClientId: () => sseClientId,
    patchCardState: patchCardStateForSession,
    retriggerCard: retriggerCardForSession,
    dispatchCardAction: dispatchCardActionForSession,
    uploadCardFile: uploadCardFileForSession,
    subscribeCardChats,
    unsubscribeCardChats,
    dispose,
  };
}

export function createDerivedBoardRuntime(options: DerivedBoardRuntimeOptions): DerivedBoardRuntime {
  if (!options || typeof options !== 'object') throw new Error('options are required');
  if (!options.session) throw new Error('options.session is required');

  const { session, ...deriveOptions } = options;
  const canvas = (options.session && 'canvas' in options && typeof (options as { canvas?: unknown }).canvas === 'object')
    ? (options as { canvas?: { height?: string; overflow?: string } }).canvas
    : { height: '72vh', overflow: 'auto' };

  let derivedState = session.getState()
    ? deriveBoardState(session.getState() as BoardState, deriveOptions)
    : null;
  let board: { setState: (fn: (prev: BoardState) => BoardState) => void; core?: unknown; engine?: unknown } | null = null;
  let currentMode = String((options as { initialMode?: string }).initialMode || 'board');
  const listeners = new Set<(state: BoardState | null) => void>();

  function emitState(): void {
    for (const listener of listeners) listener(derivedState);
  }

  function recompute(sourceState: BoardState | null): void {
    derivedState = sourceState ? deriveBoardState(sourceState, deriveOptions) : null;
    emitState();
    if (board && derivedState) {
      board.setState(() => derivedState as BoardState);
      notifyBoardEngine(board);
    }
  }

  const unsubscribeSession = session.subscribe((sourceState) => {
    recompute(sourceState);
  });

  function mountBoard(params: MountBoardViewParams): unknown {
    if (!derivedState) throw new Error('Derived board runtime has no state to mount');
    const rootEl = params?.rootElement;
    if (!rootEl) throw new Error('mountBoard requires params.rootElement');
    currentMode = String(params?.mode || currentMode || 'board');
    const fileUrlBase = deriveOptions.boardPaths && deriveOptions.getServerOrigin && session.getBoardId()
      ? buildFileUrlBase({
        boardPaths: deriveOptions.boardPaths,
        getServerOrigin: deriveOptions.getServerOrigin,
        boardId: session.getBoardId() as string,
      })
      : null;

    const LiveCard = loadLiveCardGlobal();
    const engine = LiveCard.init({
      resolve: (id: string) => derivedState?.modelsById[id],
      chartLib:  (globalThis as { Chart?: unknown }).Chart  ?? null,
      markdown:  (globalThis as { marked?: { parse: (t: string) => string } }).marked
        ? (text: string) => (globalThis as unknown as { marked: { parse: (t: string) => string } }).marked.parse(text)
        : null,
      sanitize:  (globalThis as { DOMPurify?: { sanitize: (h: string) => string } }).DOMPurify
        ? (html: string) => (globalThis as unknown as { DOMPurify: { sanitize: (h: string) => string } }).DOMPurify.sanitize(html)
        : null,
      onPatchState: (id: string, patch: Record<string, unknown>) => session.patchCardState(id, patch),
      onRefresh: (id: string) => session.retriggerCard(id),
      onAction: (id: string, actionType: string, actionPayload: Record<string, unknown> | null) =>
        session.dispatchCardAction(id, actionType, actionPayload).then(() => undefined),
      startReceivingChats: (id: string) => { void session.subscribeCardChats(id); },
      stopReceivingChats: (id: string) => { void session.unsubscribeCardChats(id); },
      fileUrlBase: fileUrlBase || undefined,
    });

    rootEl.innerHTML = '';
    board = LiveCard.Board(engine, rootEl, {
      initialState: derivedState,
      getNodeIds: (s: BoardState) => s.cardIds,
      selectNode: (s: BoardState, id: string) => s.modelsById[id],
      mode: currentMode,
      canvas,
    });
    return board;
  }

  function subscribe(listener: (state: BoardState | null) => void): () => void {
    listeners.add(listener);
    listener(derivedState);
    return () => { listeners.delete(listener); };
  }

  function setMode(mode: string): void {
    currentMode = String(mode || 'board');
    const core = board && (board as { core?: { setMode?: (m: string) => void } }).core;
    if (core && typeof core.setMode === 'function') core.setMode(currentMode);
  }

  function autoLayout(): void {
    if (!board) return;
    currentMode = 'canvas';
    const core = (board as { core?: { setMode?: (m: string) => void; autoLayout?: () => void } }).core;
    if (core && typeof core.setMode === 'function') core.setMode('canvas');
    if (core && typeof core.autoLayout === 'function') core.autoLayout();
  }

  function setDevMode(enabled: boolean): void {
    const core = board && (board as { core?: { setDevMode?: (e: boolean) => void } }).core;
    if (core && typeof core.setDevMode === 'function') core.setDevMode(Boolean(enabled));
  }

  function dispose(): void {
    unsubscribeSession();
    listeners.clear();
    board = null;
  }

  return {
    mountBoard,
    subscribe,
    getState: () => derivedState,
    getFullState: () => session.getState(),
    getBoardId: () => session.getBoardId(),
    getClientId: () => session.getClientId(),
    getSseClientId: () => session.getSseClientId(),
    patchCardState: (cardId, patch) => session.patchCardState(cardId, patch),
    retriggerCard: (cardId) => session.retriggerCard(cardId),
    dispatchCardAction: (cardId, actionType, payload) => session.dispatchCardAction(cardId, actionType, payload),
    uploadCardFile: (cardId, file, opts) => session.uploadCardFile(cardId, file, opts),
    subscribeCardChats: (cardId) => session.subscribeCardChats(cardId),
    unsubscribeCardChats: (cardId) => session.unsubscribeCardChats(cardId),
    setMode,
    autoLayout,
    setDevMode,
    getCurrentMode: () => currentMode,
    dispose,
  };
}

export interface BoardRuntimeClient {
  /** Bootstrap the board: /sse?one-shot → LiveCard.Board + SSE. */
  bootstrapBoard(params: BootstrapBoardParams): Promise<unknown>;
  /** Tear down SSE and release references. */
  dispose(): void;
  setMode(mode: string): void;
  autoLayout(): void;
  setDevMode(enabled: boolean): void;
  getCurrentMode(): string;
  getState(): BoardState | null;
  getRuntimeSession(): BoardRuntimeSession;
  createDerivedRuntime(options?: Omit<DerivedBoardRuntimeOptions, 'session'>): DerivedBoardRuntime;
}

// ============================================================================
// createBoardRuntimeClient
// ============================================================================

export function createBoardRuntimeClient(options: BoardRuntimeClientOptions): BoardRuntimeClient {
  const session = createBoardRuntimeSession(options);
  const derived = createDerivedBoardRuntime({
    session,
    boardPaths: options.boardPaths,
    getServerOrigin: options.getServerOrigin,
  });

  async function wrappedBootstrapBoard(params: BootstrapBoardParams): Promise<unknown> {
    const boardId = String(params?.boardId || 'default');
    await session.bootstrap({
      boardId,
      taskExecutorPath: params?.taskExecutorPath,
    });
    return derived.mountBoard({ rootElement: params.rootElement, mode: params.mode });
  }

  return {
    bootstrapBoard: wrappedBootstrapBoard,
    dispose: () => {
      derived.dispose();
      session.dispose();
    },
    setMode: (mode: string) => derived.setMode(mode),
    autoLayout: () => derived.autoLayout(),
    setDevMode: (enabled: boolean) => derived.setDevMode(enabled),
    getCurrentMode: () => derived.getCurrentMode(),
    getState: () => session.getState(),
    getRuntimeSession: () => session,
    createDerivedRuntime: (runtimeOptions = {}) => createDerivedBoardRuntime({ session, ...runtimeOptions }),
  };
}
