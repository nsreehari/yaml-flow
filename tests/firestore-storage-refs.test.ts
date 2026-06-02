import { describe, it, expect } from 'vitest';
import { createFirestoreBoardRefs, createFirestoreBoardRuntimeBundle, makeFirestoreRef } from '../src/firestore-storage/index.js';
import { parseRef } from '../src/cli/common/storage-interface.js';

function makeFakeFirestore() {
  const db = {
    collection(path: string) {
      return makeCollection(path);
    },
    async runTransaction<T>(_updateFn: unknown): Promise<T> {
      throw new Error('not used');
    },
  };

  function makeCollection(path: string) {
    return {
      path,
      firestore: db,
      doc(id = 'doc') {
        return makeDoc(`${path}/${id}`, id);
      },
      async get() { throw new Error('not used'); },
      where() { return this; },
      orderBy() { return this; },
      limit() { return this; },
    };
  }

  function makeDoc(path: string, id: string) {
    return {
      id,
      path,
      firestore: db,
      async get() { throw new Error('not used'); },
      async set() { throw new Error('not used'); },
      async update() { throw new Error('not used'); },
      async delete() { throw new Error('not used'); },
      collection(name: string) {
        return makeCollection(`${path}/${name}`);
      },
    };
  }

  return db;
}

describe('firestore-storage createFirestoreBoardRefs', () => {
  it('returns the full mandatory BoardRefs shape', () => {
    const refs = createFirestoreBoardRefs('board-A');

    expect(refs.baseRef).toEqual(makeFirestoreRef('boards/board-A'));
    expect(parseRef(refs.cardStoreRef)).toEqual({ kind: 'firestore', value: 'boards/board-A/cards' });
    expect(parseRef(refs.outputsStoreRef)).toEqual({ kind: 'firestore', value: 'boards/board-A/runtime-out' });
    expect(parseRef(refs.scratchStoreRef)).toEqual({ kind: 'firestore', value: 'boards/board-A/scratch' });
    expect(parseRef(refs.archiveStoreRef)).toEqual({ kind: 'firestore', value: 'boards/board-A/archive' });
    expect(parseRef(refs.chatStoreRef)).toEqual({ kind: 'firestore', value: 'boards/board-A/chat' });
    expect(parseRef(refs.artifactsStoreRef)).toEqual({ kind: 'firestore', value: 'boards/board-A/files' });
  });

  it('lets the host override selected refs on the runtime bundle', () => {
    const db = makeFakeFirestore() as any;
    const bundle = createFirestoreBoardRuntimeBundle(db, 'board-A', {
      refs: {
        chatStoreRef: 'b64:eyJraW5kIjoiZmlyZXN0b3JlIiwidmFsdWUiOiJleHRlcm5hbC9jaGF0In0',
        artifactsStoreRef: 'b64:eyJraW5kIjoiZmlyZXN0b3JlIiwidmFsdWUiOiJleHRlcm5hbC9maWxlcyJ9',
      },
    });

    expect(parseRef(bundle.refs.chatStoreRef)).toEqual({ kind: 'firestore', value: 'external/chat' });
    expect(parseRef(bundle.refs.artifactsStoreRef)).toEqual({ kind: 'firestore', value: 'external/files' });
    expect(parseRef(bundle.refs.cardStoreRef)).toEqual({ kind: 'firestore', value: 'boards/board-A/cards' });
  });
});
