import { describe, expect, it } from 'vitest';

import { createAsyncBoardWorkerStore, createHostedAsyncBoardPlatformAdapter } from '../../src/cli/cloud/board-platform-adapter-async.js';
import { createBoardWorkerStore } from '../../src/cli/common/board-worker-store.js';
import type { QueueStorage } from '../../src/cli/common/storage-interface.js';
import type {
  AsyncArchiveFactory,
  AsyncAtomicRelayLock,
  AsyncBlobStorage,
  AsyncJournalStorage,
  AsyncKVStorage,
  AsyncQueueStorage,
  AsyncScratchStorage,
} from '../../src/cli/cloud/storage-async-interface.js';
import { startQueueLaneRunners } from '../../src/cli/node/fs-board-adapter.js';
import { createHostedBoardQueueLaneRegistry, createSingleBoardServerRuntime } from '../../src/server-runtime/index.js';
import type { BoardPlatformAdapter } from '../../src/cli/common/board-live-cards-public.js';

function createMemoryQueueStorage(): QueueStorage {
  const active = new Map<string, {
    id: string;
    body: unknown;
    enqueuedAt: string;
    attempt: number;
    leaseToken?: string;
    leaseExpiresAt?: string;
    dedupKey?: string;
  }>();
  const staged = new Map<string, {
    id: string;
    body: unknown;
    enqueuedAt: string;
    attempt: number;
    dedupKey?: string;
  }>();
  const dead = new Map<string, {
    id: string;
    body: unknown;
    enqueuedAt: string;
    attempt: number;
    reason?: string;
  }>();

  return {
    enqueue<T>(body: T) {
      const item = { id: `q-${Math.random().toString(36).slice(2)}`, body, enqueuedAt: new Date().toISOString(), attempt: 0 };
      active.set(item.id, item);
      return item;
    },
    enqueueMany<T>(bodies: T[]) {
      return bodies.map((body) => this.enqueue(body));
    },
    lease<T>(opts?: { max?: number; visibilityMs?: number }) {
      const max = Math.max(1, Math.floor(opts?.max ?? 1));
      const visibilityMs = Math.max(1, Math.floor(opts?.visibilityMs ?? 60_000));
      const now = Date.now();
      for (const item of active.values()) {
        if (item.leaseExpiresAt && Date.parse(item.leaseExpiresAt) <= now) {
          delete item.leaseToken;
          delete item.leaseExpiresAt;
        }
      }
      const leased: Array<{ id: string; body: T; enqueuedAt: string; attempt: number; leaseToken: string; leaseExpiresAt: string }> = [];
      for (const item of active.values()) {
        if (leased.length >= max) break;
        if (item.leaseToken) continue;
        item.attempt += 1;
        item.leaseToken = `lease-${Math.random().toString(36).slice(2)}`;
        item.leaseExpiresAt = new Date(Date.now() + visibilityMs).toISOString();
        leased.push({ id: item.id, body: item.body as T, enqueuedAt: item.enqueuedAt, attempt: item.attempt, leaseToken: item.leaseToken, leaseExpiresAt: item.leaseExpiresAt });
      }
      return leased;
    },
    ack(messageId: string, leaseToken: string) {
      const item = active.get(messageId);
      if (!item || item.leaseToken !== leaseToken) return false;
      active.delete(messageId);
      return true;
    },
    nack(messageId: string, leaseToken: string, opts?: { dead?: boolean; reason?: string }) {
      const item = active.get(messageId);
      if (!item || item.leaseToken !== leaseToken) return false;
      delete item.leaseToken;
      delete item.leaseExpiresAt;
      if (opts?.dead) {
        active.delete(messageId);
        dead.set(messageId, { id: item.id, body: item.body, enqueuedAt: item.enqueuedAt, attempt: item.attempt, reason: opts.reason });
      }
      return true;
    },
    peekActive<T>() {
      return [...active.values()].filter((item) => !item.leaseToken).map((item) => ({ id: item.id, body: item.body as T, enqueuedAt: item.enqueuedAt, attempt: item.attempt }));
    },
    peekDeadLetter<T>() {
      return [...dead.values()].map((item) => ({ id: item.id, body: item.body as T, enqueuedAt: item.enqueuedAt, attempt: item.attempt, reason: item.reason }));
    },
    stage<T>(body: T, opts?: { dedupKey?: string }) {
      const dedupKey = opts?.dedupKey;
      if (dedupKey) {
        for (const m of [...active.values(), ...staged.values()]) {
          if ((m as { dedupKey?: string }).dedupKey === dedupKey) return null;
        }
      }
      const item = { id: `s-${Math.random().toString(36).slice(2)}`, body, enqueuedAt: new Date().toISOString(), attempt: 0, ...(dedupKey ? { dedupKey } : {}) };
      staged.set(item.id, item);
      return { id: item.id, body: item.body as T, enqueuedAt: item.enqueuedAt, attempt: item.attempt };
    },
    commitStaged(messageId: string) {
      const item = staged.get(messageId);
      if (!item) return false;
      staged.delete(messageId);
      active.set(messageId, { ...item, attempt: 0, enqueuedAt: new Date().toISOString() });
      return true;
    },
    discardStaged(messageId: string, reason?: string) {
      const item = staged.get(messageId);
      if (!item) return false;
      staged.delete(messageId);
      dead.set(messageId, { id: item.id, body: item.body, enqueuedAt: item.enqueuedAt, attempt: item.attempt, reason });
      return true;
    },
    peekStaged<T>() {
      return [...staged.values()].map((item) => ({ id: item.id, body: item.body as T, enqueuedAt: item.enqueuedAt, attempt: item.attempt }));
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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
    return [...this.data.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

class MemoryAsyncBlobStorage implements AsyncBlobStorage {
  private readonly texts = new Map<string, string>();

  async read(key: string): Promise<string | null> {
    return this.texts.get(key) ?? null;
  }

  async write(key: string, content: string): Promise<void> {
    this.texts.set(key, content);
  }

  async exists(key: string): Promise<boolean> {
    return this.texts.has(key);
  }

  async remove(key: string): Promise<void> {
    this.texts.delete(key);
  }

  async listKeys(prefix = ''): Promise<string[]> {
    return [...this.texts.keys()].filter((key) => key.startsWith(prefix)).sort();
  }
}

class MemoryAsyncQueueStorage implements AsyncQueueStorage {
  private readonly active = new Map<string, {
    id: string;
    body: unknown;
    enqueuedAt: string;
    attempt: number;
    leaseToken?: string;
    leaseExpiresAt?: string;
    dedupKey?: string;
  }>();
  private readonly staged = new Map<string, {
    id: string;
    body: unknown;
    enqueuedAt: string;
    attempt: number;
    dedupKey?: string;
  }>();
  private readonly dead = new Map<string, {
    id: string;
    body: unknown;
    enqueuedAt: string;
    attempt: number;
    reason?: string;
  }>();

  async enqueue<T>(body: T) {
    const item = { id: `aq-${Math.random().toString(36).slice(2)}`, body, enqueuedAt: new Date().toISOString(), attempt: 0 };
    this.active.set(item.id, item);
    return item;
  }

  async enqueueMany<T>(bodies: T[]) {
    const queued = [] as QueueMessage<T>[];
    for (const body of bodies) queued.push(await this.enqueue(body));
    return queued;
  }

  async lease<T>(opts?: { max?: number; visibilityMs?: number }) {
    const max = Math.max(1, Math.floor(opts?.max ?? 1));
    const visibilityMs = Math.max(1, Math.floor(opts?.visibilityMs ?? 60_000));
    const now = Date.now();
    for (const item of this.active.values()) {
      if (item.leaseExpiresAt && Date.parse(item.leaseExpiresAt) <= now) {
        delete item.leaseToken;
        delete item.leaseExpiresAt;
      }
    }
    const leased: Array<{ id: string; body: T; enqueuedAt: string; attempt: number; leaseToken: string; leaseExpiresAt: string }> = [];
    for (const item of this.active.values()) {
      if (leased.length >= max) break;
      if (item.leaseToken) continue;
      item.attempt += 1;
      item.leaseToken = `lease-${Math.random().toString(36).slice(2)}`;
      item.leaseExpiresAt = new Date(Date.now() + visibilityMs).toISOString();
      leased.push({ id: item.id, body: item.body as T, enqueuedAt: item.enqueuedAt, attempt: item.attempt, leaseToken: item.leaseToken, leaseExpiresAt: item.leaseExpiresAt });
    }
    return leased;
  }

  async ack(messageId: string, leaseToken: string): Promise<boolean> {
    const item = this.active.get(messageId);
    if (!item || item.leaseToken !== leaseToken) return false;
    this.active.delete(messageId);
    return true;
  }

  async nack(messageId: string, leaseToken: string, opts?: { dead?: boolean; reason?: string }): Promise<boolean> {
    const item = this.active.get(messageId);
    if (!item || item.leaseToken !== leaseToken) return false;
    delete item.leaseToken;
    delete item.leaseExpiresAt;
    if (opts?.dead) {
      this.active.delete(messageId);
      this.dead.set(messageId, { id: item.id, body: item.body, enqueuedAt: item.enqueuedAt, attempt: item.attempt, reason: opts.reason });
    }
    return true;
  }

  async peekActive<T>() {
    return [...this.active.values()].filter((item) => !item.leaseToken).map((item) => ({ id: item.id, body: item.body as T, enqueuedAt: item.enqueuedAt, attempt: item.attempt }));
  }

  async peekDeadLetter<T>() {
    return [...this.dead.values()].map((item) => ({ id: item.id, body: item.body as T, enqueuedAt: item.enqueuedAt, attempt: item.attempt, reason: item.reason }));
  }

  async stage<T>(body: T, opts?: { dedupKey?: string }) {
    const dedupKey = opts?.dedupKey;
    if (dedupKey) {
      for (const m of [...this.active.values(), ...this.staged.values()]) {
        if ((m as { dedupKey?: string }).dedupKey === dedupKey) return null;
      }
    }
    const item = { id: `as-${Math.random().toString(36).slice(2)}`, body, enqueuedAt: new Date().toISOString(), attempt: 0, ...(dedupKey ? { dedupKey } : {}) };
    this.staged.set(item.id, item);
    return { id: item.id, body: item.body as T, enqueuedAt: item.enqueuedAt, attempt: item.attempt };
  }

  async commitStaged(messageId: string): Promise<boolean> {
    const item = this.staged.get(messageId);
    if (!item) return false;
    this.staged.delete(messageId);
    this.active.set(messageId, { ...item, attempt: 0, enqueuedAt: new Date().toISOString() });
    return true;
  }

  async discardStaged(messageId: string, reason?: string): Promise<boolean> {
    const item = this.staged.get(messageId);
    if (!item) return false;
    this.staged.delete(messageId);
    this.dead.set(messageId, { id: item.id, body: item.body, enqueuedAt: item.enqueuedAt, attempt: item.attempt, reason });
    return true;
  }

  async peekStaged<T>() {
    return [...this.staged.values()].map((item) => ({ id: item.id, body: item.body as T, enqueuedAt: item.enqueuedAt, attempt: item.attempt }));
  }
}

function createAsyncJournalStorage(): AsyncJournalStorage {
  const entries: Array<{ id: string; payload: unknown }> = [];
  let counter = 0;
  return {
    async append(payload: unknown) {
      const entry = { id: `j-${++counter}`, payload };
      entries.push(entry);
      return entry;
    },
    async readAll() {
      return entries.slice();
    },
    async readAfter(cursor: string | null) {
      const index = cursor ? entries.findIndex((entry) => entry.id === cursor) : -1;
      const nextEntries = index >= 0 ? entries.slice(index + 1) : entries.slice();
      return { entries: nextEntries, newCursor: nextEntries.length > 0 ? nextEntries[nextEntries.length - 1].id : cursor };
    },
  };
}

function createAsyncArchiveFactory(): AsyncArchiveFactory {
  const blobs = new Map<string, MemoryAsyncBlobStorage>();
  const streams = new Map<string, AsyncJournalStorage>();
  return {
    stream(name: string) {
      if (!streams.has(name)) streams.set(name, createAsyncJournalStorage());
      return streams.get(name)!;
    },
    blob(name: string) {
      if (!blobs.has(name)) blobs.set(name, new MemoryAsyncBlobStorage());
      return blobs.get(name)!;
    },
    async listStreams(prefix = '') {
      return [...streams.keys()].filter((name) => name.startsWith(prefix)).sort();
    },
    async listBlobs(prefix = '') {
      return [...blobs.keys()].filter((name) => name.startsWith(prefix)).sort();
    },
    config: {
      get: () => null,
      set: () => {},
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

function createAsyncScratchStorage(): AsyncScratchStorage {
  const blob = new MemoryAsyncBlobStorage();
  let seq = 0;
  return {
    ...blob,
    async getUniqueKey(prefix = 'scratch', suffix = '.json') {
      seq += 1;
      return `${prefix}-${seq}${suffix}`;
    },
    async create(data: string, prefix?: string, suffix?: string) {
      const key = await this.getUniqueKey(prefix, suffix);
      await this.write(key, data);
      return key;
    },
    keyRef(key: string) {
      return { kind: 'azure-blob-key', value: key };
    },
    config: {
      get: () => null,
      set: () => {},
    },
  };
}

describe('server-runtime hosted queue lane registry', () => {
  it('applies runtime-owned lane tuning to hosted lanes', () => {
    const runtime = createSingleBoardServerRuntime({
      boardId: 'board-a',
      boards: [],
      invocationAdapter: { async invoke() { return { dispatched: true }; } },
      queueLaneTuning: {
        processAccumulated: { pollIntervalMs: 25, visibilityMs: 2500 },
        chatAgent: { concurrency: 3 },
        taskExecutor: { maxAttempts: 9 },
      },
    });
    const workerQueue = createMemoryQueueStorage();
    const chatQueue = createMemoryQueueStorage();
    const processQueue = createMemoryQueueStorage();
    const queueStoreRef = 'queue-store-ref';
    const boardAdapter = {
      queueStorageForRef: (_ref: string, lane: string) => lane === 'task-executor'
        ? workerQueue
        : lane === 'chat-agent'
          ? chatQueue
          : processQueue,
    } as Pick<BoardPlatformAdapter, 'queueStorageForRef'> as BoardPlatformAdapter;

    const registry = createHostedBoardQueueLaneRegistry({
      boardId: 'board-a',
      queueStoreRef,
      runtime,
      boardAdapter,
      logger: { info() {}, warn() {}, error() {} },
      executeTaskExecutorRequest: async () => {},
    });

    expect(registry.lanes).toHaveLength(3);
    expect(registry.lanes[0]).toMatchObject({ id: 'process-accumulated', pollIntervalMs: 25, visibilityMs: 2500 });
    expect(registry.lanes[1]).toMatchObject({ id: 'chat-agent', concurrency: 3 });
    expect(registry.lanes[2]).toMatchObject({ id: 'task-executor', maxAttempts: 9 });
  });

  it('runs all three hosted lanes through one registry', async () => {
    const workerQueue = createMemoryQueueStorage();
    const chatQueue = createMemoryQueueStorage();
    const processQueue = createMemoryQueueStorage();
    const queueStoreRef = 'queue-store-ref';

    const processCalls: number[] = [];
    const chatCalls: Array<Record<string, unknown>> = [];
    const taskCalls: Array<Record<string, unknown>> = [];

    const boardAdapter = {
      queueStorageForRef: (_ref: string, lane: string) => lane === 'task-executor'
        ? workerQueue
        : lane === 'chat-agent'
          ? chatQueue
          : processQueue,
    } as Pick<BoardPlatformAdapter, 'queueStorageForRef'> as BoardPlatformAdapter;

    const runtime = {
      async __drainProcessAccumulatedLane() {
        processCalls.push(Date.now());
        return { status: 'success' } as const;
      },
      async handleChatAgentRequest(request: { args: Record<string, unknown> }) {
        chatCalls.push(request.args);
      },
    };

    const registry = createHostedBoardQueueLaneRegistry({
      boardId: 'board-a',
      queueStoreRef,
      runtime,
      boardAdapter,
      logger: { info() {}, warn() {}, error() {} },
      executeTaskExecutorRequest: async (args) => {
        taskCalls.push(args);
      },
    });

    processQueue.enqueue({ boardRef: 'board-a' });
    createBoardWorkerStore(boardAdapter.queueStorageForRef(queueStoreRef, 'chat-agent')).enqueueRequest({
      boardId: 'board-a',
      ref: {
        meta: 'chat-handler',
        howToRun: 'http:post',
        whatToRun: { kind: 'http-url', value: 'http://example.test/chat' },
      },
      args: { cardId: 'card-1', turnId: 'turn-1' },
    });
    createBoardWorkerStore(boardAdapter.queueStorageForRef(queueStoreRef, 'task-executor')).enqueueRequest({
      boardId: 'board-a',
      ref: {
        meta: 'task-executor',
        howToRun: 'queue-storage',
        whatToRun: { kind: 'queue-storage', value: 'board:board-a:board-worker' },
      },
      args: { source_def: { bindTo: 'prices' } },
    });

    const stop = startQueueLaneRunners(registry);
    try {
      await waitFor(() => processCalls.length === 1 && chatCalls.length === 1 && taskCalls.length === 1);
      expect(createBoardWorkerStore(boardAdapter.queueStorageForRef(queueStoreRef, 'task-executor')).peekActive()).toHaveLength(0);
      expect(createBoardWorkerStore(boardAdapter.queueStorageForRef(queueStoreRef, 'chat-agent')).peekActive()).toHaveLength(0);
      expect(processQueue.peekActive()).toHaveLength(0);
      expect(chatCalls[0]).toMatchObject({ cardId: 'card-1', turnId: 'turn-1' });
      expect(taskCalls[0]).toMatchObject({ source_def: { bindTo: 'prices' } });
    } finally {
      stop();
    }
  });

  it('runs the hosted async adapter lane path through one registry', async () => {
    const kv = new MemoryAsyncKVStorage();
    const blob = new MemoryAsyncBlobStorage();
    const scratch = createAsyncScratchStorage();
    const archiveFactory = createAsyncArchiveFactory();
    const queueStoreRef = 'queue-store-ref';
    const queueStorage = new MemoryAsyncQueueStorage();
    const chatQueueStorage = new MemoryAsyncQueueStorage();
    const processQueueStorage = new MemoryAsyncQueueStorage();
    const adapter = createHostedAsyncBoardPlatformAdapter({
      boardId: 'board-async',
      kvStorage: () => kv,
      kvStorageForRef: () => kv,
      blobStorage: () => blob,
      blobStorageForRef: () => blob,
      chatStorageForRef: () => ({
        append: async () => ({ id: 'noop' }),
        readAll: async () => [],
        readAfter: async () => ({ records: [], cursor: null }),
        clear: async () => {},
        setProcessing: async () => {},
        isProcessing: async () => false,
        getConfig: async () => ({}),
        setConfig: async () => {},
      }),
      queueStoreRef,
      queueStorageForRef: (_ref: string, lane: string) => lane === 'task-executor'
        ? queueStorage
        : lane === 'chat-agent'
          ? chatQueueStorage
          : processQueueStorage,
      scratchStorage: () => scratch,
      scratchStorageForRef: () => scratch,
      archiveFactory: () => archiveFactory,
      archiveFactoryForRef: () => archiveFactory,
      journalStorage: () => archiveFactory.stream('board-journal'),
      journalStorageForRef: () => archiveFactory.stream('board-journal'),
      lock: createImmediateAsyncLock(),
      resolveBlob: async (ref) => ref.value,
      hashFn: (value: unknown) => JSON.stringify(value),
      genId: () => `id-${Math.random().toString(36).slice(2)}`,
    });

    const processCalls: number[] = [];
    const chatCalls: Array<Record<string, unknown>> = [];
    const taskCalls: Array<Record<string, unknown>> = [];

    const registry = createHostedBoardQueueLaneRegistry({
      boardId: 'board-async',
      queueStoreRef,
      runtime: {
        queueLaneTuning: { chatAgent: { pollIntervalMs: 10 }, taskExecutor: { concurrency: 2 } },
        async __drainProcessAccumulatedLane() {
          processCalls.push(Date.now());
          return { status: 'success' } as const;
        },
        async handleChatAgentRequest(request: { args: Record<string, unknown> }) {
          chatCalls.push(request.args);
        },
      },
      boardAdapter: adapter,
      logger: { info() {}, warn() {}, error() {} },
      executeTaskExecutorRequest: async (args) => {
        taskCalls.push(args);
      },
    });

    await adapter.queueStorageForRef(queueStoreRef, 'process-accumulated').enqueue({ boardRef: 'board-async' });
    await createAsyncBoardWorkerStore(adapter.queueStorageForRef(queueStoreRef, 'chat-agent')).enqueueRequest({
      boardId: 'board-async',
      ref: {
        meta: 'chat-handler',
        howToRun: 'http:post',
        whatToRun: { kind: 'http-url', value: 'http://example.test/chat' },
      },
      args: { cardId: 'card-async', turnId: 'turn-async' },
    });
    await createAsyncBoardWorkerStore(adapter.queueStorageForRef(queueStoreRef, 'task-executor')).enqueueRequest({
      boardId: 'board-async',
      ref: {
        meta: 'task-executor',
        howToRun: 'queue-storage',
        whatToRun: { kind: 'queue-storage', value: 'board:board-async:board-worker' },
      },
      args: { source_def: { bindTo: 'cloud-prices' } },
    });

    const stop = startQueueLaneRunners(registry);
    try {
      await waitFor(() => processCalls.length === 1 && chatCalls.length === 1 && taskCalls.length === 1);
      expect(await createAsyncBoardWorkerStore(adapter.queueStorageForRef(queueStoreRef, 'task-executor')).peekActive()).toHaveLength(0);
      expect(await createAsyncBoardWorkerStore(adapter.queueStorageForRef(queueStoreRef, 'chat-agent')).peekActive()).toHaveLength(0);
      expect(await adapter.queueStorageForRef(queueStoreRef, 'process-accumulated').peekActive()).toHaveLength(0);
      expect(chatCalls[0]).toMatchObject({ cardId: 'card-async', turnId: 'turn-async' });
      expect(taskCalls[0]).toMatchObject({ source_def: { bindTo: 'cloud-prices' } });
    } finally {
      stop();
    }
  });
});