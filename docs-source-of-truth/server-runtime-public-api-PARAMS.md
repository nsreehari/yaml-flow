# server-runtime — Public API Reference

> Companion to [server-runtime-public-api-notifications.md](./server-runtime-public-api-notifications.md), which defines architecture/policy. This document is the signature reference.

The server runtime is **platform-free**: no `node:fs`, `node:net`, `node:http`, or `node:child_process` imports. All platform access flows through adapters supplied by the host (demo-server, Azure Function, Firebase Function, …).

Import surface:

```ts
import {
  createSingleBoardServerRuntime,
  createMultiBoardServerRuntime,
} from 'yaml-flow/server-runtime';

import type {
  SingleBoardRuntime,
  SingleBoardRuntimeOptions,
  MultiBoardRuntime,
  MultiBoardRuntimeOptions,
  BoardContextConfig,
  InvocationAdapter,
  ChatHandlerFlowRunner,
  NotificationTransport,
  DescribeEnvelope,
  RuntimeLogger,
  RuntimeRequest,
  RuntimeResponse,
} from 'yaml-flow/server-runtime';
```

---

## Factories

```ts
function createSingleBoardServerRuntime(options: SingleBoardRuntimeOptions): SingleBoardRuntime
function createMultiBoardServerRuntime(options: MultiBoardRuntimeOptions): MultiBoardRuntime
```

---

## `BoardContextConfig`

Per-board-layer configuration. A single board surface can be composed from multiple layers (e.g. base cards + admin cards), each with its own card store / outputs store / adapters.

```ts
interface BoardContextConfig {
  label: string;
  baseRef: KindValueRef;
  cardStoreRef: string;
  outputsStoreRef: string;

  boardAdapter:     BoardPlatformAdapter;
  nonCoreAdapter?:  BoardNonCorePlatformAdapter;
  artifactsAdapter?: BoardPlatformAdapter;   // defaults to boardAdapter
  artifactsStoreRef?: string;

  /**
   * Optional caller-supplied file artifacts store. When provided, used verbatim
   * (artifactsAdapter.blobStorage('files') is NOT consulted). Use this to take
   * full control of on-disk layout.
   */
  filesArtifactsStore?: ArtifactsStore;

  scratchStoreRef?: string;
  archiveStoreRef?: string;

  /** Notification endpoint ref — e.g. ::named-pipe::<path> or ::firestore-watch::<path> */
  notifyRef?: KindValueRef;

  taskExecutorRef?:     ExecutionRef;
  inferenceAdapterRef?: ExecutionRef;
  chatHandlerFlow?:     unknown;        // preferred — opaque flow descriptor
  chatHandlerRef?:      ExecutionRef;   // internal fallback only
}
```

---

## `SingleBoardRuntimeOptions`

```ts
interface SingleBoardRuntimeOptions {
  /** API mount path. Default: '/api/board' (no trailing slash). */
  apiBasePath?: string;

  /** Replaces the default CORS headers when provided. */
  corsHeaders?: Record<string, string>;

  /** Stable board identifier (logging / multi-board routing). */
  boardId?: string;

  /** One or more board layers. The first layer is the "primary" surface. */
  boards: BoardContextConfig[];

  /** Required — dispatches ExecutionRefs (chat handlers, optionally executors). */
  invocationAdapter: InvocationAdapter;

  /** Optional — runs stored chat-handler flows. Required if any board uses chatHandlerFlow. */
  chatFlowRunner?: ChatHandlerFlowRunner;

  /** Chat storage backend. Defaults to an in-memory store when omitted. */
  chatStorage?: ChatStorage;

  /** Cross-process notification source. When absent, board notifications are not received. */
  notificationTransport?: NotificationTransport;

  logger?:           RuntimeLogger;
  serverUrl?:        string;
  executionExtra?:   Record<string, unknown>;   // baked into ref.extra for invocations

  /** SSE lifecycle hooks for host accounting. */
  onSseClientConnected?:    (clientId: string, writer: (payload: unknown) => void) => void;
  onSseClientDisconnected?: (clientId: string) => void;
  onChannelSubscribed?:     (clientId: string, channelName: string, params: { cardId?: string }) => void;
  onChannelUnsubscribed?:   (clientId: string, channelName: string, params: { cardId?: string }) => void;
}
```

---

## `SingleBoardRuntime`

```ts
interface SingleBoardRuntime {
  readonly apiBasePath:  string;
  readonly corsHeaders:  Record<string, string>;

  /**
   * Route an inbound HTTP request to the runtime.
   * Returns true if the request matched a runtime route (and the response has been
   * written), false if the host should fall through to its own routing.
   */
  handleRuntimeApi(req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL): Promise<boolean>;

  /** Build the full SSE hydration payload (status, cards, data objects, etc.). */
  buildPublishedRuntimePayload(): unknown;

  /** Drop all chat records for a card. */
  clearChatRecords(cardId: string): void;

  /** Source-fetch callback bridge — token is the opaque source-callback token. */
  reportSourceFetched(token: string, ref: string): CommandResult;
  reportSourceFetchFailure(token: string, reason: string): CommandResult;

  /** Card-store handle for the primary board layer — seed cards with cardStore.set({ body: cards }). */
  readonly cardStore: {
    get(input: { params?: { id?: string } }): { status: string; data?: { cards?: Array<Record<string, unknown>> }; error?: string };
    set(input: { body: unknown }): { status: string; error?: string };
  };
}
```

---

## HTTP routes served by `handleRuntimeApi`

All paths are relative to `apiBasePath` (default `/api/board`). `:cardId`, `:token`, `:channel` denote URL segments. Bodies are JSON unless noted.

**Naming conventions on this surface:**
- URL path segments and query-string parameter names use `kebab-case` (e.g. `?tail-turns=1&turn-id=abc&all-turns=true&tail-turns-before-id=...`, `?inChat=true` is the one historical exception).
- JSON request and response bodies use `camelCase` field names (e.g. `cardId`, `tailTurns`).
- For MCP request bodies (`/mcp`, `/mcp-controlplane`, `/mcp-raw`) the `args` object uses `snake_case` instead — see [mcp-api-tools.md](./mcp-api-tools.md#naming-conventions).

| Method | Path | Purpose |
|-------:|------|---------|
| GET    | `/init-board` | One-time host trigger to (re)initialize the board contexts. |
| GET    | `/sse` | SSE stream — emits one hydration frame on connect, then notification-driven updates. |
| GET    | `/board-status` | Latest `BoardStatusObject` for the primary board layer. |
| POST   | `/mcp` | Routed MCP request (high-level wrapper, returns wrapper-shape JSON). |
| POST   | `/mcp-controlplane` | MCP control-plane request (admin / discovery). |
| POST   | `/mcp-raw` | Pass-through MCP request, returning the raw envelope. |
| POST   | `/callback/board-worker/:token/success` | Board-worker success callback (executor → runtime). |
| POST   | `/callback/board-worker/:token/failure` | Board-worker failure callback. |
| GET    | `/cards/:cardId` | Read one card by id. |
| PATCH  | `/cards/:cardId` | Patch a card field. Body `{ path, value }`. |
| POST   | `/cards/:cardId/retrigger` | Force re-evaluation of a card. |
| POST   | `/cards/:cardId/actions` | Invoke a card action. Body is action-specific. |
| GET    | `/cards/:cardId/chats` | List chat messages for a card. |
| POST   | `/cards/:cardId/chats` | Append a chat message (dispatches chat handler / flow). |
| POST   | `/cards/:cardId/chats/subscribe-sse` | Subscribe an SSE client to a card's chat stream. |
| POST   | `/cards/:cardId/chats/unsubscribe-sse` | Unsubscribe. |
| POST   | `/cards/:cardId/files` | Upload a file attachment (multipart or JSON). |
| GET    | `/cards/:cardId/files/:fileIdx` | Download attachment bytes. |
| POST   | `/watch-channel/:channel/(subscribe\|unsubscribe)-sse` | Board-level named-channel subscription. |
| POST   | `/cards/:cardId/watch-channel/:channel/(subscribe\|unsubscribe)-sse` | Card-scoped named-channel subscription. |

Host servers must mount only this router for board operations and must not bypass it (per [server-runtime-public-api-notifications.md](./server-runtime-public-api-notifications.md)).

---

## `MultiBoardRuntimeOptions` / `MultiBoardRuntime`

```ts
interface MultiBoardRuntimeOptions {
  apiBasePath?: string;          // default '/api/boards'
  corsHeaders?: Record<string, string>;

  /** Persisted registry of board entries (id → metadata). */
  serverMetaStore: { getText(key: string): string | null; putText(key: string, text: string): void };

  /** Build a single-board runtime on demand for the given board id. */
  boardRuntimeFactory: (boardId: string, entry: Record<string, unknown>) => SingleBoardRuntime;

  logger?: RuntimeLogger;
}

interface MultiBoardRuntime {
  readonly apiBasePath: string;
  readonly corsHeaders: Record<string, string>;
  /** Top-level router. Dispatches to GET/POST <apiBasePath> for registry ops, then
   *  delegates per-board paths to the matching SingleBoardRuntime.handleRuntimeApi. */
  handleApi(req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL): Promise<boolean>;
  requireBoardService(boardId: string): { service: SingleBoardRuntime };
}
```

---

## Adapter / helper contracts

### `InvocationAdapter`

```ts
interface InvocationAdapter {
  /** Fire-and-forget dispatch. Resolves once dispatched (not completed). */
  invoke(ref: ExecutionRef, args: Record<string, unknown>): Promise<{ dispatched: boolean; error?: string }>;

  /** Optional — synchronously describe an ExecutionRef target. */
  describe?(ref: ExecutionRef): Promise<DescribeEnvelope | null>;
}
```

### `ChatHandlerFlowRunner`

```ts
interface ChatHandlerFlowRunner {
  run(
    flow: unknown,
    args: Record<string, unknown>,
    context: {
      boardId: string;
      cardId: string;
      label: string;
      logger: RuntimeLogger;
      serverUrl?: string | null;
      executionExtra?: Record<string, unknown>;
    },
  ): Promise<{ dispatched: boolean; error?: string }>;
}
```

### `NotificationTransport`

```ts
interface NotificationTransport {
  /**
   * Start listening on a notification endpoint identified by a kind-ref.
   * The ref kind determines the transport mechanism:
   *   ::named-pipe::/tmp/board-x.sock
   *   ::firestore-watch::collections/board-x/notifications
   *   ::signalr::https://x.service.signalr.net/hub/board-x
   * Returns a teardown function.
   */
  subscribe(ref: KindValueRef, onEvent: (event: unknown) => void): Promise<() => void>;
}
```

### `DescribeEnvelope`

```ts
interface DescribeEnvelope {
  name: string;
  kind: 'task-executor' | 'chat-handler' | 'inference-adapter';
  protocolVersion: string;
  supports?: string[];
}
```

### `RuntimeLogger`

```ts
interface RuntimeLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}
```

### `RuntimeRequest` / `RuntimeResponse`

Minimal HTTP-shaped interfaces. Compatible with Node's `http.IncomingMessage` / `http.ServerResponse`, and easily adaptable for Azure/Firebase event objects.

```ts
interface RuntimeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer | Uint8Array>;
}

interface RuntimeResponse {
  writeHead(statusCode: number, headers?: Record<string, string | number>): void;
  write(data: string | Buffer): boolean;
  end(data?: string | Buffer): void;
}
```
