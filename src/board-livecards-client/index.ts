/**
 * board-livecards-client — browser IIFE bundle.
 *
 * Two layers in one bundle:
 *   1. Platform-free state: buildBoardState, applyNotification, selectLiveCardModel,
 *      selectAllLiveCardModels — usable with any transport (Firebase, WebSocket, SSE, etc.)
 *   2. SSE/HTTP transport: createBoardRuntimeClient — for yaml-flow server runtime.
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
import { buildBoardState, applyNotification, type BoardState, type CardModel } from '../cli/common/board-state-reducer.js';

// ============================================================================
// Platform-free state exports
// Re-exported so consumers using any transport (Firebase, WS, SSE) can drive
// the LiveCard UI without loading the full localstorage bundle.
// ============================================================================
export { buildBoardState, applyNotification, selectLiveCardModel, selectAllLiveCardModels };
export type { BoardState, CardModel };

// ============================================================================
// Public types
// ============================================================================

export interface BoardPaths {
  initBoard: string;
  stream: string;
  patchCard: (id: string) => string;
  cardAction: (id: string) => string;
  cardChats: (id: string) => string;
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
  /** Optional path passed to init-board for server-side executor resolution. */
  taskExecutorPath?: string;
  mode?: string;
  rootElement: HTMLElement;
}

/**
 * Build the standard BoardPaths for a yaml-flow server runtime board.
 *
 * Covers only the paths owned by the server runtime (SSE, patch, action, files, chats,
 * init-board). Demo-server-specific endpoints (demo-setup, board registry
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
    initBoard: `${base}/init-board`,
    stream:    `${base}/sse`,
    patchCard:   (id: string) => `${base}/cards/${encodeURIComponent(id)}`,
    cardAction:  (id: string) => `${base}/cards/${encodeURIComponent(id)}/actions`,
    cardFile:    (id: string) => `${base}/cards/${encodeURIComponent(id)}/files`,
    cardChats:   (id: string) => `${base}/cards/${encodeURIComponent(id)}/chats`,
  };
}

/** Flat path helper for single-board servers (no boardId segment in URL). */
export function singleBoardPaths(apiBase = '/api/board'): BoardPaths {
  const base = apiBase.replace(/\/$/, '');
  return {
    initBoard: `${base}/init-board`,
    stream:    `${base}/sse`,
    patchCard:   (id: string) => `${base}/cards/${encodeURIComponent(id)}`,
    cardAction:  (id: string) => `${base}/cards/${encodeURIComponent(id)}/actions`,
    cardFile:    (id: string) => `${base}/cards/${encodeURIComponent(id)}/files`,
    cardChats:   (id: string) => `${base}/cards/${encodeURIComponent(id)}/chats`,
  };
}

export interface BoardRuntimeClient {
  /** Bootstrap the board: init-board → bootstrap-cards → LiveCard.Board + SSE. */
  bootstrapBoard(params: BootstrapBoardParams): Promise<unknown>;
  /** Tear down SSE and release references. */
  dispose(): void;
  setMode(mode: string): void;
  autoLayout(): void;
  setDevMode(enabled: boolean): void;
  getCurrentMode(): string;
}

// ============================================================================
// createBoardRuntimeClient
// ============================================================================

export function createBoardRuntimeClient(options: BoardRuntimeClientOptions): BoardRuntimeClient {
  if (!options || typeof options !== 'object') throw new Error('options are required');

  const { fetchServer, boardPaths, getServerOrigin } = options;
  if (typeof fetchServer !== 'function') throw new Error('options.fetchServer is required');
  if (typeof boardPaths !== 'function') throw new Error('options.boardPaths is required');
  if (typeof getServerOrigin !== 'function') throw new Error('options.getServerOrigin is required');

  const canvas = (options.canvas && typeof options.canvas === 'object')
    ? options.canvas
    : { height: '72vh', overflow: 'auto' };

  // Reactive state — single source of truth
  const stateRef: { current: BoardState | null } = { current: null };
  let board: { setState: (fn: (prev: BoardState) => BoardState) => void; core?: unknown; engine?: unknown } | null = null;
  let sse: EventSource | null = null;
  let currentMode = String(options.initialMode || 'board');

  function getFullPayload() {
    return stateRef.current ? stateRef.current.payload : null;
  }

  // ── File upload helpers ───────────────────────────────────────────────────

  async function uploadCardFile(
    boardId: string,
    cardId: string,
    file: File,
    opts?: { inChat?: boolean },
  ): Promise<unknown | null> {
    if (!file) return null;
    const inChat = opts?.inChat === true;
    const fileName = typeof file.name === 'string' ? file.name : 'upload.bin';
    const contentType = file.type || 'application/octet-stream';
    const paths = boardPaths(boardId);
    const uploadPath = inChat
      ? `${paths.cardFile(cardId)}?inChat=true`
      : paths.cardFile(cardId);

    const upload = await fetchServer(uploadPath, {
      method: 'POST',
      headers: {
        'content-type': contentType,
        'x-file-name': encodeURIComponent(fileName),
      },
      body: file,
    });

    if (!upload.ok) {
      const errText = await upload.text();
      throw new Error(`Upload failed (${upload.status}): ${errText || 'unknown error'}`);
    }

    const payload = await upload.json() as { file?: unknown };
    return payload?.file ?? null;
  }

  async function uploadActionFiles(
    boardId: string,
    cardId: string,
    actionType: string,
    payload: Record<string, unknown> | null,
  ): Promise<Record<string, unknown>> {
    if (actionType !== 'chat-send' && actionType !== 'file-upload') return payload || {};
    const nextPayload: Record<string, unknown> = { ...(payload || {}) };
    const rawFiles = Array.isArray(nextPayload.files) ? nextPayload.files as File[] : [];
    if (!rawFiles.length) {
      nextPayload.files = [];
      return nextPayload;
    }

    const uploaded: unknown[] = [];
    for (const file of rawFiles) {
      const fileMeta = await uploadCardFile(boardId, cardId, file, { inChat: actionType === 'chat-send' });
      if (fileMeta) uploaded.push(fileMeta);
    }

    // For chat uploads, server-side file API already records metadata and emits system chat logs.
    nextPayload.files = actionType === 'chat-send' ? [] : uploaded;
    return nextPayload;
  }

  // ── bootstrapBoard ────────────────────────────────────────────────────────

  async function bootstrapBoard(params: BootstrapBoardParams): Promise<unknown> {
    const boardId = String(params?.boardId || 'default');
    const taskExecutorPath = typeof params?.taskExecutorPath === 'string' ? params.taskExecutorPath.trim() : '';
    const mode = String(params?.mode || currentMode || 'board');
    const rootEl = params?.rootElement;
    if (!rootEl) throw new Error('bootstrapBoard requires params.rootElement');

    const paths = boardPaths(boardId);

    const initBoardPath = taskExecutorPath
      ? `${paths.initBoard}?taskExecutorPath=${encodeURIComponent(taskExecutorPath)}`
      : paths.initBoard;
    const initBoardRes = await fetchServer(initBoardPath);
    if (!initBoardRes.ok) throw new Error(`Server init-board failed (${initBoardRes.status}).`);

    const origin = getServerOrigin();
    if (!origin) throw new Error('Server origin not resolved before SSE start');

    // Open SSE first and wait for the initial full-payload frame.
    // The /sse endpoint calls bootstrapBoard() server-side, publishes the
    // persisted state snapshot via the notification channel, then sends the
    // full runtime payload as the first SSE frame.
    const initialPayload = await new Promise<unknown>((resolve, reject) => {
      const sseConn = new EventSource(`${origin}${paths.stream}`);
      sse = sseConn;
      let gotInitialPayload = false;
      const timeout = setTimeout(() => {
        if (!gotInitialPayload) reject(new Error('SSE initial payload timeout (15s)'));
      }, 15_000);
      sseConn.onmessage = (evt) => {
        try {
          const update = JSON.parse(evt.data || '{}');
          if (!gotInitialPayload && (update?.cardDefinitions || selectAllLiveCardModels(update))) {
            gotInitialPayload = true;
            clearTimeout(timeout);
            resolve(update);
          }
        } catch { /* wait for valid frame */ }
      };
      sseConn.onerror = () => {
        if (!gotInitialPayload) {
          clearTimeout(timeout);
          reject(new Error('SSE connection failed during bootstrap'));
        }
      };
    });

    if (!selectAllLiveCardModels(initialPayload as BoardRuntimeArtifactsPayload)) throw new Error('SSE payload missing published runtime artifacts');

    // Build initial reactive state using bundled selectLiveCardModel
    stateRef.current = buildBoardState(initialPayload, null, selectLiveCardModel as Parameters<typeof buildBoardState>[2]);

    const LiveCard = (globalThis as unknown as { LiveCard?: { init: (opts: unknown) => unknown; Board: (engine: unknown, el: HTMLElement, opts: unknown) => typeof board } }).LiveCard;
    if (!LiveCard) throw new Error('LiveCard global not loaded — include live-cards.js before this script');

    const engine = LiveCard.init({
      resolve: (id: string) => stateRef.current?.modelsById[id],
      chartLib:  (globalThis as { Chart?: unknown }).Chart  ?? null,
      markdown:  (globalThis as { marked?: { parse: (t: string) => string } }).marked
        ? (text: string) => (globalThis as unknown as { marked: { parse: (t: string) => string } }).marked.parse(text)
        : null,
      sanitize:  (globalThis as { DOMPurify?: { sanitize: (h: string) => string } }).DOMPurify
        ? (html: string) => (globalThis as unknown as { DOMPurify: { sanitize: (h: string) => string } }).DOMPurify.sanitize(html)
        : null,
      onPatchState: async (id: string, patch: Record<string, unknown>) => {
        await fetchServer(paths.patchCard(id), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch || {}),
        });
      },
      onRefresh: async (id: string) => {
        await fetchServer(paths.patchCard(id), {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        });
      },
      onAction: async (id: string, actionType: string, actionPayload: Record<string, unknown> | null) => {
        const uploadedPayload = await uploadActionFiles(boardId, id, actionType, actionPayload);
        await fetchServer(paths.cardAction(id), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actionType, payload: uploadedPayload || {} }),
        });
      },
      getChatMessages: async (id: string) => {
        const res = await fetchServer(paths.cardChats(id));
        if (!res.ok) return [];
        const chatPayload = await res.json() as { messages?: Array<{ role?: string; text?: string }> };
        return (chatPayload?.messages ?? []).map((m) => ({
          role: typeof m?.role === 'string' ? m.role : 'system',
          text: typeof m?.text === 'string' ? m.text : '',
          files: [],
        }));
      },
    });

    rootEl.innerHTML = '';
    board = LiveCard.Board(engine, rootEl, {
      initialState: stateRef.current,
      getNodeIds: (s: BoardState) => s.cardIds,
      selectNode:  (s: BoardState, id: string) => s.modelsById[id],
      mode,
      canvas,
    });
    currentMode = mode;

    // Wire up the ongoing SSE message handler on the already-open connection.
    sse!.onmessage = (evt) => {
      try {
        const update = JSON.parse(evt.data || '{}') as {
          kind?: string;
          notifications?: Array<{ kind: string; [k: string]: unknown }>;
          cardDefinitions?: unknown[];
          engine?: { onServerSseEvent?: () => void; refreshOpenChatModal?: () => void };
        };

        if (update?.kind === 'notification-batch' && Array.isArray(update.notifications)) {
          if (board) {
            board.setState((prev: BoardState) => {
              const next = applyNotification(
                prev,
                update.notifications!,
                selectLiveCardModel as Parameters<typeof applyNotification>[2],
                getFullPayload,
              );
              stateRef.current = next;
              return next;
            });
          }
        } else if (update?.cardDefinitions) {
          const next = buildBoardState(update, stateRef.current, selectLiveCardModel as Parameters<typeof buildBoardState>[2]);
          stateRef.current = next;
          if (board) board.setState(() => next);
        }

        const eng = board && (board as { engine?: { onServerSseEvent?: () => void; refreshOpenChatModal?: () => void } }).engine;
        if (eng && typeof eng.onServerSseEvent === 'function') {
          eng.onServerSseEvent();
        } else if (eng && typeof eng.refreshOpenChatModal === 'function') {
          eng.refreshOpenChatModal();
        }
      } catch (err) {
        console.warn('Bad SSE payload', err);
      }
    };

    return board;
  }

  // ── Control methods ───────────────────────────────────────────────────────

  function dispose() {
    if (sse) { sse.close(); sse = null; }
    board = null;
    stateRef.current = null;
  }

  function setMode(mode: string) {
    currentMode = String(mode || 'board');
    const core = board && (board as { core?: { setMode?: (m: string) => void } }).core;
    if (core && typeof core.setMode === 'function') core.setMode(currentMode);
  }

  function autoLayout() {
    if (!board) return;
    currentMode = 'canvas';
    const core = (board as { core?: { setMode?: (m: string) => void; autoLayout?: () => void } }).core;
    if (core && typeof core.setMode === 'function') core.setMode('canvas');
    if (core && typeof core.autoLayout === 'function') core.autoLayout();
  }

  function setDevMode(enabled: boolean) {
    const core = board && (board as { core?: { setDevMode?: (e: boolean) => void } }).core;
    if (core && typeof core.setDevMode === 'function') core.setDevMode(Boolean(enabled));
  }

  function getCurrentMode() { return currentMode; }

  return { bootstrapBoard, dispose, setMode, autoLayout, setDevMode, getCurrentMode };
}
