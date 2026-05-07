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
 *     const payload = app.buildPublishedRuntimePayload();
 *     // → feed to LiveCard.Board via buildLiveCardModelsFromArtifacts
 *   </script>
 *
 * Global: window.BoardLiveCardsLocalStorage
 */

import { createSingleBoardServerRuntime } from '../server-runtime/index.js';
import type { SingleBoardRuntime, ExecutionRef, InvocationAdapter } from '../server-runtime/types.js';
import { createBrowserBoardPlatformAdapter, createInMemoryNotificationTransport } from '../cli/browser-api/board-live-cards-browser-adapter.js';
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
}

/**
 * The browser runtime wraps SingleBoardRuntime and exposes direct-call methods
 * (no HTTP req/res needed). This is the shape consumers interact with.
 */
export interface BrowserBoardRuntime {
  /** Initialize the board and bootstrap all cards. */
  bootstrap(): Promise<void>;

  /**
   * Build the full runtime payload (cardDefinitions, statusSnapshot,
   * cardRuntimeById, dataObjectsByToken). Feed this to
   * BoardLiveGraph.buildLiveCardModelsFromArtifacts() for rendering.
   */
  buildPublishedRuntimePayload(): unknown;

  /** Patch a card's data (same semantics as PATCH /cards/:id). */
  patchCard(cardId: string, patch: Record<string, unknown>): void;

  /** Apply a card action (chat-send, action, file-upload). */
  applyCardAction(cardId: string, actionType: string, payload: Record<string, unknown> | null): void;

  /** Read chat records for a card. */
  readChatRecords(cardId: string): Array<Record<string, unknown>>;

  /** Clear chat records for a card. */
  clearChatRecords(cardId: string): void;

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

  const baseRef = parseRef(`::localstorage::${namespace}`);
  const cardStoreRef = serializeRef({ kind: 'localstorage', value: `${namespace}:card-store` });
  const outputsStoreRef = serializeRef({ kind: 'localstorage', value: `${namespace}:outputs` });

  // ── Card source adapter — serves the cards passed at creation time ───────

  const cardSource = {
    listCards: () => cards,
  };

  // ── Invocation adapter — routes to in-browser functions or HTTP ──────────

  const browserTaskExecutor = opts?.taskExecutor ?? null;
  const browserChatHandler = opts?.chatHandler ?? null;

  const taskExecutorWhatToRun = `::in-browser::${namespace}:task-executor`;
  const chatHandlerWhatToRun = `::in-browser::${namespace}:chat-handler`;

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

  const serverRuntime = createSingleBoardServerRuntime({
    boardId: namespace,
    boards: [{
      label: namespace,
      boardAdapter,
      baseRef,
      cardStoreRef,
      outputsStoreRef,
      cardSource,
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

    buildPublishedRuntimePayload() {
      return serverRuntime.buildPublishedRuntimePayload();
    },

    patchCard(cardId: string, patch: Record<string, unknown>) {
      const path = `${apiBase}/cards/${encodeURIComponent(cardId)}`;
      const req = makeSyntheticRequest('PATCH', path, patch);
      const { res } = makeSyntheticResponse();
      void serverRuntime.handleRuntimeApi(req, res, new URL(`http://localhost${path}`));
    },

    applyCardAction(cardId: string, actionType: string, payload: Record<string, unknown> | null) {
      const path = `${apiBase}/cards/${encodeURIComponent(cardId)}/actions`;
      const req = makeSyntheticRequest('POST', path, { actionType, payload });
      const { res } = makeSyntheticResponse();
      void serverRuntime.handleRuntimeApi(req, res, new URL(`http://localhost${path}`));
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

    get runtime() {
      return serverRuntime;
    },
  };
}
