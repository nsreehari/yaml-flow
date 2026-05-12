import { C as CommandInput, a as CommandResult, b as BlobStorage, K as KindValueRef, c as BoardNonCorePlatformAdapter, B as BoardPlatformAdapter, I as InvocationAdapter } from '../types-CO2xUF1X.js';
export { d as BoardLiveCardsNonCorePublic, e as BoardLiveCardsPublic, D as DescribeEnvelope, f as createBoardLiveCardsNonCorePublic, g as createBoardLiveCardsPublic, p as parseRef, s as serializeRef } from '../types-CO2xUF1X.js';
export { E as ExecutionRef, e as executionRefFromScriptPath, p as parseExecutionRef, s as serializeExecutionRef } from '../execution-interface-87BHR8LJ.js';
import { C as CardAdminStore, L as LiveCard } from '../board-live-cards-lib-tjYsPt5U.js';
export { a as BOARD_GRAPH_KEY, E as EMPTY_CONFIG, S as SNAPSHOT_SCHEMA_VERSION_V1, c as createCardStore } from '../board-live-cards-lib-tjYsPt5U.js';

/**
 * card-store-lib-public.ts
 *
 * Platform-free public API for card store read/write operations.
 *
 * Follows the same CommandInput / CommandResult convention as
 * board-live-cards-public.ts.  No platform code here — inject a
 * CardAdminStore built from your platform adapter.
 *
 * Usage:
 *   import { createCardStorePublic } from './card-store-lib-public.js';
 *   import { createCardStore } from './board-live-cards-lib.js';
 *   import { createFsCardStorageAdapter } from '../node/storage-fs-adapters.js';
 *
 *   const store = createCardStorePublic(
 *     createCardStore(createFsCardStorageAdapter(dir))
 *   );
 *   const result = store.set({ body: card });         // write one card
 *   const result = store.set({ body: [c1, c2] });     // write many
 *   const result = store.get({ params: { id: 'x' } });
 *   const result = store.del({ body: { ids: ['x', 'y'] } });
 */

interface CardStorePublic {
    /** Read one card (params.id) or all cards. */
    get(input: CommandInput): CommandResult<{
        cards: LiveCard[];
    }>;
    /**
     * Write cards into the store.
     * body: single card object { id, ... } or an array of card objects.
     */
    set(input: CommandInput): CommandResult<{
        count: number;
    }>;
    /**
     * Delete cards by ID.
     * body.ids: string[]  — delete several cards at once
     * params.id: string   — delete a single card (alternative, can combine with body.ids)
     */
    del(input: CommandInput): CommandResult<{
        count: number;
    }>;
    /**
     * Patch one card using dot-path assignment.
     * params.id: string
     * params.path: dot path (e.g. "card_data.form.name")
     * body.value: value to assign (or body itself if value is omitted)
     */
    patch(input: CommandInput): CommandResult<{
        count: number;
    }>;
}
declare function createCardStorePublic(store: CardAdminStore): CardStorePublic;

/**
 * artifacts-store-lib.ts
 *
 * Backend-neutral artifact store built on BlobStorage.
 * Supports text + binary content, CRUD, listing, and lightweight metadata.
 */

interface ArtifactInfo {
    key: string;
    size?: number;
    updatedAt?: string;
    contentType?: string;
}
interface ArtifactsStore {
    exists(key: string): boolean;
    putText(key: string, content: string, contentType?: string): ArtifactInfo;
    putBytes(key: string, content: Uint8Array, contentType?: string): ArtifactInfo;
    getText(key: string): string | null;
    getBytes(key: string): Uint8Array | null;
    head(key: string): ArtifactInfo | null;
    list(prefix?: string): ArtifactInfo[];
    remove(key: string): void;
}
interface ChatIndexRecord {
    serial: number;
    role: string;
    stored_name: string;
    path: string;
    updated_at?: string | null;
}
interface ChatRecord extends ChatIndexRecord {
    text: string;
}
interface ChatSignal {
    count: number;
    latest_mtime_ms: number;
    processing: boolean;
}
interface ChatArtifactsStore {
    indexKey(cardPrefix: string): string;
    loadIndex(cardPrefix: string): ChatIndexRecord[];
    saveIndex(cardPrefix: string, records: ChatIndexRecord[]): void;
    nextSerial(cardPrefix: string): number;
    appendIndexRecord(cardPrefix: string, record: ChatIndexRecord): void;
    readRecords(cardPrefix: string): ChatRecord[];
    clear(cardPrefix: string): void;
    readSignal(cardPrefix: string): ChatSignal;
}
interface FileArtifactsStore {
    nextSerial(cardPrefix: string, seedNames?: string[]): number;
    buildStoredName(displayName: string, serial: number, opts?: {
        maxLen?: number;
    }): string;
    allocateStoredName(cardPrefix: string, displayName: string, opts?: {
        seedNames?: string[];
        maxLen?: number;
    }): string;
}
interface CardFileMetadata {
    name: string;
    stored_name: string;
    size: number | null;
    mime_type: string | null;
    path: string | null;
    uploaded_at: string | null;
}
type CardFileLookupResult = {
    ok: true;
    file: CardFileMetadata;
} | {
    ok: false;
    reason: 'index_out_of_range' | 'missing_stored_name' | 'stale_reference';
};
interface CardFileMetadataStore {
    read(cardData: unknown): CardFileMetadata[];
    normalizeIncoming(payloadFiles: unknown, defaultUploadedAt?: string): CardFileMetadata[];
    merge(cardData: Record<string, unknown>, incoming: CardFileMetadata[]): CardFileMetadata[];
    resolve(cardData: unknown, index: number, expectedStoredName?: string | null): CardFileLookupResult;
}
declare function createArtifactsStore(blob: BlobStorage): ArtifactsStore;
declare function createChatArtifactsStore(store: ArtifactsStore, opts?: {
    indexFileName?: string;
}): ChatArtifactsStore;
declare function createFileArtifactsStore(store: ArtifactsStore): FileArtifactsStore;
declare function createCardFileMetadataStore(): CardFileMetadataStore;

/**
 * artifacts-store-lib-public.ts
 *
 * Public API wrapper for ArtifactsStore, following CommandInput/CommandResult.
 */

interface ArtifactsStorePublic {
    list(input: CommandInput): CommandResult<{
        artifacts: ArtifactInfo[];
    }>;
    head(input: CommandInput): CommandResult<{
        artifact: ArtifactInfo | null;
    }>;
    put(input: CommandInput): CommandResult<{
        artifact: ArtifactInfo;
    }>;
    get(input: CommandInput): CommandResult<{
        key: string;
        contentType?: string;
        size?: number;
        text?: string;
        bytes?: number[];
    }>;
    del(input: CommandInput): CommandResult<{
        ok: true;
    }>;
}
declare function createArtifactsStorePublic(store: ArtifactsStore): ArtifactsStorePublic;

/**
 * fs-board-adapter.ts
 *
 * Wires Node.js / FS platform adapters into BoardPlatformAdapter and
 * BoardNonCorePlatformAdapter, and provides FS-specific board utility functions.
 *
 * Everything in the board-live-cards system that is platform-free lives in
 * src/cli/common/. All FS / Node.js / process concerns live here.
 *
 * Re-exports the full public API so consumers only need to import from this file.
 */

/**
 * Creates an InvocationAdapter backed by Node.js `spawn`/`spawnSync`.
 *
 * Supports howToRun: 'local-node'
 *   → spawns the script as a detached Node.js child process (fire-and-forget).
 *
 * Pass to createSingleBoardServerRuntime / createMultiBoardServerRuntime as
 * the `invocationAdapter` option. This is the reference Node.js implementation;
 * replace with your own for Azure Functions, Lambda, etc.
 */
declare function createNodeSpawnInvocationAdapter(): InvocationAdapter;
declare function createFsBoardPlatformAdapter(baseRef: KindValueRef, cliDir: string, opts?: {
    onWarn?: (msg: string) => void;
    suppressSpawn?: boolean;
    notifyChannel?: string;
}): BoardPlatformAdapter;
declare function createFsBoardNonCorePlatformAdapter(baseRef: KindValueRef, cliDir: string, opts?: {
    onWarn?: (msg: string) => void;
}): BoardNonCorePlatformAdapter;
/**
 * Extract the serialized board ref from a source token (which has a `br` field).
 * Returns null for callback tokens (which don't carry a board ref).
 */
declare function decodeBoardRefFromToken(token: string): string | null;

export { BoardNonCorePlatformAdapter, BoardPlatformAdapter, CommandInput, CommandResult, InvocationAdapter, KindValueRef, LiveCard, createArtifactsStore, createArtifactsStorePublic, createCardFileMetadataStore, createCardStorePublic, createChatArtifactsStore, createFileArtifactsStore, createFsBoardNonCorePlatformAdapter, createFsBoardPlatformAdapter, createNodeSpawnInvocationAdapter, decodeBoardRefFromToken };
