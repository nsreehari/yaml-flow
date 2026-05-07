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

import type { BoardPlatformAdapter, BoardLiveCardsPublic, CommandInput, CommandResult, BoardChangeNotification } from '../cli/common/board-live-cards-public.js';
import type { ExecutionRef } from '../cli/common/execution-interface.js';
import type { KindValueRef, KVStorage, BlobStorage } from '../cli/common/storage-interface.js';

// Re-export for convenience so hosts can import from server-runtime/types
export type { BoardPlatformAdapter, BoardLiveCardsPublic, CommandInput, CommandResult, BoardChangeNotification };
export type { ExecutionRef };
export type { KindValueRef, KVStorage, BlobStorage };

// ============================================================================
// CardSourceAdapter — enumerates card JSON files for bootstrap
// ============================================================================

export interface CardSourceAdapter {
  /**
   * List all card definitions from the card source.
   * Returns parsed card objects (each must have an `id: string` field).
   */
  listCards(): Array<Record<string, unknown>>;
}

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
}

// ============================================================================
// NotificationTransport — cross-process event channel
// ============================================================================

export interface NotificationTransport {
  /**
   * Start listening for events on the given channel.
   * onEvent is called with parsed JSON notification objects.
   * Returns a teardown function.
   */
  subscribe(channel: string, onEvent: (event: unknown) => void): Promise<() => void>;
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

// ============================================================================
// BoardContextConfig — per-board-context configuration (base or gandalf)
// ============================================================================

export interface BoardContextConfig {
  label: string;
  boardAdapter: BoardPlatformAdapter;
  baseRef: KindValueRef;
  cardStoreRef: string;
  outputsStoreRef: string;
  cardSource: CardSourceAdapter;
  taskExecutorRef?: ExecutionRef;
  chatHandlerRef?: ExecutionRef;
  inferenceAdapterRef?: ExecutionRef;
}

// ============================================================================
// SingleBoardRuntimeOptions — options for createSingleBoardServerRuntime
// ============================================================================

export interface SingleBoardRuntimeOptions {
  apiBasePath?: string;
  corsHeaders?: Record<string, string>;
  boardId?: string;

  base: BoardContextConfig;
  gandalf?: BoardContextConfig;

  invocationAdapter: InvocationAdapter;
  notificationTransport?: NotificationTransport;
  logger?: RuntimeLogger;
  serverUrl?: string;
  /** Extra host-specific fields baked into execution ref extras */
  executionExtra?: Record<string, unknown>;
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
  handleRuntimeApi(req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL): Promise<boolean>;
  buildPublishedRuntimePayload(): unknown;
  clearChatRecords(cardId: string): void;
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
