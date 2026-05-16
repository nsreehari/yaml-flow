/**
 * board-livecards-localstorage CDN bundle entry point.
 *
 * Bundles server-runtime + board-live-cards-public + localStorage adapter
 * into a single browser IIFE. Consumers wire up a board with:
 *
 *   <script src="https://cdn.jsdelivr.net/npm/jsonata/jsonata.min.js"></script>
 *   <script src="board-livecards-localstorage.js"></script>
 *   <script src="live-cards.js"></script>
 *   <script>
 *     const app = BoardLiveCardsLocalStorage.create('my-board', {
 *       cards: [ ... ],  // card JSON objects
 *       taskExecutor: async (ref, args) => { ... },
 *     });
 *     await app.bootstrap();
 *     const payload = app.getState();
 *     // → feed to LiveCard.Board via BoardLiveGraph.selectAllLiveCardModels
 *   </script>
 *
 * Global: window.BoardLiveCardsLocalStorage
 */

import { createSingleBoardServerRuntime } from '../server-runtime/index.js';
import type { SingleBoardRuntime, ExecutionRef, InvocationAdapter } from '../server-runtime/types.js';
import {
  createBrowserBoardPlatformAdapter,
  createInMemoryNotificationTransport,
  createLocalStorageChatStorage,
  getInMemoryNotificationBus,
} from '../cli/browser-api/board-live-cards-browser-adapter.js';
import { parseRef, serializeRef } from '../cli/common/storage-interface.js';

// ============================================================================
// Public types
// ============================================================================

export interface CreateOptions {
  /** Card JSON definitions to bootstrap the board with. */
  cards?: Array<Record<string, unknown>>;

  /**
   * In-browser task executor function.
   * Called when the drain cycle dispatches a source-fetch execution.
   * Receives the ExecutionRef and the dispatch args (source_def, callback, etc.).
   * If not provided, dispatch falls through to the adapter's HTTP dispatch.
   */
  taskExecutor?: (ref: ExecutionRef, args: Record<string, unknown>) => Promise<{ dispatched: boolean; error?: string }>;

  /**
   * In-browser chat handler function.
   * Called when a chat message triggers chat-handler invocation.
   * If not provided, dispatch falls through to the adapter's HTTP dispatch.
   */
  chatHandler?: (ref: ExecutionRef, args: Record<string, unknown>) => Promise<{ dispatched: boolean; error?: string }>;

  /** Task executor ref — defaults to built-in. */
  taskExecutorRef?: ExecutionRef;

  /** Chat handler ref — defaults to built-in. */
  chatHandlerRef?: ExecutionRef;

  /** Optional HTTP base URL for callback dispatch. */
  callbackBaseUrl?: string;

  /** Optional warning handler. */
  onWarn?: (msg: string) => void;

  /**
   * Called whenever board state changes.
   * Receives the notification batch produced by the latest drain cycle.
   * Consumers call getState() to read the current payload (no payload
   * rebuild happens here — it is the consumer's choice when to materialize).
   */
  onBoardChange?: (event: {
    notifications: Array<{ kind: string; [key: string]: unknown }>;
  }) => void;
}

/**
 * The browser runtime wraps SingleBoardRuntime and exposes direct-call methods
 * (no HTTP req/res needed). This is the shape consumers interact with.
 */
export interface BrowserBoardRuntime {
  /** Initialize the board and bootstrap all cards. */
  bootstrap(): Promise<void>;

  /**
   * Read the latest published runtime payload (cardDefinitions, statusSnapshot,
   * cardRuntimeById, dataObjectsByToken). Feed this to
   * BoardLiveGraph.selectAllLiveCardModels() / selectLiveCardModel() for rendering.
   */
  getState(): unknown;

  /** Patch a card's data (same semantics as PATCH /cards/:id). Resolves after drain completes. */
  patchCard(cardId: string, patch: Record<string, unknown>): Promise<void>;

  /** Apply a card action (chat-send, action, file-upload). Resolves after drain completes. */
  applyCardAction(cardId: string, actionType: string, payload: Record<string, unknown> | null): Promise<void>;

  /** Read chat records for a card. */
  readChatRecords(cardId: string): Array<Record<string, unknown>>;

  /** Clear chat records for a card. */
  clearChatRecords(cardId: string): void;

  /**
   * Write data to an in-memory blob and return its serialized ref (::in-memory::key).
   * Use this to stage fetched source data before calling reportSourceFetched.
   */
  writeMemoryBlob(key: string, data: string): string;

  /**
   * Report that a source fetch completed successfully.
   * The ref must point to a blob containing the fetched data (e.g. from writeMemoryBlob).
   * This triggers the board's sourceDataFetched → journal event → drain → card transition.
   */
  reportSourceFetched(token: string, ref: string): void;

  /**
   * Report that a source fetch failed.
   * This triggers the board's sourceDataFetchFailure → journal event → drain.
   */
  reportSourceFetchFailure(token: string, reason: string): void;

  /** Access the underlying SingleBoardRuntime for advanced use. */
  readonly runtime: SingleBoardRuntime;
}

// ============================================================================
// create() — factory
// ============================================================================

export function create(
  namespace: string,
  opts?: CreateOptions,
): BrowserBoardRuntime {
  const cards = opts?.cards ?? [];
  const onWarn = opts?.onWarn ?? (() => { /* no-op */ });

  // ── Build localStorage-backed platform adapter ───────────────────────────

  const notifyChannel = `${namespace}:notify`;
  const boardAdapter = createBrowserBoardPlatformAdapter(namespace, {
    callbackBaseUrl: opts?.callbackBaseUrl,
    notifyChannel,
    onWarn,
  });

  const baseRef = parseRef(serializeRef({ kind: 'localstorage', value: namespace }));
  const cardStoreRef = serializeRef({ kind: 'localstorage', value: `${namespace}:card-store` });
  const outputsStoreRef = serializeRef({ kind: 'localstorage', value: `${namespace}:outputs` });

  // ── Invocation adapter — routes to in-browser functions or HTTP ──────────

  const browserTaskExecutor = opts?.taskExecutor ?? null;
  const browserChatHandler = opts?.chatHandler ?? null;

  const taskExecutorWhatToRun = serializeRef({ kind: 'in-browser', value: `${namespace}:task-executor` });
  const chatHandlerWhatToRun = serializeRef({ kind: 'in-browser', value: `${namespace}:chat-handler` });

  // Register in-browser handlers on the adapter
  if (browserTaskExecutor) {
    boardAdapter.registerHandler(taskExecutorWhatToRun, browserTaskExecutor);
  }
  if (browserChatHandler) {
    boardAdapter.registerHandler(chatHandlerWhatToRun, browserChatHandler);
  }

  const invocationAdapter: InvocationAdapter = {
    async invoke(ref: ExecutionRef, args: Record<string, unknown>) {
      // Route in-browser refs through the adapter's handler registry
      if (ref.howToRun === 'in-browser') {
        return boardAdapter.dispatchExecution(ref, args);
      }
      // HTTP dispatch
      return boardAdapter.dispatchExecution(ref, args);
    },
  };

  // ── Determine executor/handler refs ──────────────────────────────────────

  const taskExecutorRef: ExecutionRef | undefined = opts?.taskExecutorRef
    ?? (browserTaskExecutor
      ? { meta: 'task-executor', howToRun: 'in-browser' as const, whatToRun: taskExecutorWhatToRun }
      : undefined);

  const chatHandlerRef: ExecutionRef | undefined = opts?.chatHandlerRef
    ?? (browserChatHandler
      ? { meta: 'chat-handler', howToRun: 'in-browser' as const, whatToRun: chatHandlerWhatToRun }
      : undefined);

  // ── Create server runtime with localStorage adapters ─────────────────────

  const notificationTransport = createInMemoryNotificationTransport();
  const chatStorage = createLocalStorageChatStorage(namespace);

  const serverRuntime = createSingleBoardServerRuntime({
    boardId: namespace,
    chatStorage,
    boards: [{
      label: namespace,
      boardAdapter,
      baseRef,
      cardStoreRef,
      outputsStoreRef,
      notifyRef: { kind: 'in-memory-bus', value: notifyChannel },
      taskExecutorRef,
      chatHandlerRef,
    }],
    invocationAdapter,
    notificationTransport,
    logger: {
      info: (...args: unknown[]) => console.log('[board]', ...args),
      warn: (...args: unknown[]) => { onWarn(String(args[0])); console.warn('[board]', ...args); },
      error: (...args: unknown[]) => console.error('[board]', ...args),
    },
  });

  // ── Host concern (Part A): always write fresh card definitions ───────────
  // Card definitions (provides/requires/compute/source_defs) must always
  // reflect the current code. An old localStorage session may have stale
  // definitions that lack provides bindings, causing upstream token routing
  // to break. Always overwrite so the graph config is built from current defs.
  // Runtime state (computed values, snapshots) is stored in separate keys and
  // is not affected by this write.

  if (cards.length) {
    serverRuntime.cardStore.set({ body: cards });
  }

  // ── Subscribe to board change notifications (batched, SSE-like) ─────────

  if (opts?.onBoardChange) {
    const bus = getInMemoryNotificationBus(notifyChannel);
    bus.subscribe((event) => {
      const e = event as { kind?: string; notifications?: Array<{ kind: string; [key: string]: unknown }> };
      if (!e || e.kind !== 'notification-batch' || !Array.isArray(e.notifications) || e.notifications.length === 0) {
        return;
      }
      opts.onBoardChange?.({ notifications: e.notifications });
    });
  }

  // ── Expose direct-call methods via handleRuntimeApi with synthetic req/res

  function makeSyntheticRequest(method: string, path: string, body?: unknown): import('../server-runtime/types.js').RuntimeRequest {
    const bodyStr = body ? JSON.stringify(body) : '';
    const bodyBytes = new TextEncoder().encode(bodyStr);
    let consumed = false;
    return {
      method,
      url: path,
      headers: { 'content-type': 'application/json' },
      on(_event: string, _listener: (...args: unknown[]) => void) { /* no-op for browser */ },
      [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
        const iter: AsyncIterableIterator<Uint8Array> = {
          async next() {
            if (consumed) return { done: true as const, value: undefined as unknown as Uint8Array };
            consumed = true;
            return { done: false as const, value: bodyBytes };
          },
          [Symbol.asyncIterator]() { return iter; },
        };
        return iter;
      },
    };
  }

  function makeSyntheticResponse(): { res: import('../server-runtime/types.js').RuntimeResponse; getResult: () => { status: number; body: unknown } } {
    let status = 200;
    let chunks: string[] = [];
    const res: import('../server-runtime/types.js').RuntimeResponse = {
      writeHead(s: number) { status = s; },
      write(data: string | Uint8Array) { chunks.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); return true; },
      end(data?: string | Uint8Array) { if (data) chunks.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); },
    };
    return {
      res,
      getResult: () => {
        const raw = chunks.join('');
        let body: unknown;
        try { body = JSON.parse(raw); } catch { body = raw; }
        return { status, body };
      },
    };
  }

  const apiBase = serverRuntime.apiBasePath;

  return {
    async bootstrap() {
      const req = makeSyntheticRequest('GET', `${apiBase}/bootstrap`);
      const { res } = makeSyntheticResponse();
      await serverRuntime.handleRuntimeApi(req, res, new URL(`http://localhost${apiBase}/bootstrap`));
    },

    getState() {
      return serverRuntime.buildPublishedRuntimePayload();
    },

    async patchCard(cardId: string, patch: Record<string, unknown>) {
      const path = `${apiBase}/cards/${encodeURIComponent(cardId)}`;
      const req = makeSyntheticRequest('PATCH', path, patch);
      const { res } = makeSyntheticResponse();
      await serverRuntime.handleRuntimeApi(req, res, new URL(`http://localhost${path}`));
    },

    async applyCardAction(cardId: string, actionType: string, payload: Record<string, unknown> | null) {
      const path = `${apiBase}/cards/${encodeURIComponent(cardId)}/actions`;
      const req = makeSyntheticRequest('POST', path, { actionType, payload });
      const { res } = makeSyntheticResponse();
      await serverRuntime.handleRuntimeApi(req, res, new URL(`http://localhost${path}`));
    },

    readChatRecords(cardId: string): Array<Record<string, unknown>> {
      const path = `${apiBase}/cards/${encodeURIComponent(cardId)}/chats`;
      const req = makeSyntheticRequest('GET', path);
      const synth = makeSyntheticResponse();
      // handleRuntimeApi is async but GET chats is sync — safe to use result after await
      void serverRuntime.handleRuntimeApi(req, synth.res, new URL(`http://localhost${path}`));
      const result = synth.getResult();
      const body = result.body as Record<string, unknown>;
      return Array.isArray(body?.messages) ? body.messages as Array<Record<string, unknown>> : [];
    },

    clearChatRecords(cardId: string) {
      serverRuntime.clearChatRecords(cardId);
    },

    writeMemoryBlob(key: string, data: string): string {
      return boardAdapter.writeMemoryBlob(key, data);
    },

    reportSourceFetched(token: string, ref: string) {
      serverRuntime.reportSourceFetched(token, ref);
    },

    reportSourceFetchFailure(token: string, reason: string) {
      serverRuntime.reportSourceFetchFailure(token, reason);
    },

    get runtime() {
      return serverRuntime;
    },
  };
}

// Re-export payload selectors so consumers don't need to load board-livegraph-engine separately.
export { selectLiveCardModel, selectAllLiveCardModels } from '../board-livegraph-runtime/index.js';

// Re-export board-state reducer with selectLiveCardModel pre-bound so shells
// don't need to pass it explicitly.
import {
  buildBoardState as _buildBoardState,
  applyNotification as _applyNotification,
} from '../cli/common/board-state-reducer.js';
export type { BoardState, CardModel } from '../cli/common/board-state-reducer.js';
import { selectLiveCardModel as _selectLiveCardModel } from '../board-livegraph-runtime/index.js';

export function buildBoardState(
  payload: unknown,
  prevState: import('../cli/common/board-state-reducer.js').BoardState | null,
): import('../cli/common/board-state-reducer.js').BoardState {
  return _buildBoardState(payload, prevState, _selectLiveCardModel as Parameters<typeof _buildBoardState>[2]);
}

export function applyNotification(
  prevState: import('../cli/common/board-state-reducer.js').BoardState,
  notifications: Array<{ kind: string; [key: string]: unknown }>,
  getFullPayload: () => unknown,
): import('../cli/common/board-state-reducer.js').BoardState {
  return _applyNotification(prevState, notifications, _selectLiveCardModel as Parameters<typeof _applyNotification>[2], getFullPayload);
}
