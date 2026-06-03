// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createLocalStorageBoardRefs,
  createLocalStorageBoardRuntimeBundle,
} from '../src/localstorage-storage/index.js';
import { parseRef } from '../src/cli/common/storage-interface.js';

describe('localstorage-storage createLocalStorageBoardRuntimeBundle', () => {
  beforeEach(() => {
    globalThis.localStorage.clear();
  });

  it('createLocalStorageBoardRefs exposes the required + optional refs', () => {
    const refs = createLocalStorageBoardRefs('board-A');
    expect(refs.baseRef).toEqual({ kind: 'local-storage', value: 'boards:board-A' });

    expect(parseRef(refs.boardRuntimeStoreRef)).toEqual({ kind: 'local-storage', value: 'boards:board-A:runtime-board' });
    expect(parseRef(refs.cardStoreRef)).toEqual({ kind: 'local-storage', value: 'boards:board-A:cards' });
    expect(parseRef(refs.outputsStoreRef)).toEqual({ kind: 'local-storage', value: 'boards:board-A:runtime-out' });
    expect(parseRef(refs.queueStoreRef)).toEqual({ kind: 'local-storage', value: 'boards:board-A:runtime' });
    expect(parseRef(refs.scratchStoreRef)).toEqual({ kind: 'local-storage', value: 'boards:board-A:scratch' });
    expect(parseRef(refs.chatStoreRef)).toEqual({ kind: 'local-storage', value: 'boards:board-A:chat' });
    expect(parseRef(refs.artifactsStoreRef)).toEqual({ kind: 'local-storage', value: 'boards:board-A:files' });
    expect(parseRef(refs.fetchedSourcesStoreRef!)).toEqual({ kind: 'local-storage', value: 'boards:board-A:sources' });
  });

  it('bundle returns { refs, boardAdapter } with the documented contract surface', () => {
    const bundle = createLocalStorageBoardRuntimeBundle('board-bundle');
    expect(bundle.refs.baseRef.kind).toBe('local-storage');
    expect(typeof bundle.refs.cardStoreRef).toBe('string');
    expect(typeof bundle.boardAdapter.blobStorage).toBe('function');
    expect(typeof bundle.boardAdapter.scratchStorage).toBe('function');
    expect(typeof bundle.boardAdapter.archiveFactory).toBe('function');
    expect(typeof bundle.boardAdapter.journalStorage).toBe('function');
    expect(typeof bundle.boardAdapter.resolveBlob).toBe('function');
  });

  it('allows host config to override selected refs without changing adapter defaults', () => {
    const bundle = createLocalStorageBoardRuntimeBundle('board-bundle', {
      refs: {
        cardStoreRef: 'b64:eyJraW5kIjoibG9jYWwtc3RvcmFnZSIsInZhbHVlIjoiY3VzdG9tOmNhcmRzIn0',
        chatStoreRef: 'b64:eyJraW5kIjoibG9jYWwtc3RvcmFnZSIsInZhbHVlIjoiY3VzdG9tOmNoYXQifQ',
      },
    });

    expect(parseRef(bundle.refs.cardStoreRef)).toEqual({ kind: 'local-storage', value: 'custom:cards' });
    expect(parseRef(bundle.refs.chatStoreRef)).toEqual({ kind: 'local-storage', value: 'custom:chat' });
    expect(parseRef(bundle.refs.outputsStoreRef)).toEqual({ kind: 'local-storage', value: 'boards:board-bundle:runtime-out' });
  });

  it('blobStorage round-trips bytes through the async wrapper', async () => {
    const { boardAdapter } = createLocalStorageBoardRuntimeBundle('board-bytes');
    const blob = boardAdapter.blobStorage('artifacts');

    const payload = new TextEncoder().encode('hello world');
    await blob.writeBytes!('greeting.txt', payload);

    const back = await blob.readBytes!('greeting.txt');
    expect(back).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(back!)).toBe('hello world');

    expect(await blob.exists('greeting.txt')).toBe(true);
    expect((await blob.listKeys('greeting')).sort()).toContain('greeting.txt');
  });

  it('blobStorage renameKey moves content and returns false when the source is missing', async () => {
    const { boardAdapter } = createLocalStorageBoardRuntimeBundle('board-rename');
    const blob = boardAdapter.blobStorage('artifacts');

    await blob.write('staged/hello.txt', 'hi there');

    expect(await blob.renameKey('staged/hello.txt', 'live/hello.txt')).toBe(true);
    expect(await blob.read('staged/hello.txt')).toBeNull();
    expect(await blob.read('live/hello.txt')).toBe('hi there');
    expect(await blob.renameKey('staged/missing.txt', 'live/missing.txt')).toBe(false);
  });

  it('journalStorage append/readAfter respects cursor semantics', async () => {
    const { boardAdapter } = createLocalStorageBoardRuntimeBundle('board-journal');
    const journal = boardAdapter.journalStorage();

    const a = await journal.append({ kind: 'a' });
    const b = await journal.append({ kind: 'b' });
    const c = await journal.append({ kind: 'c' });

    const all = await journal.readAll();
    expect(all.map((entry) => entry.id)).toEqual([a.id, b.id, c.id]);

    const afterA = await journal.readAfter(a.id);
    expect(afterA.entries.map((entry) => entry.id)).toEqual([b.id, c.id]);
    expect(afterA.newCursor).toBe(c.id);

    const afterC = await journal.readAfter(c.id);
    expect(afterC.entries).toEqual([]);
    expect(afterC.newCursor).toBe(c.id);
  });
});
