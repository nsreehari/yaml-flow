import { C as CommandInput, a as CommandResult } from './board-live-cards-public-DHrcpTPv.cjs';
import './execution-refs.cjs';
import './types-BBhqYGhE.cjs';

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

export { type ArtifactsStorePublic, createArtifactsStorePublic };
