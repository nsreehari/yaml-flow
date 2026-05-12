import { j as BlobStorage, C as CommandInput, e as CommandResult } from './board-live-cards-public-D8FcYB-W.cjs';

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

export { type ArtifactsStorePublic as A, createArtifactsStorePublic as a, createCardFileMetadataStore as b, createArtifactsStore as c, createChatArtifactsStore as d, createFileArtifactsStore as e };
