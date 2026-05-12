import { ExecutionRef } from './execution-refs.js';
import { f as GraphEvent, G as GraphConfig } from './types-BBhqYGhE.js';

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
/** Serialize a KindValueRef to the wire format: b64:<base64url(json)> */
declare function serializeRef(ref: KindValueRef): string;
/** Parse a wire-format ref string (b64:<base64url(json)>) into a KindValueRef. */
declare function parseRef(s: string): KindValueRef;
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
interface CardIndexEntry {
    /** Storage-specific address (file path, Cosmos doc id, localStorage key). */
    key: string;
    /** Checksum of card content — computed by the adapter at write time. */
    checksum: string;
    updatedAt: string;
}
type CardIndex = Record<string, CardIndexEntry>;
type CardChecksumIndex = Record<string, string>;
interface CardStorageAdapter {
    readIndex(): CardIndex | null;
    writeIndex(index: CardIndex): void;
    readCard(key: string): LiveCard | null;
    /** Write card content; returns checksum of what was written. */
    writeCard(key: string, card: LiveCard): string;
    cardExists(key: string): boolean;
    defaultCardKey(cardId: string): string;
}
interface CardStore {
    readCard(id: string): LiveCard | null;
    readCardKey(id: string): string | null;
    readAllCards(): LiveCard[];
    readChecksumIndex(): CardChecksumIndex;
    changedSince(snapshotChecksumIndex: CardChecksumIndex): string[];
}
interface CardUpsertValidation {
    ok: boolean;
    error?: string;
}
interface CardAdminStore extends CardStore {
    validateUpsert(id: string, cardKey: string): CardUpsertValidation;
    writeCard(id: string, card: LiveCard, cardKey?: string): void;
    patchCard(id: string, jsonPath: string, value: unknown): void;
    removeCard(id: string): void;
    readIndex(): CardIndex;
}
declare function createCardStore(adapter: CardStorageAdapter, onWarn?: (msg: string) => void): CardAdminStore;
interface JournalEntry {
    id: string;
    event: GraphEvent;
}
interface JournalStorageAdapter {
    readAllEntries(): JournalEntry[];
    appendEntry(entry: JournalEntry): void;
    generateId(): string;
}
declare const SNAPSHOT_SCHEMA_VERSION_V1 = "v1";
declare const BOARD_GRAPH_KEY = "board/graph";
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
declare const EMPTY_CONFIG: GraphConfig;

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
declare function createBoardLiveCardsPublic(baseRef: KindValueRef, adapter: BoardPlatformAdapter): BoardLiveCardsPublic;
interface BoardNonCorePlatformAdapter extends BoardPlatformAdapter {
    /**
     * Synchronously invoke a task executor subcommand and return stdout.
     * Throws on non-zero exit or timeout.
     */
    invokeExecutorSync(ref: ExecutionRef, subcommand: string, args: string[], opts?: {
        timeout?: number;
        input?: string;
    }): string;
    /** Schema-only card validator (no executor invocation). */
    validateSchema(card: Record<string, unknown>): {
        ok: boolean;
        errors: string[];
    };
    /** Create a temp file path for I/O staging — absolute, board-scoped. */
    makeTempFilePath(label: string, ext?: string): string;
    /** Absolute-path blob I/O for temp files and card file references. */
    absoluteBlob: BlobStorage;
}
interface BoardLiveCardsNonCorePublic {
    /** params: cardId? or all?; returns array even for single card */
    validateCard(input: CommandInput): CommandResult<Array<{
        cardId: string;
        isValid: boolean;
        issues: string[];
    }>>;
    /** body: { "card-content": <card> } — card JSON arrives via stdin; validates schema + JSONata + provides refs + source_defs (executor, if configured) */
    validateCardPreflight(input: CommandInput): CommandResult<{
        cardId: string;
        isValid: boolean;
        issues: string[];
    }>;
    /** params: cardId, sourceIdx, outRef?; body — mockProjections object */
    probeSource(input: CommandInput): CommandResult;
    /** body: { sourceDef, mockProjections }; params: outRef? */
    probeTmpSource(input: CommandInput): CommandResult;
    /** body: { "card-content": <card>, "mock-projections"?: {} }; params: sourceIdx, outRef? — card JSON arrives via stdin; no board state needed */
    probeSourcePreflight(input: CommandInput): CommandResult;
    /** body: { "card-content": <card>, "mock-fetched-sources"?: {}, "mock-requires"?: {} } — evaluates compute expressions with supplied data; no board state needed */
    evalCardCompute(input: CommandInput): CommandResult<{
        cardId: string;
        ok: boolean;
        computed_values: Record<string, unknown>;
        errors: Array<{
            bindTo: string;
            error: string;
        }>;
    }>;
    /** body: { "card-content": <card>, "mock-fetched-sources"?: {}, "mock-requires"?: {} } — full cycle: validate → resolve projections → probe sources → compute */
    simulateCardCycle(input: CommandInput): CommandResult;
    /** no params needed */
    describeTaskExecutorCapabilities(input: CommandInput): CommandResult;
    /**
     * Write/update cards in the configured card store.
     * body: { ops: Array<{ op: 'update', id: string, 'card-content': LiveCard }> }
     */
    updatesInCardStore(input: CommandInput): CommandResult;
    /**
     * Read cards from the configured card store by id.
     * body: { ids: string[] }
     */
    readFromCardStore(input: CommandInput): CommandResult<{
        cards: Array<{
            id: string;
            'card-content': LiveCard | null;
        }>;
    }>;
}
declare function createBoardLiveCardsNonCorePublic(baseRef: KindValueRef, adapter: BoardNonCorePlatformAdapter): BoardLiveCardsNonCorePublic;

export { type BoardNonCorePlatformAdapter as B, type CommandInput as C, EMPTY_CONFIG as E, type KindValueRef as K, type LiveCard as L, SNAPSHOT_SCHEMA_VERSION_V1 as S, type BoardPlatformAdapter as a, BOARD_GRAPH_KEY as b, type BoardLiveCardsNonCorePublic as c, type BoardLiveCardsPublic as d, type CommandResult as e, createBoardLiveCardsNonCorePublic as f, createBoardLiveCardsPublic as g, createCardStore as h, type CardAdminStore as i, type BlobStorage as j, type BoardChangeNotification as k, type KVStorage as l, parseRef as p, serializeRef as s };
