import { describe, it, expect } from 'vitest';
import {
  createFirebaseStorageBlobStore,
  wrapWithFirebaseStorageBlobs,
  type FirebaseStorageLike,
  type FirebaseStorageReferenceLike,
} from '../src/firebase-storage/index.js';

/**
 * In-memory fake of the Firebase Web SDK compat Storage surface that the
 * yaml-flow firebase-storage adapter consumes. Reads/writes are routed through
 * a global Map keyed by the full storage path.
 */
function makeFakeFirebaseStorage(): { storage: FirebaseStorageLike; objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();

  function makeRef(fullPath: string): FirebaseStorageReferenceLike {
    return {
      fullPath,
      get name() { return fullPath.split('/').filter(Boolean).pop() ?? ''; },
      child(path: string) {
        return makeRef([fullPath, path].filter(Boolean).join('/'));
      },
      async getDownloadURL() {
        if (!objects.has(fullPath)) {
          const err = new Error('not found') as Error & { code?: string };
          err.code = 'storage/object-not-found';
          throw err;
        }
        const bytes = objects.get(fullPath)!;
        const base64 = Buffer.from(bytes).toString('base64');
        return `data:application/octet-stream;base64,${base64}`;
      },
      async getMetadata() {
        if (!objects.has(fullPath)) {
          const err = new Error('not found') as Error & { code?: string };
          err.code = 'storage/object-not-found';
          throw err;
        }
        return { size: objects.get(fullPath)!.byteLength, updated: new Date().toISOString() };
      },
      async delete() {
        objects.delete(fullPath);
      },
      async listAll() {
        const prefix = fullPath ? `${fullPath}/` : '';
        const items: FirebaseStorageReferenceLike[] = [];
        for (const key of objects.keys()) {
          if (!prefix || key.startsWith(prefix)) {
            const rest = prefix ? key.slice(prefix.length) : key;
            if (!rest.includes('/')) items.push(makeRef(key));
          }
        }
        return { items, prefixes: [] };
      },
      async putString(data, format) {
        if (format !== 'raw') throw new Error(`unsupported format in fake: ${format}`);
        objects.set(fullPath, new TextEncoder().encode(String(data)));
      },
      async put(data) {
        const bytes = data instanceof Uint8Array
          ? data
          : new Uint8Array(data as ArrayBuffer);
        objects.set(fullPath, bytes);
      },
    };
  }

  return {
    objects,
    storage: { ref(path = '') { return makeRef(path); } },
  };
}

describe('firebase-storage createFirebaseStorageBlobStore', () => {
  it('round-trips text and binary blobs under the configured base path', async () => {
    const { storage, objects } = makeFakeFirebaseStorage();
    const store = createFirebaseStorageBlobStore(storage, 'boards/b1/blobs/notes');

    await store.write('hello.txt', 'hi there');
    await store.writeBytes('payload.bin', new Uint8Array([1, 2, 3, 4]));

    const text = await store.read('hello.txt');
    expect(text).toBe('hi there');

    const bytes = await store.readBytes('payload.bin');
    expect(Array.from(bytes!)).toEqual([1, 2, 3, 4]);

    expect(await store.exists('hello.txt')).toBe(true);
    expect(await store.exists('does-not-exist')).toBe(false);

    const keys = await store.listKeys();
    expect(keys.sort()).toEqual(['hello.txt', 'payload.bin']);

    // Underlying object paths are base64url-encoded segments under the base.
    const storedPaths = Array.from(objects.keys());
    expect(storedPaths.every((path) => path.startsWith('boards/b1/blobs/notes/'))).toBe(true);
  });

  it('keyRef emits a firebase-storage ref shaped for resolveBlob', () => {
    const { storage } = makeFakeFirebaseStorage();
    const store = createFirebaseStorageBlobStore(storage, 'boards/b1/blobs/notes');
    const ref = store.keyRef('hello.txt');
    expect(ref.kind).toBe('firebase-storage');
    expect(typeof ref.value).toBe('string');
    expect(ref.value).toContain('boards/b1/blobs/notes/');
  });
});

describe('firebase-storage wrapWithFirebaseStorageBlobs', () => {
  it('replaces only blob/scratch + resolveBlob and forwards every other method', async () => {
    const { storage } = makeFakeFirebaseStorage();
    const baseAdapter = {
      kvStorage: () => ({}),
      blobStorage: () => ({ tag: 'from-base' }),
      scratchStorage: () => ({ tag: 'from-base-scratch' }),
      scratchStorageForRef: () => ({ tag: 'from-base-scratch-for-ref' }),
      queueStorage: { tag: 'from-base-queue' },
      genId: () => 'id-from-base',
      async resolveBlob() { return 'from-base-resolve'; },
    } as any;

    const wrapped = wrapWithFirebaseStorageBlobs(baseAdapter, storage, 'b1');

    // Forwarded untouched
    expect(wrapped.queueStorage).toEqual({ tag: 'from-base-queue' });
    expect(wrapped.genId()).toBe('id-from-base');

    // Replaced
    const blob = wrapped.blobStorage('artifacts');
    await blob.write('x.txt', 'hello');
    expect(await blob.read('x.txt')).toBe('hello');

    // resolveBlob delegates to base for non-firebase-storage refs
    expect(await wrapped.resolveBlob({ kind: 'local-storage', value: 'whatever' })).toBe('from-base-resolve');
  });
});
