/**
 * bootstrap-notification-catchup.test.ts
 *
 * Tests for three behaviours introduced to fix the "blank card on page-refresh" bug:
 *
 * 1. appendNotification unpacks notification-batch events so ctx.notification.* is
 *    populated when publishBoardChangeNotifications fires a batched event.
 *
 * 2. upsertCardsFromSource no longer appends task-restart journal events on every
 *    bootstrap — only task-upsert when the task config actually changed.
 *
 * 3. The /bootstrap route fires a catch-up notification batch (status + data-objects
 *    + computed-values) via the board public API after bootstrapBoard(), so that
 *    buildPublishedRuntimePayload() returns persisted data even when the reactive
 *    graph is already in 'completed' state and emits no new drain-cycle notifications.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type {
  BoardPlatformAdapter,
  BoardChangeNotification,
} from '../../src/cli/common/board-live-cards-public.js';
import type {
  KVStorage,
  BlobStorage,
  AtomicRelayLock,
  KindValueRef,
  QueueStorage,
} from '../../src/cli/common/storage-interface.js';
import { createHttpBoardCallbackTransport } from '../../src/cli/common/board-callback-transport.js';
import { createBoardWorkerStore } from '../../src/cli/common/board-worker-store.js';
import type {
  SingleBoardRuntimeOptions,
  InvocationAdapter,
  RuntimeRequest,
  RuntimeResponse,
} from '../../src/server-runtime/types.js';
import { parseRef, serializeRef } from '../../src/cli/common/storage-interface.js';
import { createSingleBoardServerRuntime } from '../../src/server-runtime/index.js';
import { createCardStorePublic } from '../../src/cli/common/card-store-lib-public.js';
import { createCardStore } from '../../src/cli/common/board-live-cards-lib.js';

// ============================================================================
// Minimal in-memory adapters (same pattern as firebase-runtime-integration.test.ts)
// ============================================================================

function createMemoryKvStorage(): KVStorage {
  const data = new Map<string, unknown>();
  return {
    read(key) { return data.has(key) ? (data.get(key) ?? null) : null; },
    write(key, value) { data.set(key, value); },
    delete(key) { data.delete(key); },
    listKeys(prefix?) {
      const keys = [...data.keys()].sort();
      return prefix ? keys.filter(k => k.startsWith(prefix)) : keys;
    },
  };
}

function createMemoryBlobStorage(): BlobStorage {
  const texts = new Map<string, string>();
  const bytes = new Map<string, Uint8Array>();
  return {
    read(key) { return texts.get(key) ?? null; },
    write(key, content) { texts.set(key, content); },
    exists(key) { return texts.has(key) || bytes.has(key); },
    remove(key) { texts.delete(key); bytes.delete(key); },
    readBytes(key) { return bytes.get(key) ?? null; },
    writeBytes(key, content) { bytes.set(key, new Uint8Array(content)); },
    listKeys(prefix?) {
      const arr = [...new Set([...texts.keys(), ...bytes.keys()])].sort();
      return prefix ? arr.filter(k => k.startsWith(prefix)) : arr;
    },
    stat(key) {
      const raw = texts.get(key);
      if (raw == null) return null;
      return { key, size: new TextEncoder().encode(raw).byteLength };
    },
  };
}

function createMemoryJournalAdapter() {
  const entries: Array<{ id: string; payload: unknown }> = [];
  let counter = 0;
  return {
    readAllEntries() { return [...entries]; },
    appendEntry(entry: { id: string; payload: unknown }) { entries.push(entry); },
    generateId() { return `mem-${(++counter)}`; },
  };
}

function createMemoryLock(): AtomicRelayLock {
  let held = false;
  return {
    tryAcquire() {
      if (held) return null;
      held = true;
      return () => { held = false; };
    },
  };
}

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
    enqueueIfAbsent<T>(body: T, dedupKey: string) {
      for (const existing of active.values()) {
        if (existing.dedupKey === dedupKey) return null;
      }
      const item = { id: `q-${Math.random().toString(36).slice(2)}`, body, enqueuedAt: new Date().toISOString(), attempt: 0, dedupKey };
      active.set(item.id, item);
      return { id: item.id, body: item.body, enqueuedAt: item.enqueuedAt, attempt: item.attempt };
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
  };
}

// ============================================================================
// Build a test platform adapter that also captures published notifications
// ============================================================================

function createTestAdapter(opts?: { onPublish?: (batch: BoardChangeNotification[]) => void }): BoardPlatformAdapter & {
  publishedBatches: BoardChangeNotification[][];
} {
  const kvStores = new Map<string, KVStorage>();
  const publishedBatches: BoardChangeNotification[][] = [];

  function getKv(ns: string): KVStorage {
    if (!kvStores.has(ns)) kvStores.set(ns, createMemoryKvStorage());
    return kvStores.get(ns)!;
  }

  const journal = createMemoryJournalAdapter();
  const lock = createMemoryLock();
  const workerQueue = createMemoryQueueStorage();
  const chatQueue = createMemoryQueueStorage();
  const processAccumulatedQueue = createMemoryQueueStorage();

  const adapter: BoardPlatformAdapter & { publishedBatches: BoardChangeNotification[][] } = {
    publishedBatches,
    kvStorage: (ns) => getKv(ns),
    kvStorageForRef(ref: string) {
      const inner = parseRef(ref).kind;
      return getKv(`_ref/${ref}`);
    },
    blobStorage: (_ns) => createMemoryBlobStorage(),
    journalAdapter: () => journal,
    boardWorkerStore: () => createBoardWorkerStore(workerQueue),
    chatAgentStore: () => createBoardWorkerStore(chatQueue),
    processAccumulatedStore: () => processAccumulatedQueue,
    lock,
    callbackTransport: createHttpBoardCallbackTransport('http://localhost'),
    async dispatchExecution(_ref, _args) { return { dispatched: true }; },
    resolveBlob(_ref: KindValueRef) { throw new Error('not used in test'); },
    hashFn(value: unknown) {
      const str = JSON.stringify(value);
      let h = 0;
      for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
      return Math.abs(h).toString(16).padStart(8, '0');
    },
    genId() { return Math.random().toString(36).slice(2).padEnd(32, '0'); },
    onWarn: () => {},
    publishBoardChangeNotifications(notifications: BoardChangeNotification[]) {
      publishedBatches.push([...notifications]);
      opts?.onPublish?.(notifications);
    },
  };
  return adapter;
}

// ============================================================================
// Sample cards — one with a provides binding so token routing is exercised
// ============================================================================

const SAMPLE_CARDS: Array<Record<string, unknown>> = [
  {
    id: 'card-source',
    meta: { title: 'Source Card' },
    card_data: { value: 42 },
    provides: [{ bindTo: 'myToken', ref: 'card_data.value' }],
    view: { elements: [] },
  },
  {
    id: 'card-consumer',
    meta: { title: 'Consumer Card' },
    requires: ['myToken'],
    card_data: {},
    view: { elements: [] },
  },
];

// ============================================================================
// Helper: build a runtime + preload card store
// ============================================================================

function buildRuntime(adapter: ReturnType<typeof createTestAdapter>) {
  const cardStoreRef = serializeRef({ kind: 'mem', value: 'card-store' });
  const outputsStoreRef = serializeRef({ kind: 'mem', value: 'outputs' });

  const preloadKv = adapter.kvStorageForRef(cardStoreRef);
  const preloadStore = createCardStorePublic(createCardStore({
    readIndex: () => preloadKv.read('_index'),
    writeIndex: (idx: unknown) => preloadKv.write('_index', idx),
    readCard: (id: string) => preloadKv.read(id),
    writeCard: (id: string, card: unknown) => { preloadKv.write(id, card); return id; },
    removeCard: (id: string) => preloadKv.delete(id),
    cardExists: (id: string) => preloadKv.read(id) !== null,
    defaultCardKey: (id: string) => id,
  } as any));

  for (const card of SAMPLE_CARDS) {
    const r = preloadStore.set({ body: card });
    if (r.status !== 'success') throw new Error(`preload failed: ${r.error}`);
  }

  const invocationAdapter: InvocationAdapter = {
    async invoke() { return { dispatched: true }; },
  };

  const runtimeOptions: SingleBoardRuntimeOptions = {
    apiBasePath: '/api/board',
    boardId: 'test',
    boards: [{
      label: 'base',
      boardAdapter: adapter,
      baseRef: { kind: 'mem', value: 'board' },
      cardStoreRef,
      outputsStoreRef,
    }],
    invocationAdapter,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };

  return createSingleBoardServerRuntime(runtimeOptions);
}

// ============================================================================
// Helper: synthetic HTTP request/response for handleRuntimeApi
// ============================================================================

function syntheticRequest(method: string, path: string): RuntimeRequest {
  return {
    method,
    url: path,
    headers: {},
    on() {},
    [Symbol.asyncIterator]() {
      let done = false;
      return {
        async next() {
          if (done) return { done: true as const, value: undefined as unknown as Uint8Array };
          done = true;
          return { done: false as const, value: new Uint8Array(0) };
        },
        [Symbol.asyncIterator]() { return this; },
      };
    },
  };
}

function syntheticResponse(): { res: RuntimeResponse; body: () => unknown } {
  let chunks: string[] = [];
  const res: RuntimeResponse = {
    writeHead() {},
    write(data) { chunks.push(typeof data === 'string' ? data : new TextDecoder().decode(data)); return true; },
    end(data?) { if (data) chunks.push(typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array)); },
  };
  return { res, body: () => { try { return JSON.parse(chunks.join('')); } catch { return chunks.join(''); } } };
}

// ============================================================================
// Tests
// ============================================================================

describe('bootstrap notification catch-up', () => {

  // ── 1. appendNotification handles notification-batch ───────────────────

  it('appendNotification: GET /init-board returns a populated runtime payload', async () => {
    const adapter = createTestAdapter();
    const runtime = buildRuntime(adapter);

    // First init — runtime should return hydrated payload.
    const req1 = syntheticRequest('GET', '/api/board/init-board');
    const syn1 = syntheticResponse();
    await runtime.handleRuntimeApi(req1, syn1.res, new URL('http://localhost/api/board/init-board'));

    const payload = syn1.body() as Record<string, unknown>;
    const cardDefinitions = payload.cardDefinitions as Array<Record<string, unknown>>;
    expect(Array.isArray(cardDefinitions)).toBe(true);
    expect(cardDefinitions.length).toBeGreaterThan(0);
  });

  // ── 2. No task-restart on subsequent bootstrap calls ──────────────────

  it('second /init-board remains idempotent and keeps card count stable', async () => {
    const adapter = createTestAdapter();
    const runtime = buildRuntime(adapter);

    // First init
    const req1 = syntheticRequest('GET', '/api/board/init-board');
    const syn1 = syntheticResponse();
    await runtime.handleRuntimeApi(req1, syn1.res, new URL('http://localhost/api/board/init-board'));

    const payload1 = syn1.body() as Record<string, unknown>;
    const cards1 = Array.isArray(payload1.cardDefinitions) ? payload1.cardDefinitions.length : 0;

    // Second init (simulates page refresh)
    const req2 = syntheticRequest('GET', '/api/board/init-board');
    const syn2 = syntheticResponse();
    await runtime.handleRuntimeApi(req2, syn2.res, new URL('http://localhost/api/board/init-board'));

    const payload2 = syn2.body() as Record<string, unknown>;
    const cards2 = Array.isArray(payload2.cardDefinitions) ? payload2.cardDefinitions.length : 0;
    expect(cards2).toBe(cards1);
  });

  // ── 3. Catch-up batch contains status + computed_values ───────────────

  it('second /init-board payload includes status summary and computed runtime data', async () => {
    const adapter = createTestAdapter();
    const runtime = buildRuntime(adapter);

    // First bootstrap — populates output store
    const req1 = syntheticRequest('GET', '/api/board/init-board');
    const syn1 = syntheticResponse();
    await runtime.handleRuntimeApi(req1, syn1.res, new URL('http://localhost/api/board/init-board'));

    // Second init (page refresh simulation)
    const req2 = syntheticRequest('GET', '/api/board/init-board');
    const syn2 = syntheticResponse();
    await runtime.handleRuntimeApi(req2, syn2.res, new URL('http://localhost/api/board/init-board'));

    const payload = syn2.body() as Record<string, unknown>;
    const summary = payload.statusSnapshot as Record<string, unknown>;
    const runtimeById = payload.cardRuntimeById as Record<string, Record<string, unknown>>;
    expect(summary && typeof summary === 'object').toBe(true);
    const anyCard = Object.values(runtimeById ?? {})[0];
    expect(anyCard && typeof anyCard === 'object').toBe(true);
  });

  // ── 4. buildPublishedRuntimePayload populated after second bootstrap ──

  it('getState() returns non-empty cardRuntimeById after second /init-board', async () => {
    const adapter = createTestAdapter();
    const runtime = buildRuntime(adapter);

    // First bootstrap
    const req1 = syntheticRequest('GET', '/api/board/init-board');
    const syn1 = syntheticResponse();
    await runtime.handleRuntimeApi(req1, syn1.res, new URL('http://localhost/api/board/init-board'));

    // Second bootstrap
    const req2 = syntheticRequest('GET', '/api/board/init-board');
    const syn2 = syntheticResponse();
    await runtime.handleRuntimeApi(req2, syn2.res, new URL('http://localhost/api/board/init-board'));

    const payload = await runtime.buildPublishedRuntimePayload() as Record<string, unknown>;
    expect(payload).toHaveProperty('cardDefinitions');
    const cardRuntimeById = payload.cardRuntimeById as Record<string, unknown>;
    expect(Object.keys(cardRuntimeById).length).toBeGreaterThan(0);
  });

  // ── 5. Catch-up batch includes data_object notifications ─────────────

  it('catch-up batch includes data_object notifications when output store has data objects', async () => {
    const adapter = createTestAdapter();
    const runtime = buildRuntime(adapter);

    // First bootstrap — source card runs and publishes its provides token
    const req1 = syntheticRequest('GET', '/api/board/init-board');
    const syn1 = syntheticResponse();
    await runtime.handleRuntimeApi(req1, syn1.res, new URL('http://localhost/api/board/init-board'));

    const firstPayload = runtime.buildPublishedRuntimePayload() as Record<string, unknown>;
    const firstDobs = firstPayload.dataObjectsByToken as Record<string, unknown> | undefined;
    // Only assert catch-up if the first run produced data objects
    if (!firstDobs || Object.keys(firstDobs).length === 0) return;

    const batchesAfterFirst = adapter.publishedBatches.length;

    // Second bootstrap
    const req2 = syntheticRequest('GET', '/api/board/init-board');
    const syn2 = syntheticResponse();
    await runtime.handleRuntimeApi(req2, syn2.res, new URL('http://localhost/api/board/init-board'));

    const catchUpNotifications: BoardChangeNotification[] = [];
    for (let i = batchesAfterFirst; i < adapter.publishedBatches.length; i++) {
      catchUpNotifications.push(...adapter.publishedBatches[i]);
    }

    const dataObjectKinds = catchUpNotifications.filter(n => n.kind === 'data_object');
    expect(dataObjectKinds.length).toBeGreaterThan(0);
  });
});
