/**
 * server-runtime/types.ts
 *
 * Platform-free adapter interfaces for the board server runtime.
 *
 * The runtime (index.ts) imports ONLY this file and board-live-cards-public
 * for its dependencies — no node:fs, node:net, node:child_process, etc.
 *
 * Hosts (demo-server, Azure Function, Firebase Function) provide implementations
 * of these interfaces when constructing the runtime.
 */

import type { BoardPlatformAdapter, BoardNonCorePlatformAdapter, BoardLiveCardsPublic, BoardLiveCardsNonCorePublic, CommandInput, CommandResult, BoardChangeNotification } from '../cli/common/board-live-cards-public.js';
import type { BoardWorkerRequest } from '../cli/common/board-worker-store.js';
import type { AsyncBoardPlatformAdapter } from '../cli/cloud/board-platform-adapter-async.js';
import type { AsyncBoardLiveCardsPublic } from '../cli/cloud/board-live-cards-public-async.js';
import type { ExecutionRef } from '../cli/common/execution-interface.js';
import type { KindValueRef, KVStorage, BlobStorage } from '../cli/common/storage-interface.js';
import type { ChatStorage } from '../cli/common/chat-storage-lib.js';

// Re-export for convenience so hosts can import from server-runtime/types
export type { BoardPlatformAdapter, BoardNonCorePlatformAdapter, BoardLiveCardsPublic, CommandInput, CommandResult, BoardChangeNotification };
export type { BoardWorkerRequest };
export type { AsyncBoardPlatformAdapter, AsyncBoardLiveCardsPublic };
export type { ExecutionRef };
export type { KindValueRef, KVStorage, BlobStorage };
export type { ChatStorage };
export type BoardRuntimeNonCorePublic = Pick<BoardLiveCardsNonCorePublic,
  'describeTaskExecutorCapabilities'
  | 'validateCardPreflight'
  | 'evalCardCompute'
  | 'probeSourcePreflight'
  | 'runSourcePreflight'
  | 'simulateCardCycle'>;

export type Awaitable<T> = T | Promise<T>;
export type BoardRuntimePlatformAdapter = BoardPlatformAdapter | AsyncBoardPlatformAdapter;
export type BoardRuntimePublic = BoardLiveCardsPublic | AsyncBoardLiveCardsPublic;

// ============================================================================
// InvocationAdapter — dispatches execution requests
// ============================================================================

export interface InvocationAdapter {
  /**
   * Fire-and-forget invocation of an ExecutionRef with args.
   * Used for chat-handler dispatch, and potentially task-executor / inference-adapter.
   * Returns a promise that resolves when the invocation is dispatched (not completed).
   */
  invoke(ref: ExecutionRef, args: Record<string, unknown>): Promise<{ dispatched: boolean; error?: string }>;

  /**
   * Optional synchronous describe call — asks the target to identify itself.
   * Used for pre-init validation (e.g. confirming a chat-handler reports kind='chat-handler').
   * Hosts that pre-register capabilities at deploy time may omit this.
   */
  describe?(ref: ExecutionRef): Promise<DescribeEnvelope | null>;
}

export interface ChatHandlerFlowRunner {
  /**
   * Execute a stored chat-handler flow using host-defined step-machine bindings.
   * The runtime stays platform-free and delegates actual execution to the host.
   */
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

// ============================================================================
// NotificationTransport — cross-process event channel
// ============================================================================

export interface NotificationTransport {
  /**
   * Start listening for events on a notification endpoint identified by a kind-ref.
   * The ref kind determines the transport mechanism:
   *   ::named-pipe::/tmp/board-x.sock
   *   ::firestore-watch::collections/board-x/notifications
   *   ::signalr::https://x.service.signalr.net/hub/board-x
   * onEvent is called with parsed JSON notification objects.
   * Returns a teardown function.
   */
  subscribe(ref: KindValueRef, onEvent: (event: unknown) => void): Promise<() => void>;
}

// ============================================================================
// DescribeEnvelope — returned by executors in response to 'describe'
// ============================================================================

export interface DescribeEnvelope {
  name: string;
  kind: 'task-executor' | 'chat-handler' | 'inference-adapter';
  protocolVersion: string;
  supports?: string[];
}

// ============================================================================
// Logger — minimal structured logging interface
// ============================================================================

export interface RuntimeLogger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export interface QueueLaneRuntimeTuning {
  pollIntervalMs?: number;
  visibilityMs?: number;
  concurrency?: number;
  maxAttempts?: number;
}

export interface HostedBoardQueueLaneTuning {
  processAccumulated?: QueueLaneRuntimeTuning;
  chatAgent?: QueueLaneRuntimeTuning;
  taskExecutor?: QueueLaneRuntimeTuning;
}

// ============================================================================
// BoardContextConfig — per-board-layer configuration
// ============================================================================

export interface BoardContextConfig {
  label: string;
  boardAdapter: BoardRuntimePlatformAdapter;
  nonCore?: BoardRuntimeNonCorePublic;
  nonCoreAdapter?: BoardNonCorePlatformAdapter;
  boardRuntimeStoreRef: string;
  /** Explicit ref for externally backed runtime storage (journal + internal queue lanes). */
  queueStoreRef: string;
  /** Explicit blob root ref for persisted card/file attachments. */
  artifactsStoreRef: string;
  /** Explicit ref for fetched source payloads. */
  fetchedSourcesStoreRef: string;
  baseRef: KindValueRef;
  cardStoreRef: string;
  outputsStoreRef: string;
  /** Explicit ref pointing persisted card chat storage at a different backend. */
  chatStoreRef: string;
  /** Explicit ref pointing scratch storage at a different backend than the board runtime. */
  scratchStoreRef: string;
  /** Notification endpoint ref — e.g. ::named-pipe::<path> or ::firestore-watch::<path> */
  notifyRef?: KindValueRef;
  taskExecutorRef?: ExecutionRef;
  /** Internal fallback only; public board config now uses chatHandlerFlow. */
  chatHandlerRef?: ExecutionRef;
  chatHandlerFlow?: unknown;
  inferenceAdapterRef?: ExecutionRef;
}

// ============================================================================
// SingleBoardRuntimeOptions — options for createSingleBoardServerRuntime
// ============================================================================

export interface SingleBoardRuntimeOptions {
  apiBasePath?: string;
  corsHeaders?: Record<string, string>;
  boardId?: string;

  /** One or more board layers composing this board surface (e.g. base cards + admin cards). */
  boards: BoardContextConfig[];

  invocationAdapter: InvocationAdapter;
  chatFlowRunner?: ChatHandlerFlowRunner;
  notificationTransport?: NotificationTransport;
  logger?: RuntimeLogger;
  serverUrl?: string;
  queueLaneTuning?: HostedBoardQueueLaneTuning;
  /** Extra host-specific fields baked into execution ref extras */
  executionExtra?: Record<string, unknown>;
  /** Called when an SSE client connects. The writer injects a single SSE data frame. */
  onSseClientConnected?: (clientId: string, writer: (payload: unknown) => void) => void;
  /** Called when an SSE client disconnects due to close, reconnect replacement, or write error. */
  onSseClientDisconnected?: (clientId: string) => void;
  /** Called when a connected SSE client subscribes to a host-defined named channel. */
  onChannelSubscribed?: (clientId: string, channelName: string, params: { cardId?: string }) => void;
  /** Called when a connected SSE client unsubscribes from a host-defined named channel. */
  onChannelUnsubscribed?: (clientId: string, channelName: string, params: { cardId?: string }) => void;
}

// ============================================================================
// MultiBoardRuntimeOptions — options for createMultiBoardServerRuntime
// ============================================================================

export interface MultiBoardRuntimeOptions {
  apiBasePath?: string;
  corsHeaders?: Record<string, string>;

  /** Artifacts store for multi-board registry metadata */
  serverMetaStore: { getText(key: string): string | null; putText(key: string, text: string): void };

  /** Factory that creates a single-board runtime for a given board config */
  boardRuntimeFactory: (boardId: string, entry: Record<string, unknown>) => SingleBoardRuntime;

  logger?: RuntimeLogger;
}

// ============================================================================
// SingleBoardRuntime — returned by createSingleBoardServerRuntime
// ============================================================================

export interface SingleBoardRuntime {
  readonly apiBasePath: string;
  readonly corsHeaders: Record<string, string>;
  readonly queueLaneTuning: HostedBoardQueueLaneTuning;
  handleRuntimeApi(req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL): Promise<boolean>;
  buildPublishedRuntimePayload(): Awaitable<unknown>;
  handleChatAgentRequest(request: BoardWorkerRequest): Awaitable<void>;
  clearChatRecords(cardId: string): Awaitable<void>;
  /** Report that a source fetch completed. Token is the source callback token; ref is the blob ref (b64:<base64url(json)>). */
  reportSourceFetched(token: string, ref: string): Awaitable<CommandResult>;
  /** Report that a source fetch failed. Token is the source callback token. */
  reportSourceFetchFailure(token: string, reason: string): Awaitable<CommandResult>;
  /** Exposed card store — host calls cardStore.set({body: cards}) to seed definitions. */
  readonly cardStore: {
    get(input: { params?: { id?: string } }): Awaitable<{ status: string; data?: { cards?: Array<Record<string, unknown>> }; error?: string }>;
    set(input: { body: unknown }): Awaitable<{ status: string; data?: { count?: number }; error?: string }>;
  };
}

// ============================================================================
// MultiBoardRuntime — returned by createMultiBoardServerRuntime
// ============================================================================

export interface MultiBoardRuntime {
  readonly apiBasePath: string;
  readonly corsHeaders: Record<string, string>;
  handleApi(req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL): Promise<boolean>;
  requireBoardService(boardId: string): { service: SingleBoardRuntime };
}

// ============================================================================
// RuntimeRequest / RuntimeResponse — minimal HTTP-shaped interfaces
//
// These match Node's http.IncomingMessage / http.ServerResponse shapes
// but are interface-only so Azure/Firebase can adapt their event objects.
// ============================================================================

export interface RuntimeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (...args: unknown[]) => void): void;
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer | Uint8Array>;
}

export interface RuntimeResponse {
  writeHead(statusCode: number, headers?: Record<string, string | number>): void;
  write(data: string | Buffer): boolean;
  end(data?: string | Buffer): void;
}
