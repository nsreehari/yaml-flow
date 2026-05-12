import { ExecutionRef } from '../execution-refs.cjs';
import { f as GraphEvent } from '../types-BBhqYGhE.cjs';

/**
 * storage-interface.ts
 *
 * Three minimal storage primitives that together cover all persistence needs
 * of the board-live-cards system. Any backend (Node fs, CosmosDB, Azure Blob,
 * browser localStorage, in-memory test double) implements these three interfaces.
 *
 * The pure-logic stores in board-live-cards-all-stores.ts depend only on these
 * interfaces — never on Node built-ins.
 *
 *  Blob    — raw string content at a logical, backend-neutral key
 *  Journal — append-only log with cursor-based reads
 *  KV      — key-value store with list/delete
 *
 * Mapping to existing storage adapters:
 *
 *   CardStorageAdapter
 *     inventory (cardId → { blobRef, checksum, fileMetadata? })  → KV
 *     card JSON files                                             → Blob
 *     source output files                                         → Blob
 *
 *   JournalStorageAdapter     → Journal (board-journal.jsonl)
 *
 *   ExecutionRequestStore → KV (keyed by journalId, via createFsKvStorage)
 *
 *   StateSnapshotStorageAdapter
 *     board-graph.json (packed single JSON, written atomically)   → Blob
 *     per-card sidecars (cards/<id>/runtime, fetched-sources-manifest) → KV
 */
interface BlobStat {
    key: string;
    size: number;
    updatedAt?: string;
    contentType?: string;
}
interface BlobStorage {
    /** Returns raw content string, or null if the blob does not exist. */
    read(key: string): string | null;
    /** Write content at key. Implementations should be atomic (write-rename). */
    write(key: string, content: string): void;
    /** Returns true if a blob exists at key. */
    exists(key: string): boolean;
    /** Delete the blob at key. No-op if it does not exist. */
    remove(key: string): void;
    /** Optional binary read for file-like artifacts. */
    readBytes?(key: string): Uint8Array | null;
    /** Optional binary write for file-like artifacts. */
    writeBytes?(key: string, content: Uint8Array): void;
    /** Optional key listing by prefix. */
    listKeys?(prefix?: string): string[];
    /** Optional metadata lookup. */
    stat?(key: string): BlobStat | null;
}
interface KindValueRef {
    readonly kind: string;
    readonly value: string;
}
interface KVStorage {
    /** Returns the stored value, or null if the key does not exist. */
    read(key: string): unknown | null;
    /** Write value at key. Overwrites any existing value. */
    write(key: string, value: unknown): void;
    /** Delete the key. No-op if it does not exist. */
    delete(key: string): void;
    /**
     * List all keys, optionally filtered to those starting with prefix.
     * Order is implementation-defined.
     */
    listKeys(prefix?: string): string[];
}
interface AtomicRelayLock {
    /**
     * Attempt to acquire the lock without blocking.
     * Returns a `release` function if successful, or `null` if the lock is
     * already held by another actor (relay: that actor will complete the work).
     */
    tryAcquire(): (() => void) | null;
}

/**
 * board-live-cards-lib — Pure logic library for the board-live-cards CLI.
 *
 * Merged from:
 *   board-live-cards-all-stores.ts
 *   board-live-cards-lib-types.ts
 *   board-live-cards-lib-board-status.ts
 *   board-live-cards-lib-card-handler.ts
 *   board-live-cards-cli-board-commands.ts
 *   board-live-cards-cli-card-commands.ts
 *   board-live-cards-cli-callbacks.ts
 *
 * Zero platform imports. All storage is injected via adapter interfaces.
 * Safe for Node, browser, and neutral (V8/PyMiniRacer) bundles.
 */

interface LiveCard {
    id: string;
    [key: string]: unknown;
}
interface JournalEntry {
    id: string;
    event: GraphEvent;
}
interface JournalStorageAdapter {
    readAllEntries(): JournalEntry[];
    appendEntry(entry: JournalEntry): void;
    generateId(): string;
}
type OutputStoreEvent = {
    kind: 'computed_values';
    cardId: string;
    values: Record<string, unknown>;
} | {
    kind: 'data_object';
    key: string;
    payload: unknown;
} | {
    kind: 'status';
    status: unknown;
};
interface BoardStatusCard {
    name: string;
    status: string;
    error?: {
        message: string;
        code?: string;
        at?: string;
        source?: 'task-runtime' | 'source-fetch' | 'timeout' | 'unknown';
    };
    requires: string[];
    requires_satisfied: string[];
    requires_missing: string[];
    provides_declared: string[];
    provides_runtime: string[];
    blocked_by: string[];
    unblocks: string[];
    runtime: {
        attempt_count: number;
        restart_count: number;
        in_progress_since: string | null;
        last_transition_at: string | null;
        last_completed_at: string | null;
        last_restarted_at: string | null;
        status_age_ms: number | null;
    };
}
interface BoardStatusObject {
    schema_version: 'v1';
    meta: {
        board: {
            path: string;
        };
    };
    summary: {
        card_count: number;
        completed: number;
        eligible: number;
        pending: number;
        blocked: number;
        unresolved: number;
        failed?: number;
        in_progress?: number;
        orphan_cards?: number;
        topology?: {
            edge_count: number;
            max_fan_out_card: string | null;
            max_fan_out: number;
        };
    };
    cards: BoardStatusCard[];
}

/**
 * board-live-cards-public.ts
 *
 * Platform-free public API layer for the board-live-cards system.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * LAYER DIAGRAM
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   board-live-cards-cli.ts       (THIN — arg parse → call public → print JSON)
 *           ↓ calls
 *   board-live-cards-public.ts    (THIS FILE — facade, all logic, no platform code)
 *           ↓ depends on injected
 *   board-live-cards-lib.ts       (pure domain — stores, graph, codecs)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PLATFORM ADAPTERS  (injected into BoardPlatformAdapter)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   Node/FS         createFsBoardPlatformAdapter(baseRef, cliDir)
 *   Azure Functions createAzureBoardPlatformAdapter(baseRef, containerClient, …)
 *   Firebase Fn     createFirebaseBoardPlatformAdapter(baseRef, firestoreDb, …)
 *   In-memory/test  createInMemoryBoardPlatformAdapter(baseRef)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * USAGE
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   const board = createBoardLiveCardsPublic(baseRef, adapter);
 *   const result = await board.processAccumulatedEvents();
 *   const status = board.status();
 */

type CommandInput = {
    params?: Record<string, string | number | boolean>;
    body?: unknown;
};
type CommandResult<T = undefined> = (T extends undefined ? {
    status: 'success';
} : {
    status: 'success';
    data: T;
}) | {
    status: 'fail';
    error: string;
} | {
    status: 'error';
    error: string;
};
interface BoardPlatformAdapter {
    /**
     * KV storage factory — scoped by namespace.
     * Namespaces used by the public layer:
     *   'state-snapshot'     — board graph snapshot (StateSnapshotStorageAdapter, built internally)
     *   'config'             — board configuration (.task-executor, .chat-handler, .card-store-ref)
     *   'card-upsert'        — card upsert dedup index
     *   'execution-requests' — queued execution requests (keyed by journalId)
     *   'card-runtime'       — card runtime state snapshots
     *   'output'             — published board status + card computed outputs
     */
    kvStorage(namespace: string): KVStorage;
    /**
     * Build a KVStorage rooted at the given ref.
     * Used by the public layer for both card store and outputs store routing.
     *   FS:          createFsKvStorage(parseRef(ref).value)
     *   localStorage: createLocalStorageKvStorage(parseRef(ref).value)
     */
    kvStorageForRef(ref: string): KVStorage;
    /**
     * Blob storage factory — scoped by namespace.
     * Namespaces used by the public layer:
     *   'sources' — fetched source data files (keyed by cardId/outputFile)
     *   ''        — root-scoped blob access (for resolving arbitrary KindValueRef blobs)
     */
    blobStorage(namespace: string): BlobStorage;
    /**
     * Journal storage adapter (append-only log).
     * Uses the lib's JournalStorageAdapter interface.
     * One journal per board — no namespace parameter needed.
     */
    journalAdapter(): JournalStorageAdapter;
    /**
     * AtomicRelayLock — non-blocking try-acquire with relay-on-busy semantics.
     * Guards processAccumulatedEvents drain cycle.
     *   FS:        proper-lockfile (createFsAtomicRelayLock)
     *   Azure:     blob lease
     *   Firestore: Firestore transaction + sentinel document
     */
    lock: AtomicRelayLock;
    /**
     * Self-identity ExecutionRef — how to invoke THIS board instance.
     * Embedded in source callback tokens so executors know where to report back.
    *   Node/FS:  { howToRun: 'local-node', whatToRun: 'b64:<base64url({"kind":"fs-path","value":"/path/to/cli.js"})>' }
    *   Azure Fn: { howToRun: 'http:post',  whatToRun: 'b64:<base64url({"kind":"http-url","value":"https://…/api/board"})>' }
     */
    selfRef: ExecutionRef;
    /**
     * Generic execution dispatch — platform adapts ExecutionRef → actual transport.
     * Public layer constructs fully-formed semantic args (source def, base_ref,
     * callback token with selfRef baked in). Platform handles transport:
     *   Node: writes args to temp file, spawns detached process
     *   Azure: HTTP POST args as JSON body
     *   Firebase: publishes args as pubsub message
     */
    dispatchExecution(ref: ExecutionRef, args: Record<string, unknown>): Promise<{
        dispatched: boolean;
        error?: string;
    }>;
    /**
     * Resolve a blob ref to its string contents.
     * The adapter handles the platform-specific lookup (e.g. absolute FS path vs board-relative key).
     * Throws if the blob does not exist.
     */
    resolveBlob(ref: KindValueRef): string;
    /**
     * Compute a stable, deterministic content hash for any JSON-serializable value.
     * Used for dedup indexes and snapshot versioning.
     *   Node/FS: computeStableJsonHash (storage-fs-adapters)
     *   Browser: Web Crypto subtle.digest or equivalent
     */
    hashFn(value: unknown): string;
    /**
     * Generate a random short ID (32 hex chars).
     * Used for commit IDs and delivery tokens.
     *   Node/FS: getHash(`${Date.now()}-${Math.random()}`).slice(0, 32)
     *   Browser: crypto.randomUUID().replace(/-/g, '')
     */
    genId(): string;
    /**
     * Request an additional drain pass asynchronously (e.g. spawn a background process).
     * Called as the relay continuation after each drain cycle so that events written
     * during the cycle (e.g. task-completed appended by the card handler) are eventually
     * processed even when the current process exits immediately after returning.
     * Optional — if absent, no continuation is scheduled.
     */
    requestProcessAccumulated?(): void;
    /**
     * Optional cross-process board change notification publisher (named pipe, webhook, pubsub, etc.).
     * Called once per drain cycle with the complete batch of notifications produced in that cycle.
     */
    publishBoardChangeNotifications?(notifications: BoardChangeNotification[]): void | Promise<void>;
    /** Optional warn sink — defaults to no-op. */
    onWarn?(msg: string): void;
}
interface BoardLiveCardsPublic {
    init(input: CommandInput): CommandResult;
    status(input: CommandInput): CommandResult<BoardStatusObject>;
    getCardStoreRef(input: CommandInput): CommandResult<{
        storeRef: string;
    }>;
    getOutputsStoreRef(input: CommandInput): CommandResult<{
        storeRef: string;
    }>;
    getConfig(input: CommandInput): CommandResult<{
        value: unknown;
    }>;
    getOutputsDataObject(input: CommandInput): CommandResult;
    getAllOutputsDataObjects(input: CommandInput): CommandResult<Record<string, unknown>>;
    getOutputsComputedValues(input: CommandInput): CommandResult;
    getAllOutputsComputedValues(input: CommandInput): CommandResult<Record<string, unknown>>;
    removeCard(input: CommandInput): CommandResult;
    retrigger(input: CommandInput): CommandResult;
    processAccumulatedEvents(input: CommandInput): Promise<CommandResult>;
    upsertCard(input: CommandInput): CommandResult;
    taskFailed(input: CommandInput): CommandResult;
    taskProgress(input: CommandInput): CommandResult;
    sourceDataFetched(input: CommandInput): CommandResult;
    sourceDataFetchFailure(input: CommandInput): CommandResult;
}
type BoardChangeNotification = OutputStoreEvent | {
    kind: 'card_refreshed';
    cardId: string;
    card: LiveCard;
};

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

declare function createSingleBoardServerRuntime(options: SingleBoardRuntimeOptions): SingleBoardRuntime;
declare function createMultiBoardServerRuntime(options: MultiBoardRuntimeOptions): MultiBoardRuntime;

export { type BlobStorage, type BoardChangeNotification, type BoardContextConfig, type BoardLiveCardsPublic, type BoardPlatformAdapter, type CommandInput, type CommandResult, type DescribeEnvelope, ExecutionRef, type InvocationAdapter, type KVStorage, type KindValueRef, type MultiBoardRuntime, type MultiBoardRuntimeOptions, type NotificationTransport, type RuntimeLogger, type RuntimeRequest, type RuntimeResponse, type SingleBoardRuntime, type SingleBoardRuntimeOptions, createMultiBoardServerRuntime, createSingleBoardServerRuntime };
