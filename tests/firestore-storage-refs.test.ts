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

  it('exposes a non-core preflight surface for hosted runtimes', async () => {
    const db = makeFakeFirestore() as any;
    const bundle = createFirestoreBoardRuntimeBundle(db, 'board-A');

    const result = await bundle.nonCore.validateCardPreflight({
      body: {
        id: 'card-a',
        card_data: { rows: [] },
      },
    });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.cardId).toBe('card-a');
      expect(result.data.isValid).toBe(true);
    }
  });

  it('routes hosted non-core executor-backed preflight calls through the immediate hook', async () => {
    const db = makeFakeFirestore() as any;
    const calls: Array<{ subcommand: string; input?: string }> = [];
    const bundle = createFirestoreBoardRuntimeBundle(db, 'board-A', {
      nonCoreTaskExecutor: async (request) => {
        calls.push({ subcommand: request.subcommand, input: request.input });
        if (request.subcommand === 'describe-capabilities') {
          return { executor: 'hosted-hook', sourceKinds: { json: {} } };
        }
        if (request.subcommand === 'validate-source-def') {
          return { ok: true, errors: [] };
        }
        throw new Error(`unexpected subcommand ${request.subcommand}`);
      },
    });

    const describeResult = await bundle.nonCore.describeTaskExecutorCapabilities({});
    expect(describeResult.status).toBe('success');
    if (describeResult.status === 'success') {
      expect(describeResult.data).toMatchObject({ executor: 'hosted-hook' });
    }

    const validateResult = await bundle.nonCore.validateCardPreflight({
      body: {
        id: 'card-with-source',
        card_data: { rows: [] },
        source_defs: [
          {
            kind: 'json',
            bindTo: 'prices',
            outputFile: 'prices.json',
          },
        ],
      },
    });

    expect(validateResult.status).toBe('success');
    if (validateResult.status === 'success') {
      expect(validateResult.data.isValid).toBe(true);
      expect(validateResult.data.issues).toEqual([]);
    }

    expect(calls.map((entry) => entry.subcommand)).toEqual([
      'describe-capabilities',
      'validate-source-def',
    ]);
  });

  it('marks hosted queue-storage task executors as direct source output capable', () => {
    const db = makeFakeFirestore() as any;
    const bundle = createFirestoreBoardRuntimeBundle(db, 'board-A');

    expect(bundle.boardAdapter.supportsDirectSourceOutput?.({
      meta: 'task-executor',
      howToRun: 'queue-storage',
      whatToRun: 'b64:eyJraW5kIjoicXVldWUtc3RvcmFnZSIsInZhbHVlIjoiYm9hcmQ6Ym9hcmQtQTpib2FyZC13b3JrZXIifQ',
      extra: { boardId: 'board-A' },
    })).toBe(true);
  });
});
