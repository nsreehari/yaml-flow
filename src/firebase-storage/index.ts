/**
 * firebase-storage — browser-safe Firebase Storage (Google Cloud Storage) blob
 * primitives + a helper that swaps any existing `AsyncBoardPlatformAdapter`'s
 * blob/scratch namespaces over to Firebase Storage.
 *
 * This module never imports firebase. The host application initializes
 * `firebase.app()` and passes the resulting `firebase.storage()` handle in.
 * That keeps Firebase SDK init (project-specific, host-app concern) out of
 * yaml-flow while letting any consumer reuse the same Storage adapter wiring.
 */

import type { KindValueRef } from '../cli/common/storage-interface.js';
import type {
  AsyncBlobStorage,
  AsyncScratchStorage,
} from '../cli/cloud/storage-async-interface.js';

// ── Minimal structural interfaces for the Firebase Storage compat handle ──────
// These match the Firebase Web SDK v8/compat surface (`firebase.storage()`),
// which is what most browser hosts use today.

export interface FirebaseStorageMetadataLike {
  readonly size?: number | string;
  readonly updated?: string;
  readonly contentType?: string;
}

export interface FirebaseStorageListResultLike {
  readonly items: FirebaseStorageReferenceLike[];
  readonly prefixes: FirebaseStorageReferenceLike[];
}

export interface FirebaseStorageReferenceLike {
  readonly fullPath: string;
  readonly name: string;
  child(path: string): FirebaseStorageReferenceLike;
  getDownloadURL(): Promise<string>;
  getMetadata(): Promise<FirebaseStorageMetadataLike>;
  delete(): Promise<void>;
  listAll(): Promise<FirebaseStorageListResultLike>;
  putString(
    data: string,
    format?: 'raw' | 'base64' | 'base64url' | 'data_url',
    metadata?: { contentType?: string },
  ): Promise<unknown>;
  put(
    data: ArrayBuffer | Uint8Array | Blob,
    metadata?: { contentType?: string },
  ): Promise<unknown>;
}

export interface FirebaseStorageLike {
  ref(path?: string): FirebaseStorageReferenceLike;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

const encoder = new TextEncoder();

function encodeStorageKeySegment(key: string): string {
  let binary = '';
  for (const byte of encoder.encode(String(key))) {
    binary += String.fromCharCode(byte);
  }
  // base64url
  const base64 = (typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64'));
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeStorageKeySegment(encoded: string): string {
  const base64 = String(encoded).replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (String(encoded).length % 4)) % 4);
  const binary = typeof atob === 'function'
    ? atob(base64)
    : Buffer.from(base64, 'base64').toString('binary');
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder().decode(bytes);
}

function joinStoragePath(...segments: Array<string | undefined | null>): string {
  return segments
    .map((segment) => String(segment ?? '').trim())
    .filter(Boolean)
    .join('/');
}

function isObjectNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { code?: string }).code === 'storage/object-not-found');
}

// ── Public factories ─────────────────────────────────────────────────────────

export interface FirebaseStorageBlobStore extends AsyncBlobStorage {
  keyRef(key: string): KindValueRef;
}

export function createFirebaseStorageBlobStore(
  storage: FirebaseStorageLike,
  basePath: string,
): FirebaseStorageBlobStore {
  const rootRef = storage.ref(basePath);

  function objectRefForKey(key: string): FirebaseStorageReferenceLike {
    return rootRef.child(encodeStorageKeySegment(key));
  }

  async function readObjectText(targetRef: FirebaseStorageReferenceLike): Promise<string> {
    const url = await targetRef.getDownloadURL();
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to fetch storage object ${targetRef.fullPath}: ${response.status}`);
    }
    return response.text();
  }

  async function readObjectBytes(targetRef: FirebaseStorageReferenceLike): Promise<Uint8Array> {
    const url = await targetRef.getDownloadURL();
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to fetch storage object ${targetRef.fullPath}: ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async function listAllKeys(): Promise<string[]> {
    const keys: string[] = [];
    async function walk(currentRef: FirebaseStorageReferenceLike): Promise<void> {
      const result = await currentRef.listAll();
      for (const prefixRef of result.prefixes) {
        await walk(prefixRef);
      }
      for (const itemRef of result.items) {
        const encodedKey = itemRef.name || itemRef.fullPath.slice(rootRef.fullPath.length + 1);
        keys.push(decodeStorageKeySegment(encodedKey));
      }
    }
    try {
      await walk(rootRef);
    } catch (error) {
      if (isObjectNotFound(error)) return [];
      throw error;
    }
    return keys.sort();
  }

  return {
    async read(key) {
      try {
        return await readObjectText(objectRefForKey(key));
      } catch (error) {
        if (isObjectNotFound(error)) return null;
        throw error;
      }
    },
    async write(key, content) {
      await objectRefForKey(key).putString(String(content), 'raw', {
        contentType: 'text/plain; charset=utf-8',
      });
    },
    async exists(key) {
      try {
        await objectRefForKey(key).getMetadata();
        return true;
      } catch (error) {
        if (isObjectNotFound(error)) return false;
        throw error;
      }
    },
    async remove(key) {
      try {
        await objectRefForKey(key).delete();
      } catch (error) {
        if (!isObjectNotFound(error)) throw error;
      }
    },
    async readBytes(key) {
      try {
        return await readObjectBytes(objectRefForKey(key));
      } catch (error) {
        if (isObjectNotFound(error)) return null;
        throw error;
      }
    },
    async writeBytes(key, content) {
      await objectRefForKey(key).put(content as Uint8Array, {
        contentType: 'application/octet-stream',
      });
    },
    async listKeys(prefix = '') {
      const keys = await listAllKeys();
      return prefix ? keys.filter((key) => key.startsWith(prefix)) : keys;
    },
    async stat(key) {
      try {
        const metadata = await objectRefForKey(key).getMetadata();
        return {
          key,
          size: Number(metadata.size ?? 0),
          updatedAt: metadata.updated ?? undefined,
          contentType: metadata.contentType ?? undefined,
        };
      } catch (error) {
        if (isObjectNotFound(error)) return null;
        throw error;
      }
    },
    keyRef(key) {
      return {
        kind: 'firebase-storage',
        value: joinStoragePath(basePath, encodeStorageKeySegment(key)),
      };
    },
  } as FirebaseStorageBlobStore;
}

export function createFirebaseStorageScratchStore(
  storage: FirebaseStorageLike,
  basePath: string,
): AsyncScratchStorage {
  const blobStore = createFirebaseStorageBlobStore(storage, basePath);

  async function getUniqueKey(prefix = 'scratch-', suffix = ''): Promise<string> {
    const id = (globalThis as any).crypto?.randomUUID?.()
      ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    return `${prefix}${id}${suffix}`;
  }

  return {
    ...blobStore,
    getUniqueKey,
    async create(data: string, prefix = 'scratch-', suffix = '') {
      const key = await getUniqueKey(prefix, suffix);
      await blobStore.write(key, data as string);
      return key;
    },
    keyRef(key: string) {
      return {
        kind: 'firebase-storage',
        value: joinStoragePath(basePath, encodeStorageKeySegment(key)),
      };
    },
    config: {
      async get(key: string) {
        const raw = await blobStore.read(`__config__/${key}`);
        if (raw == null) return null;
        try { return JSON.parse(raw); } catch { return raw; }
      },
      async set(key: string, value: unknown) {
        await blobStore.write(`__config__/${key}`, JSON.stringify(value));
      },
    },
  } as unknown as AsyncScratchStorage;
}

/**
 * Replace the blob/scratch namespaces of an existing board adapter (e.g. one
 * produced by `createFirestoreBoardAdapter`) with Firebase Storage-backed
 * implementations rooted at `boards/<boardId>/{blobs,scratch}/`.
 *
 * Pass in a Firebase Storage handle (`firebase.app().storage()`). All other
 * adapter methods are forwarded unchanged.
 */
export function wrapWithFirebaseStorageBlobs<T extends Record<string, any>>(
  boardAdapter: T,
  storage: FirebaseStorageLike,
  boardId: string,
): T {
  const blobRootPath = joinStoragePath('boards', boardId, 'blobs');
  const scratchRootPath = joinStoragePath('boards', boardId, 'scratch');

  return {
    ...boardAdapter,
    blobStorage(namespace: string) {
      return createFirebaseStorageBlobStore(storage, joinStoragePath(blobRootPath, namespace || 'root'));
    },
    scratchStorage() {
      return createFirebaseStorageScratchStore(storage, scratchRootPath);
    },
    scratchStorageForRef() {
      return createFirebaseStorageScratchStore(storage, scratchRootPath);
    },
    async resolveBlob(ref: KindValueRef | undefined | null) {
      if (ref?.kind === 'firebase-storage' && typeof ref.value === 'string') {
        const url = await storage.ref(ref.value).getDownloadURL();
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) {
          throw new Error(`Failed to resolve storage blob ${ref.value}: ${response.status}`);
        }
        return response.text();
      }
      if (typeof boardAdapter.resolveBlob === 'function') {
        return boardAdapter.resolveBlob(ref);
      }
      return null;
    },
  } as T;
}
