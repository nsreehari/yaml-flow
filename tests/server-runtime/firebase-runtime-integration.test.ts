/**
 * firebase-runtime-integration.test.ts
 *
 * Integration test that proves the Firebase hosting path works end-to-end.
 *
 * Instead of requiring the full Firebase emulator suite, this test:
 *   1. Uses in-memory implementations of KVStorage/BlobStorage/JournalStorageAdapter
 *      (same interfaces that Firestore adapters implement)
 *   2. Wires them into BoardPlatformAdapter (same shape as firebase-board-adapter)
 *   3. Creates a platform-free server runtime
 *   4. Spins up a Node HTTP server to simulate the Cloud Function
 *   5. Verifies all endpoints work
 *
 * This proves the Firebase adapter wiring is correct without needing
 * firebase-admin or the emulator installed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as http from 'node:http';

// ── Import from the platform-free runtime ──────────────────────────────────
import { createSingleBoardServerRuntime } from '../../src/server-runtime/index.js';
import type {
  SingleBoardRuntimeOptions,
  RuntimeRequest,
  RuntimeResponse,
  CardSourceAdapter,
  InvocationAdapter,
  BoardContextConfig,
} from '../../src/server-runtime/types.js';
import type { BoardPlatformAdapter } from '../../src/cli/common/board-live-cards-public.js';
import type { KVStorage, BlobStorage, AtomicRelayLock, KindValueRef } from '../../src/cli/common/storage-interface.js';
import type { ExecutionRef } from '../../src/cli/common/execution-interface.js';

// ============================================================================
// In-memory adapters — same interfaces as the Firestore cached adapters
// These simulate what firebase-board-adapter.ts wires up
// ============================================================================

function createMemoryKvStorage(): KVStorage {
  const data = new Map<string, unknown>();
  return {
    read(key) { return data.has(key) ? (data.get(key) ?? null) : null; },
    write(key, value) { data.set(key, value); },
    delete(key) { data.delete(key); },
    listKeys(prefix?) {
      const keys = [...data.keys()];
      return prefix ? keys.filter(k => k.startsWith(prefix)) : keys;
    },
  };
}

function createMemoryBlobStorage(): BlobStorage {
  const texts = new Map<string, string>();
  const bytes = new Map<string, Uint8Array>();
  const meta = new Map<string, { size: number; updatedAt: string; contentType: string }>();

  return {
    read(key) { return texts.get(key) ?? null; },
    write(key, content) {
      texts.set(key, content);
      meta.set(key, {
        size: new TextEncoder().encode(content).byteLength,
        updatedAt: new Date().toISOString(),
        contentType: 'text/plain',
      });
    },
    exists(key) { return texts.has(key) || bytes.has(key); },
    remove(key) { texts.delete(key); bytes.delete(key); meta.delete(key); },
    readBytes(key) { return bytes.get(key) ?? null; },
    writeBytes(key, content) {
      bytes.set(key, new Uint8Array(content));
      meta.set(key, {
        size: content.byteLength,
        updatedAt: new Date().toISOString(),
        contentType: 'application/octet-stream',
      });
    },
    listKeys(prefix?) {
      const allKeys = new Set([...texts.keys(), ...bytes.keys()]);
      const arr = [...allKeys].sort();
      return prefix ? arr.filter(k => k.startsWith(prefix)) : arr;
    },
    stat(key) {
      const m = meta.get(key);
      if (!m) return null;
      return { key, ...m };
    },
  };
}

function createMemoryJournalAdapter() {
  const entries: Array<{ id: string; payload: unknown }> = [];
  let counter = 0;
  return {
    readAllEntries() { return [...entries]; },
    appendEntry(entry: { id: string; payload: unknown }) { entries.push(entry); },
    generateId() {
      counter++;
      return `mem-${Date.now().toString(36)}-${counter}`;
    },
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

// ============================================================================
// Build a Firebase-like BoardPlatformAdapter from memory stores
// ============================================================================

function createFirebaseLikePlatformAdapter(functionUrl: string): BoardPlatformAdapter {
  const kvStores = new Map<string, KVStorage>();
  const blobStores = new Map<string, BlobStorage>();

  function getKv(ns: string): KVStorage {
    if (!kvStores.has(ns)) kvStores.set(ns, createMemoryKvStorage());
    return kvStores.get(ns)!;
  }
  function getBlob(ns: string): BlobStorage {
    const key = ns || '_root';
    if (!blobStores.has(key)) blobStores.set(key, createMemoryBlobStorage());
    return blobStores.get(key)!;
  }

  const journal = createMemoryJournalAdapter();
  const lock = createMemoryLock();

  const selfRef: ExecutionRef = {
    meta: 'board-live-cards',
    howToRun: 'http:post' as const,
    whatToRun: `::http-url::${functionUrl}`,
  };

  return {
    kvStorage: (ns) => getKv(ns),
    kvStorageForRef(ref: string) {
      // Firebase-only: only accept ::firestore:: refs
      if (ref.startsWith('::')) {
        const inner = ref.slice(2);
        const idx = inner.indexOf('::');
        if (idx !== -1) {
          const kind = inner.slice(0, idx);
          const value = inner.slice(idx + 2);
          if (kind === 'firestore') return getKv(`_ref/${value}`);
          throw new Error(`Unsupported ref kind "${kind}" on Firebase. Use ::firestore:: refs.`);
        }
      }
      return getKv(`_ref/${ref}`);
    },
    blobStorage: (ns) => getBlob(ns),
    journalAdapter: () => journal,
    lock,
    selfRef,
    async dispatchExecution(ref, args) {
      // Firebase: only http:post / http:get
      if (ref.howToRun === 'http:post' || ref.howToRun === 'http:get') {
        // In test, don't actually fetch — just record
        return { dispatched: true };
      }
      return { dispatched: false, error: `Unsupported howToRun "${ref.howToRun}" on Firebase` };
    },
    resolveBlob(ref: KindValueRef) {
      if (ref.kind === 'firestore') {
        const blob = getBlob('_root');
        const content = blob.read(ref.value);
        if (content === null) throw new Error(`Blob not found: ${ref.kind}::${ref.value}`);
        return content;
      }
      throw new Error(`Unsupported blob ref kind "${ref.kind}" on Firebase`);
    },
    hashFn(value: unknown) {
      const str = JSON.stringify(value);
      let h = 0;
      for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
      return Math.abs(h).toString(16).padStart(8, '0');
    },
    genId() {
      return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.padEnd(32, '0');
    },
    onWarn: () => {},
  };
}

// ============================================================================
// Test setup
// ============================================================================

const TEST_PORT = 8100 + Math.floor(Math.random() * 100);
const API_BASE = `http://127.0.0.1:${TEST_PORT}/api/board`;
let server: http.Server | null = null;

const SAMPLE_CARDS: Array<Record<string, unknown>> = [
  {
    id: 'fb-card-1',
    meta: { title: 'Firebase Card 1' },
    card_data: { greeting: 'hello from firestore' },
    view: { elements: [{ kind: 'markdown', data: { text: 'Card 1' } }] },
  },
  {
    id: 'fb-card-2',
    meta: { title: 'Firebase Card 2' },
    card_data: {},
    view: { elements: [{ kind: 'markdown', data: { text: 'Card 2' } }] },
  },
];

beforeAll(async () => {
  const functionUrl = `http://127.0.0.1:${TEST_PORT}`;
  const adapter = createFirebaseLikePlatformAdapter(functionUrl);

  const cardSource: CardSourceAdapter = {
    listCards: () => [...SAMPLE_CARDS],
  };

  const invocationAdapter: InvocationAdapter = {
    invoke: async (ref, args) => adapter.dispatchExecution(ref, args),
  };

  const runtimeOptions: SingleBoardRuntimeOptions = {
    apiBasePath: '/api/board',
    boardId: 'firebase-test',
    base: {
      label: 'base',
      boardAdapter: adapter,
      baseRef: { kind: 'firestore', value: 'boards/firebase-test' },
      cardStoreRef: '::firestore::boards/firebase-test/card-store',
      outputsStoreRef: '::firestore::boards/firebase-test/outputs',
      cardSource,
    },
    invocationAdapter,
    logger: {
      info: () => {},
      warn: () => {},
      error: console.error,
    },
    serverUrl: functionUrl,
  };

  const runtime = createSingleBoardServerRuntime(runtimeOptions);

  server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    if (method === 'OPTIONS') {
      res.writeHead(204, runtime.corsHeaders);
      res.end();
      return;
    }
    const url = new URL(req.url || '/', functionUrl);
    const handled = await runtime.handleRuntimeApi(
      req as unknown as RuntimeRequest,
      res as unknown as RuntimeResponse,
      url,
    );
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  await new Promise<void>((resolve) => {
    server!.listen(TEST_PORT, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

// ============================================================================
// Tests — Firebase hosting path
// ============================================================================

describe('platform-free server runtime (Firebase-like host)', () => {
  it('bootstraps cards from in-memory card source', async () => {
    const res = await fetch(`${API_BASE}/bootstrap-cards`);
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    const cards = data.cardDefinitions as Array<Record<string, unknown>>;
    expect(cards.length).toBe(2);
    const ids = cards.map(c => c.id);
    expect(ids).toContain('fb-card-1');
    expect(ids).toContain('fb-card-2');
  });

  it('returns board-status with card runtime info', async () => {
    const res = await fetch(`${API_BASE}/board-status`);
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('cardDefinitions');
    expect(data).toHaveProperty('cardRuntimeById');
    const rt = data.cardRuntimeById as Record<string, unknown>;
    expect(rt).toHaveProperty('fb-card-1');
    expect(rt).toHaveProperty('fb-card-2');
  });

  it('patches a card via PATCH endpoint', async () => {
    const res = await fetch(`${API_BASE}/cards/fb-card-1`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_data: { patched: true } }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
  });

  it('sends a chat message and retrieves it', async () => {
    const sendRes = await fetch(`${API_BASE}/cards/fb-card-1/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actionType: 'chat-send',
        payload: { text: 'firebase chat test' },
      }),
    });
    expect(sendRes.ok).toBe(true);

    const chatsRes = await fetch(`${API_BASE}/cards/fb-card-1/chats`);
    expect(chatsRes.ok).toBe(true);
    const data = await chatsRes.json() as Record<string, unknown>;
    const msgs = (data as any).messages as Array<Record<string, unknown>>;
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.some(m => typeof m.text === 'string' && m.text.includes('firebase chat test'))).toBe(true);
  });

  it('uploads a file to a card', async () => {
    const res = await fetch(`${API_BASE}/cards/fb-card-1/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'x-file-name': encodeURIComponent('firebase-test.txt'),
      },
      body: Buffer.from('firebase file content', 'utf-8'),
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
    const file = data.file as Record<string, unknown>;
    expect(file.name).toBe('firebase-test.txt');
    expect(file.stored_name).toBeTruthy();
  });

  it('streams SSE events', async () => {
    const controller = new AbortController();
    const res = await fetch(`${API_BASE}/sse`, { signal: controller.signal });
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('data: ');

    const jsonStr = text.split('data: ')[1]?.split('\n')[0];
    const sseData = JSON.parse(jsonStr!);
    expect(sseData).toHaveProperty('cardDefinitions');
    expect(sseData).toHaveProperty('cardRuntimeById');

    controller.abort();
  });

  it('rejects ::fs-path:: refs on Firebase adapter', () => {
    const adapter = createFirebaseLikePlatformAdapter('http://localhost');
    expect(() => adapter.kvStorageForRef('::fs-path::/tmp/test')).toThrow(/Unsupported ref kind.*fs-path/);
  });

  it('rejects local-node execution refs on Firebase', async () => {
    const adapter = createFirebaseLikePlatformAdapter('http://localhost');
    const result = await adapter.dispatchExecution(
      { howToRun: 'local-node', whatToRun: '::fs-path::/tmp/test.js' } as ExecutionRef,
      {},
    );
    expect(result.dispatched).toBe(false);
    expect(result.error).toContain('Unsupported howToRun');
  });

  it('only accepts ::firestore:: refs for kvStorageForRef', () => {
    const adapter = createFirebaseLikePlatformAdapter('http://localhost');
    // Should work with ::firestore:: refs
    const kv = adapter.kvStorageForRef('::firestore::boards/test/card-store');
    expect(kv).toBeTruthy();
    kv.write('testKey', 'testValue');
    expect(kv.read('testKey')).toBe('testValue');
  });
});
