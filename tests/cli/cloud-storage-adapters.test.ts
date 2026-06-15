import { describe, expect, it } from 'vitest';

import {
  createAsyncBoardConfigStore,
  createAsyncBoardLiveCardsPublic,
  createAsyncBoardWorkerStore,
  createAsyncCardStorageAdapter,
  createAsyncJsonStorage,
  createAsyncStateSnapshotAdapter,
  createAzureBlobStorage,
  createAzureQueueStorage,
  createCosmosAtomicRelayLock,
  createCosmosJournalStorage,
  createCosmosKvStorage,
  createHostedAsyncBoardPlatformAdapter,
} from '../../src/cli/cloud/index.js';
import type {
  AzureBlobClientLike,
  AzureBlobContainerClientLike,
  AzureBlobItemLike,
  AzureBlockBlobClientLike,
  AzureQueueClientLike,
  AzureQueuePeekedMessageLike,
  AzureQueueReceivedMessageLike,
  CosmosContainerLike,
  CosmosItemLike,
  CosmosSqlQuerySpec,
  HostedFetchLike,
} from '../../src/cli/cloud/index.js';
import type {
  AsyncArchiveFactory,
  AsyncAtomicRelayLock,
  AsyncKVStorage,
  AsyncScratchStorage,
} from '../../src/cli/cloud/storage-async-interface.js';
import { createHttpBoardCallbackTransport } from '../../src/cli/common/board-callback-transport.js';
import { SYS_KEYS_BOARD_STATE_INIT_CARD_ID } from '../../src/cli/common/board-live-cards-lib.js';
import { serializeRef } from '../../src/cli/common/storage-interface.js';

class MemoryAsyncKVStorage implements AsyncKVStorage {
  private readonly data = new Map<string, unknown>();

  async read(key: string): Promise<unknown | null> {
    return this.data.has(key) ? this.data.get(key) ?? null : null;
  }

  async write(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.data.delete(key);
  }

  async listKeys(prefix = ''): Promise<string[]> {
    return [...this.data.keys()].filter((key) => !prefix || key.startsWith(prefix)).sort();
  }
}

class MemoryAsyncScratchStorage implements AsyncScratchStorage {
  private seq = 0;
  private readonly texts = new Map<string, string>();
  private readonly bytes = new Map<string, Uint8Array>();

  async read(key: string): Promise<string | null> {
    return this.texts.has(key) ? this.texts.get(key) ?? null : null;
  }

  async write(key: string, content: string): Promise<void> {
    this.texts.set(key, content);
    this.bytes.delete(key);
  }

  async exists(key: string): Promise<boolean> {
    return this.texts.has(key) || this.bytes.has(key);
  }

  async remove(key: string): Promise<void> {
    this.texts.delete(key);
    this.bytes.delete(key);
  }

  async readBytes(key: string): Promise<Uint8Array | null> {
    return this.bytes.has(key) ? this.bytes.get(key) ?? null : null;
  }

  async writeBytes(key: string, content: Uint8Array): Promise<void> {
    this.bytes.set(key, new Uint8Array(content));
    this.texts.delete(key);
  }

  async listKeys(prefix = ''): Promise<string[]> {
    const keys = new Set<string>([...this.texts.keys(), ...this.bytes.keys()]);
    return [...keys].filter((key) => key.startsWith(prefix)).sort();
  }

  async getUniqueKey(prefix = 'scratch', suffix = '.json'): Promise<string> {
    this.seq += 1;
    return `${prefix}-${this.seq}${suffix}`;
  }

  async create(data: string, prefix?: string, suffix?: string): Promise<string> {
    const key = await this.getUniqueKey(prefix, suffix);
    await this.write(key, data);
    return key;
  }

  keyRef(key: string) {
    return { kind: 'azure-blob-key', value: key };
  }

  config = {
    get: (_k: string) => null,
    set: (_k: string, _v: unknown) => {},
  };
}

function createMemoryArchiveFactory(): AsyncArchiveFactory {
  const blobStores = new Map<string, ReturnType<typeof createAzureBlobStorage>>();
  const journals = new Map<string, { entries: Array<{ id: string; payload: unknown }> }>();
  let seq = 0;

  return {
    stream(name: string) {
      if (!journals.has(name)) journals.set(name, { entries: [] });
      const state = journals.get(name)!;
      return {
        async append(payload: unknown) {
          seq += 1;
          const entry = { id: `j-${seq}`, payload };
          state.entries.push(entry);
          return entry;
        },
        async readAll() {
          return state.entries.slice();
        },
        async readAfter(cursor: string | null) {
          const idx = cursor ? state.entries.findIndex((entry) => entry.id === cursor) : -1;
          const entries = idx >= 0 ? state.entries.slice(idx + 1) : state.entries.slice();
          return { entries, newCursor: entries.length > 0 ? entries[entries.length - 1].id : cursor };
        },
        async clear() {
          state.entries.splice(0, state.entries.length);
        },
      };
    },
    blob(name: string) {
      if (!blobStores.has(name)) blobStores.set(name, createAzureBlobStorage(new FakeAzureBlobContainer()));
      return blobStores.get(name)!;
    },
    async listStreams(prefix = '') {
      return [...journals.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
    async listBlobs(prefix = '') {
      return [...blobStores.keys()].filter((key) => key.startsWith(prefix)).sort();
    },
    config: {
      get: (_k: string) => null,
      set: (_k: string, _v: unknown) => {},
    },
  };
}

function createImmediateAsyncLock(): AsyncAtomicRelayLock {
  let held = false;
  return {
    async tryAcquire() {
      if (held) return null;
      held = true;
      return async () => { held = false; };
    },
  };
}

type StoredCosmosDoc = Record<string, unknown> & { id: string; pk: string; _etag?: string };

class FakeCosmosContainer implements CosmosContainerLike {
  private readonly docs = new Map<string, StoredCosmosDoc>();
  private etagCounter = 0;

  private composite(id: string, pk: unknown): string {
    return `${String(pk ?? '')}::${id}`;
  }

  private stamp<T extends StoredCosmosDoc>(doc: T): T {
    this.etagCounter += 1;
    return { ...doc, _etag: `etag-${this.etagCounter}` };
  }

  item<T = unknown>(id: string, partitionKey?: unknown): CosmosItemLike<T> {
    const key = this.composite(id, partitionKey);
    return {
      read: async () => {
        const resource = this.docs.get(key);
        if (!resource) throw { statusCode: 404 };
        return { resource: resource as T, statusCode: 200 };
      },
      replace: async (body, options) => {
        const existing = this.docs.get(key);
        if (!existing) throw { statusCode: 404 };
        const match = options?.accessCondition?.condition;
        if (match && existing._etag !== match) throw { statusCode: 412 };
        const next = this.stamp(body as StoredCosmosDoc);
        this.docs.set(key, next);
        return { resource: next as T, statusCode: 200 };
      },
      delete: async () => {
        if (!this.docs.has(key)) throw { statusCode: 404 };
        this.docs.delete(key);
        return { statusCode: 204 };
      },
    };
  }

  items = {
    upsert: async <T,>(body: T) => {
      const doc = this.stamp(body as StoredCosmosDoc);
      this.docs.set(this.composite(doc.id, doc.pk), doc);
      return { resource: doc as T, statusCode: 200 };
    },
    create: async <T,>(body: T) => {
      const doc = body as StoredCosmosDoc;
      const key = this.composite(doc.id, doc.pk);
      if (this.docs.has(key)) throw { statusCode: 409 };
      const stored = this.stamp(doc);
      this.docs.set(key, stored);
      return { resource: stored as T, statusCode: 201 };
    },
    query: <T,>(spec: CosmosSqlQuerySpec) => ({
      fetchAll: async () => {
        const params = Object.fromEntries((spec.parameters ?? []).map((entry) => [entry.name, entry.value]));
        let resources = [...this.docs.values()];
        if (params['@kind']) resources = resources.filter((doc) => doc.kind === params['@kind']);
        if (params['@pk']) resources = resources.filter((doc) => doc.pk === params['@pk']);
        if (params['@streamKey']) resources = resources.filter((doc) => doc.streamKey === params['@streamKey']);
        if (typeof params['@prefix'] === 'string') resources = resources.filter((doc) => String(doc.id).startsWith(params['@prefix'] as string));
        if (typeof params['@cursor'] === 'string') resources = resources.filter((doc) => String(doc.id) > (params['@cursor'] as string));
        resources.sort((a, b) => String(a.id).localeCompare(String(b.id)));
        return { resources: resources as T[] };
      },
    }),
  };
}

class FakeAzureBlobContainer implements AzureBlobContainerClientLike {
  private readonly blobs = new Map<string, { bytes: Uint8Array; updatedAt: Date; contentType?: string }>();

  getBlobClient(key: string): AzureBlobClientLike {
    return {
      downloadToBuffer: async () => this.blobs.get(key)?.bytes ?? new Uint8Array(),
      exists: async () => this.blobs.has(key),
      deleteIfExists: async () => { this.blobs.delete(key); },
      getProperties: async () => {
        const blob = this.blobs.get(key);
        if (!blob) throw new Error('missing');
        return {
          contentLength: blob.bytes.byteLength,
          lastModified: blob.updatedAt,
          contentType: blob.contentType,
        };
      },
    };
  }

  getBlockBlobClient(key: string): AzureBlockBlobClientLike {
    return {
      upload: async (data, _length, options) => {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
        this.blobs.set(key, {
          bytes,
          updatedAt: new Date('2026-05-31T10:00:00.000Z'),
          contentType: options?.blobHTTPHeaders?.blobContentType,
        });
      },
    };
  }

  async *listBlobsFlat(options?: { prefix?: string }): AsyncIterable<AzureBlobItemLike> {
    const prefix = options?.prefix ?? '';
    for (const [name, blob] of [...this.blobs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (prefix && !name.startsWith(prefix)) continue;
      yield {
        name,
        properties: {
          contentLength: blob.bytes.byteLength,
          lastModified: blob.updatedAt,
          contentType: blob.contentType,
        },
      };
    }
  }
}

type QueueRecord = {
  id: string;
  messageText: string;
  insertionTime: Date;
  dequeueCount: number;
  popReceipt: string;
  nextVisibleOn: Date;
};

class FakeAzureQueueClient implements AzureQueueClientLike {
  private readonly messages = new Map<string, QueueRecord>();
  private seq = 0;

  private nextId(): string {
    this.seq += 1;
    return `msg-${this.seq}`;
  }

  async sendMessage(content: string) {
    const id = this.nextId();
    this.messages.set(id, {
      id,
      messageText: content,
      insertionTime: new Date('2026-05-31T12:00:00.000Z'),
      dequeueCount: 0,
      popReceipt: `pop-${id}-0`,
      nextVisibleOn: new Date('2026-05-31T12:00:00.000Z'),
    });
    return { messageId: id, insertionTime: new Date('2026-05-31T12:00:00.000Z') };
  }

  async receiveMessages(options?: { numberOfMessages?: number; visibilityTimeout?: number }) {
    const max = options?.numberOfMessages ?? 1;
    const received: AzureQueueReceivedMessageLike[] = [];
    for (const record of [...this.messages.values()].slice(0, max)) {
      record.dequeueCount += 1;
      record.popReceipt = `pop-${record.id}-${record.dequeueCount}`;
      record.nextVisibleOn = new Date(Date.now() + ((options?.visibilityTimeout ?? 30) * 1000));
      received.push({
        messageId: record.id,
        messageText: record.messageText,
        insertionTime: record.insertionTime,
        dequeueCount: record.dequeueCount,
        popReceipt: record.popReceipt,
        nextVisibleOn: record.nextVisibleOn,
      });
    }
    return { receivedMessageItems: received };
  }

  async deleteMessage(messageId: string, popReceipt: string) {
    const record = this.messages.get(messageId);
    if (!record || record.popReceipt !== popReceipt) throw { statusCode: 404 };
    this.messages.delete(messageId);
  }

  async updateMessage(messageId: string, popReceipt: string, content: string, visibilityTimeout = 0) {
    const record = this.messages.get(messageId);
    if (!record || record.popReceipt !== popReceipt) throw { statusCode: 404 };
    record.messageText = content;
    record.popReceipt = `pop-${record.id}-${record.dequeueCount + 1}`;
    record.nextVisibleOn = new Date(Date.now() + visibilityTimeout * 1000);
  }

  async peekMessages() {
    const peekedMessageItems: AzureQueuePeekedMessageLike[] = [...this.messages.values()].map((record) => ({
      messageId: record.id,
      messageText: record.messageText,
      insertionTime: record.insertionTime,
      dequeueCount: record.dequeueCount,
    }));
    return { peekedMessageItems };
  }
}

describe('cloud storage adapters', () => {
  it('builds async JSON, card, and state snapshot adapters over async KV', async () => {
    const kv = new MemoryAsyncKVStorage();
    const json = createAsyncJsonStorage(kv);
    await json.write('card-1', { id: 'card-1', nested: { value: 1 } });
    await json.deepMerge('card-1', { nested: { second: 2 } });
    await json.patch('card-1', 'nested.value', 3);

    const card = createAsyncCardStorageAdapter(json, (value) => JSON.stringify(value));
    const checksum = await card.writeCard('card-2', { id: 'card-2', title: 'Hello' });
    const snapshot = createAsyncStateSnapshotAdapter(() => kv, (value) => JSON.stringify(value));
    const version = await snapshot.writeValues('scope-a', { a: 1, b: 2 }, []);

    expect(await json.get('card-1', 'nested.value')).toBe(3);
    expect(checksum).toContain('card-2');
    expect(await card.cardExists('card-2')).toBe(true);
    expect((await snapshot.readValues('scope-a')).values).toEqual({ a: 1, b: 2, 'card-1': { id: 'card-1', nested: { value: 3, second: 2 } }, 'card-2': { id: 'card-2', title: 'Hello' } });
    expect(version).toContain('"a":1');
  });

  it('stores KV rows and journal entries in Cosmos-shaped containers', async () => {
    const container = new FakeCosmosContainer();
    const kv = createCosmosKvStorage(container);
    const journal = createCosmosJournalStorage(container, 'board-a', {
      idFactory: (() => {
        const ids = ['0001', '0002', '0003'];
        return () => ids.shift() ?? '9999';
      })(),
    });

    await kv.write('cards/1', { id: 1 });
    await kv.write('cards/2', { id: 2 });
    await journal.append({ event: 'one' });
    await journal.append({ event: 'two' });

    expect(await kv.read('cards/1')).toEqual({ id: 1 });
    expect(await kv.listKeys('cards/')).toEqual(['cards/1', 'cards/2']);
    expect(await journal.readAll()).toEqual([
      { id: '0001', payload: { event: 'one' } },
      { id: '0002', payload: { event: 'two' } },
    ]);
    expect(await journal.readAfter('0001')).toEqual({
      entries: [{ id: '0002', payload: { event: 'two' } }],
      newCursor: '0002',
    });
  });

  it('uses Cosmos compare-and-swap semantics for async relay locks', async () => {
    const container = new FakeCosmosContainer();
    const lock = createCosmosAtomicRelayLock(container, 'board-lock', { holderId: 'holder-a' });

    const release = await lock.tryAcquire();
    expect(release).not.toBeNull();
    expect(await lock.tryAcquire()).toBeNull();

    await release?.();
    expect(await lock.tryAcquire()).not.toBeNull();
  });

  it('reads and writes Azure blob-like clients', async () => {
    const container = new FakeAzureBlobContainer();
    const blob = createAzureBlobStorage(container, { keyRef: (key) => ({ kind: 'azure-blob', value: key }) });

    await blob.write('cards/a.json', '{"ok":true}');
    await blob.writeBytes?.('cards/b.bin', new Uint8Array([1, 2, 3]));

    expect(await blob.read('cards/a.json')).toBe('{"ok":true}');
    expect(await blob.readBytes?.('cards/b.bin')).toEqual(new Uint8Array([1, 2, 3]));
    expect(await blob.listKeys('cards/')).toEqual(['cards/a.json', 'cards/b.bin']);
    expect(await blob.stat?.('cards/a.json')).toMatchObject({ key: 'cards/a.json', size: 11 });
    expect(await blob.keyRef?.('cards/a.json')).toEqual({ kind: 'azure-blob', value: 'cards/a.json' });
  });

  it('renameKey moves Azure blob content and returns false when the source is missing', async () => {
    const container = new FakeAzureBlobContainer();
    const blob = createAzureBlobStorage(container);

    await blob.write('staged/hello.txt', 'hi there');

    expect(await blob.renameKey('staged/hello.txt', 'live/hello.txt')).toBe(true);
    expect(await blob.read('staged/hello.txt')).toBeNull();
    expect(await blob.read('live/hello.txt')).toBe('hi there');
    expect(await blob.renameKey('staged/missing.txt', 'live/missing.txt')).toBe(false);
  });

  it('maps Azure queue-like clients to async queue semantics', async () => {
    const active = new FakeAzureQueueClient();
    const dead = new FakeAzureQueueClient();
    const queue = createAzureQueueStorage(active, { deadLetterQueueClient: dead, now: () => new Date('2026-05-31T12:00:00.000Z') });

    const batch = await queue.enqueueMany([{ job: 'pre-A' }, { job: 'pre-B' }]);
    const queued = await queue.enqueue({ job: 'A' });
    const leasedBatch = await queue.lease<{ job: string }>({ max: 3, visibilityMs: 15000 });
    const leased = leasedBatch.find((message) => message.body.job === 'A');
    expect(leased).toBeDefined();
    const nacked = await queue.nack(leased!.id, leased!.leaseToken, { dead: true, reason: 'boom' });
    const deadRows = await queue.peekDeadLetter<{ messageId?: string }>();
    const queued2 = await queue.enqueue({ job: 'B' });
    const [leased2] = await queue.lease<{ job: string }>({ max: 1 });
    const acked = await queue.ack(leased2.id, leased2.leaseToken);

    expect(batch).toHaveLength(2);
    expect(queued.id).toBeTruthy();
    expect(batch.map((message) => message.body)).toEqual([{ job: 'pre-A' }, { job: 'pre-B' }]);
    expect(nacked).toBe(true);
    expect(deadRows[0].reason).toBe('boom');
    expect(queued2.id).toBeTruthy();
    expect(acked).toBe(true);
  });

  it('round-trips board config values over async KV', async () => {
    const kv = new MemoryAsyncKVStorage();
    const cfg = createAsyncBoardConfigStore(kv);
    const ref = {
      meta: 'task-executor',
      howToRun: 'http:post' as const,
      whatToRun: serializeRef({ kind: 'http-url', value: 'https://example.test/task' }),
    };

    await cfg.writeTaskExecutorRef(ref);
    await cfg.writeCardStoreRef('card-ref');
    await cfg.writeOutputsStoreRef('output-ref');

    expect(await cfg.readTaskExecutorRef()).toEqual(ref);
    expect(await cfg.readCardStoreRef()).toBe('card-ref');
    expect(await cfg.readOutputsStoreRef()).toBe('output-ref');
  });

  it('composes an async hosted board adapter over cloud primitives', async () => {
    const boardKv = new MemoryAsyncKVStorage();
    const refKv = new MemoryAsyncKVStorage();
    const rootBlobClient = new FakeAzureBlobContainer();
    const sourcesBlobClient = new FakeAzureBlobContainer();
    const rootBlob = createAzureBlobStorage(rootBlobClient);
    const sourcesBlob = createAzureBlobStorage(sourcesBlobClient);
    const scratch = new MemoryAsyncScratchStorage();
    const archive = createMemoryArchiveFactory();
    const queue = createAzureQueueStorage(new FakeAzureQueueClient(), { deadLetterQueueClient: new FakeAzureQueueClient() });
    const fetchCalls: Array<{ url: string; body: string }> = [];
    const fetchImpl: HostedFetchLike = async (url, init) => {
      fetchCalls.push({ url, body: init.body });
      return {
        ok: true,
        status: 200,
        async text() { return ''; },
      };
    };

    await rootBlob.write('root-file.json', '{"ok":true}');
    const adapter = createHostedAsyncBoardPlatformAdapter({
      boardId: 'board-1',
      queueStoreRef: 'queue-store-ref',
      kvStorage: (_namespace) => boardKv,
      kvStorageForRef: (_ref) => refKv,
      blobStorage: (namespace) => (namespace === 'sources' ? sourcesBlob : rootBlob),
      blobStorageForRef: (_ref) => rootBlob,
      chatStorageForRef: (_ref) => ({
        append: async () => 'chat-1',
        readAll: async () => [],
        readAfter: async () => ({ records: [], cursor: null }),
        clear: async () => {},
        setProcessing: async () => {},
        isProcessing: async () => false,
        getConfig: async () => ({}),
        setConfig: async () => {},
      }),
      queueStorageForRef: (_ref, _lane) => queue,
      scratchStorage: () => scratch,
      scratchStorageForRef: (_ref) => scratch,
      archiveFactory: () => archive,
      archiveFactoryForRef: (_ref) => archive,
      journalStorage: () => archive.stream('board-journal'),
      journalStorageForRef: (_ref) => archive.stream('board-journal'),
      lock: createImmediateAsyncLock(),
      callbackTransport: createHttpBoardCallbackTransport('https://example.test/board'),
      fetch: fetchImpl,
      hashFn: (value) => JSON.stringify(value),
      genId: () => 'gen-1',
    });

    const queueRef = {
      meta: 'task-executor',
      howToRun: 'queue-storage' as const,
      whatToRun: serializeRef({ kind: 'queue', value: 'worker-queue' }),
      extra: { boardId: 'board-from-ref' },
    };
    const httpRef = {
      meta: 'task-executor',
      howToRun: 'http:post' as const,
      whatToRun: serializeRef({ kind: 'http-url', value: 'https://example.test/task' }),
    };

    expect((await adapter.dispatchExecution(queueRef, { op: 'queue' })).dispatched).toBe(true);
    const workerStore = createAsyncBoardWorkerStore(adapter.queueStorageForRef('queue-store-ref', 'task-executor'));
    expect((await workerStore.peekActive())).toHaveLength(1);
    expect((await adapter.dispatchExecution(httpRef, { op: 'http' })).dispatched).toBe(true);
    expect(fetchCalls).toEqual([{ url: 'https://example.test/task', body: JSON.stringify({ op: 'http' }) }]);
    expect(await adapter.resolveBlob({ kind: 'azure-blob-key', value: 'root-file.json' })).toBe('{"ok":true}');
    expect(adapter.hashFn({ a: 1 })).toContain('"a":1');
    expect(adapter.genId()).toBe('gen-1');
  });

  it('runs the first async hosted board runtime slice end to end', async () => {
    const boardKv = new MemoryAsyncKVStorage();
    const cardKv = new MemoryAsyncKVStorage();
    const outputKv = new MemoryAsyncKVStorage();
    const rootBlob = createAzureBlobStorage(new FakeAzureBlobContainer());
    const sourcesBlob = createAzureBlobStorage(new FakeAzureBlobContainer());
    const scratch = new MemoryAsyncScratchStorage();
    const archive = createMemoryArchiveFactory();
    const activeQueueClient = new FakeAzureQueueClient();
    const queue = createAzureQueueStorage(activeQueueClient, { deadLetterQueueClient: new FakeAzureQueueClient() });
    const boardNotifications: unknown[] = [];

    const adapter = createHostedAsyncBoardPlatformAdapter({
      boardId: 'board-async',
      queueStoreRef: 'queue-store-ref',
      kvStorage: (_namespace) => boardKv,
      kvStorageForRef: (ref) => ref === 'card-store-ref' ? cardKv : outputKv,
      blobStorage: (namespace) => namespace === 'sources' ? sourcesBlob : rootBlob,
      blobStorageForRef: (ref) => ref === 'sources-store-ref' ? sourcesBlob : rootBlob,
      chatStorageForRef: (_ref) => ({
        append: async () => 'chat-1',
        readAll: async () => [],
        readAfter: async () => ({ records: [], cursor: null }),
        clear: async () => {},
        setProcessing: async () => {},
        isProcessing: async () => false,
        getConfig: async () => ({}),
        setConfig: async () => {},
      }),
      queueStorageForRef: (_ref, _lane) => queue,
      scratchStorage: () => scratch,
      scratchStorageForRef: () => scratch,
      archiveFactory: () => archive,
      archiveFactoryForRef: () => archive,
      journalStorage: () => archive.stream('board-journal'),
      journalStorageForRef: (_ref) => archive.stream('board-journal'),
      lock: createImmediateAsyncLock(),
      callbackTransport: createHttpBoardCallbackTransport('https://example.test/board'),
      hashFn: (value) => JSON.stringify(value),
      genId: (() => {
        let seq = 0;
        return () => `gen-${++seq}`;
      })(),
      publishBoardChangeNotifications: (notifications) => { boardNotifications.push(...notifications); },
    });

    await cardKv.write('_index', {
      'card-1': { key: 'card-1', checksum: 'sum-1', updatedAt: '2026-05-31T12:00:00.000Z' },
    });
    await cardKv.write('card-1', {
      id: 'card-1',
      card_data: { board: 'demo' },
      source_defs: [{ bindTo: 'payload', outputFile: 'payload.json' }],
      provides: [{ bindTo: 'payload', ref: '_sourcesData.payload' }],
    });

    const taskExecutorRef = {
      meta: 'task-executor',
      howToRun: 'queue-storage' as const,
      whatToRun: serializeRef({ kind: 'queue', value: 'worker-queue' }),
    };
    const chatHandlerFlow = { kind: 'chat-flow', version: 1 };
    const board = createAsyncBoardLiveCardsPublic({ kind: 'cloud-board', value: 'board-async' }, adapter, {
      taskExecutorRef,
      chatHandlerFlow,
    });
    expect(await board.init({
      params: {
        boardRuntimeStoreRef: 'runtime-store-ref',
        cardStoreRef: 'card-store-ref',
        outputsStoreRef: 'outputs-store-ref',
        queueStoreRef: 'queue-store-ref',
        fetchedSourcesStoreRef: 'sources-store-ref',
        scratchStoreRef: 'scratch-store-ref',
        chatStoreRef: 'chat-store-ref',
        artifactsStoreRef: 'artifacts-store-ref',
      },
      body: {},
    })).toEqual({ status: 'success' });

    expect(await board.getScratchStoreRef({})).toEqual({ status: 'success', data: { storeRef: 'scratch-store-ref' } });
    expect(await board.getChatStoreRef({})).toEqual({ status: 'success', data: { storeRef: 'chat-store-ref' } });
    expect(await board.getArtifactsStoreRef({})).toEqual({ status: 'success', data: { storeRef: 'artifacts-store-ref' } });
    expect(await board.getConfig({ params: { key: 'task-executor' } })).toEqual({
      status: 'success',
      data: {
        value: {
          meta: 'task-executor',
          howToRun: 'queue-storage',
          whatToRun: serializeRef({ kind: 'queue', value: 'worker-queue' }),
        },
      },
    });
    expect(await board.getConfig({ params: { key: 'chat-handler-flow' } })).toEqual({
      status: 'success',
      data: { value: { kind: 'chat-flow', version: 1 } },
    });

    expect(await board.upsertCard({ params: { cardId: 'card-1' } })).toEqual({ status: 'success' });
    expect((await board.processAccumulatedEvents({})).status).toBe('success');
    expect(boardNotifications.some((note) => (note as { kind?: string; cardId?: string }).kind === 'card_refreshed' && (note as { kind?: string; cardId?: string }).cardId === SYS_KEYS_BOARD_STATE_INIT_CARD_ID)).toBe(false);

    const workerStore = createAsyncBoardWorkerStore(adapter.queueStorageForRef('queue-store-ref', 'task-executor'));
    const queued = await workerStore.peekActive();
    expect(queued).toHaveLength(1);
    expect(queued[0].request.args.source_def).toMatchObject({ bindTo: 'payload', outputFile: 'payload.json' });

    await rootBlob.write('fetched/payload.json', JSON.stringify({ value: 42 }));
    const callback = queued[0].request.args.callback as { token: string };
    expect(await board.sourceDataFetched({
      params: {
        token: callback.token,
        ref: serializeRef({ kind: 'azure-blob-key', value: 'fetched/payload.json' }),
      },
    })).toEqual({ status: 'success' });
    expect((await board.processAccumulatedEvents({})).status).toBe('success');

    expect(await board.getOutputsDataObject({ params: { key: 'payload' } })).toEqual({
      status: 'success',
      data: { value: 42 },
    });
    expect(await board.getAllOutputsDataObjects({})).toEqual({
      status: 'success',
      data: {
        payload: { value: 42 },
      },
    });
    expect(await board.getOutputsDataObject({ params: { key: 'sys_keys_board_state' } })).toEqual({ status: 'success', data: null });
    expect(await board.getOutputsComputedValues({ params: { key: 'card-1' } })).toEqual({
      status: 'success',
      data: {},
    });
    expect(await board.getAllOutputsComputedValues({})).toEqual({
      status: 'success',
      data: { 'card-1': {} },
    });
    expect(await board.getOutputsFetchedSources({ params: { key: 'card-1' } })).toEqual({
      status: 'success',
      data: {
        'payload.json': serializeRef({ kind: 'azure-blob-key', value: 'card-1/payload.json' }),
      },
    });
    expect(await board.getAllOutputsFetchedSources({})).toEqual({
      status: 'success',
      data: {
        'card-1': {
          'payload.json': serializeRef({ kind: 'azure-blob-key', value: 'card-1/payload.json' }),
        },
      },
    });

    expect(await board.addCardFiles({
      params: { cardId: 'card-1' },
      body: { path: 'docs/readme.md', kind: 'text/markdown' },
    })).toEqual({
      status: 'success',
      data: {
        cardId: 'card-1',
        files_added: [{ idx: 0, entry: { path: 'docs/readme.md', kind: 'text/markdown' } }],
        notified: true,
      },
    });
    expect(await cardKv.read('card-1')).toMatchObject({
      card_data: {
        files: [{ path: 'docs/readme.md', kind: 'text/markdown' }],
      },
    });

    expect(boardNotifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'card_refreshed', cardId: 'card-1' }),
    ]));

    const oneShotResult = await board.buildSseOneShotPayload({});
    expect(oneShotResult.status).toBe('success');
    if (oneShotResult.status === 'success') {
      expect(oneShotResult.data.cardDefinitions).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'card-1' }),
      ]));
      expect(oneShotResult.data.statusSnapshot).toEqual(expect.objectContaining({
        summary: expect.objectContaining({ card_count: 1 }),
      }));
      expect(oneShotResult.data.dataObjectsByToken).toEqual({
        payload: { value: 42 },
      });
      expect(oneShotResult.data.cardRuntimeById).toEqual(expect.objectContaining({
        'card-1': expect.objectContaining({
          card_id: 'card-1',
          card_data: expect.objectContaining({
            files: [{ path: 'docs/readme.md', kind: 'text/markdown' }],
          }),
          computed_values: {},
        }),
      }));
    }

    expect(await board.retrigger({ params: { id: 'card-1' } })).toEqual({ status: 'success' });
    expect((await board.processAccumulatedEvents({})).status).toBe('success');
    const retriggerWorkerStore = createAsyncBoardWorkerStore(adapter.queueStorageForRef('queue-store-ref', 'task-executor'));
    expect((await retriggerWorkerStore.peekActive())).toHaveLength(1);

    expect(await board.removeCard({ params: { id: 'card-1' } })).toEqual({ status: 'success' });
    expect((await board.processAccumulatedEvents({})).status).toBe('success');
    expect((await board.status({})).status).toBe('success');
  });
});