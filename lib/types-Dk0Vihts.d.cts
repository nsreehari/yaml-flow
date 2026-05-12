import { a as BoardPlatformAdapter, K as KindValueRef, e as CommandResult } from './board-live-cards-public-CdEgQEoa.cjs';
import { ExecutionRef } from './execution-refs.cjs';

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

interface InvocationAdapter {
    /**
     * Fire-and-forget invocation of an ExecutionRef with args.
     * Used for chat-handler dispatch, and potentially task-executor / inference-adapter.
     * Returns a promise that resolves when the invocation is dispatched (not completed).
     */
    invoke(ref: ExecutionRef, args: Record<string, unknown>): Promise<{
        dispatched: boolean;
        error?: string;
    }>;
    /**
     * Optional synchronous describe call — asks the target to identify itself.
     * Used for pre-init validation (e.g. confirming a chat-handler reports kind='chat-handler').
     * Hosts that pre-register capabilities at deploy time may omit this.
     */
    describe?(ref: ExecutionRef): Promise<DescribeEnvelope | null>;
}
interface NotificationTransport {
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
interface DescribeEnvelope {
    name: string;
    kind: 'task-executor' | 'chat-handler' | 'inference-adapter';
    protocolVersion: string;
    supports?: string[];
}
interface RuntimeLogger {
    info(msg: string, ...args: unknown[]): void;
    warn(msg: string, ...args: unknown[]): void;
    error(msg: string, ...args: unknown[]): void;
}
interface BoardContextConfig {
    label: string;
    boardAdapter: BoardPlatformAdapter;
    /** Optional separate adapter for file/chat blob storage (defaults to boardAdapter) */
    artifactsAdapter?: BoardPlatformAdapter;
    baseRef: KindValueRef;
    cardStoreRef: string;
    outputsStoreRef: string;
    /** Notification endpoint ref — e.g. ::named-pipe::<path> or ::firestore-watch::<path> */
    notifyRef?: KindValueRef;
    taskExecutorRef?: ExecutionRef;
    chatHandlerRef?: ExecutionRef;
    inferenceAdapterRef?: ExecutionRef;
}
interface SingleBoardRuntimeOptions {
    apiBasePath?: string;
    corsHeaders?: Record<string, string>;
    boardId?: string;
    /** One or more board layers composing this board surface (e.g. base cards + admin cards). */
    boards: BoardContextConfig[];
    invocationAdapter: InvocationAdapter;
    notificationTransport?: NotificationTransport;
    logger?: RuntimeLogger;
    serverUrl?: string;
    /** Extra host-specific fields baked into execution ref extras */
    executionExtra?: Record<string, unknown>;
}
interface MultiBoardRuntimeOptions {
    apiBasePath?: string;
    corsHeaders?: Record<string, string>;
    /** Artifacts store for multi-board registry metadata */
    serverMetaStore: {
        getText(key: string): string | null;
        putText(key: string, text: string): void;
    };
    /** Factory that creates a single-board runtime for a given board config */
    boardRuntimeFactory: (boardId: string, entry: Record<string, unknown>) => SingleBoardRuntime;
    logger?: RuntimeLogger;
}
interface SingleBoardRuntime {
    readonly apiBasePath: string;
    readonly corsHeaders: Record<string, string>;
    handleRuntimeApi(req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL): Promise<boolean>;
    buildPublishedRuntimePayload(): unknown;
    clearChatRecords(cardId: string): void;
    /** Report that a source fetch completed. Token is the source callback token; ref is the blob ref (b64:<base64url(json)>). */
    reportSourceFetched(token: string, ref: string): CommandResult;
    /** Report that a source fetch failed. Token is the source callback token. */
    reportSourceFetchFailure(token: string, reason: string): CommandResult;
    /** Exposed card store — host calls cardStore.set({body: cards}) to seed definitions. */
    readonly cardStore: {
        get(input: {
            params?: {
                id?: string;
            };
        }): {
            status: string;
            data?: {
                cards?: Array<Record<string, unknown>>;
            };
            error?: string;
        };
        set(input: {
            body: unknown;
        }): {
            status: string;
            error?: string;
        };
    };
}
interface MultiBoardRuntime {
    readonly apiBasePath: string;
    readonly corsHeaders: Record<string, string>;
    handleApi(req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL): Promise<boolean>;
    requireBoardService(boardId: string): {
        service: SingleBoardRuntime;
    };
}
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

export type { BoardContextConfig as B, DescribeEnvelope as D, InvocationAdapter as I, MultiBoardRuntimeOptions as M, NotificationTransport as N, RuntimeLogger as R, SingleBoardRuntimeOptions as S, MultiBoardRuntime as a, SingleBoardRuntime as b, RuntimeRequest as c, RuntimeResponse as d };
