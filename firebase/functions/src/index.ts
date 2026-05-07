/**
 * Firebase Cloud Functions entry point for yaml-flow board server.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SETUP
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *   1. cd firebase/functions && npm install
 *   2. Seed cards:  node scripts/seed-cards.mjs
 *   3. Local test:  npm run serve
 *   4. Deploy:      npm run deploy
 *
 * CONFIGURATION (set in .env or firebase functions:config):
 *   BOARD_ID          — board identifier (default: 'default')
 *   FUNCTION_URL      — public URL (auto-detected in v2)
 *   FUNCTION_REGION   — region (default: 'us-central1')
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FREE TIER NOTES
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Requires Blaze (pay-as-you-go) plan.  For low usage the monthly bill is $0:
 *   - Cloud Functions v2:  2 M calls, 400 K GB-s free
 *   - Firestore:           1 GiB, 50 K reads / 20 K writes per day
 *   - No Cloud Storage used — everything stored in Firestore
 *   - Billing account required but you pay nothing within free quotas
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { onRequest } from 'firebase-functions/v2/https';

// ── yaml-flow imports (from dist) ──────────────────────────────────────────
// These import from the yaml-flow source tree.
// In a production setup you'd publish yaml-flow to npm or use a local link.
// For now, the firebase/functions/package.json can reference a local path:
//   "yaml-flow": "file:../../"

import {
  createSingleBoardServerRuntime,
} from '../../src/server-runtime/index.js';
import type {
  SingleBoardRuntimeOptions,
  RuntimeRequest,
  RuntimeResponse,
  CardSourceAdapter,
  InvocationAdapter,
  ExecutionRef,
} from '../../src/server-runtime/types.js';
import type { KVStorage, BlobStorage, KindValueRef, AtomicRelayLock } from '../../src/cli/common/storage-interface.js';
import type { JournalStorageAdapter, JournalEntry } from '../../src/cli/common/board-live-cards-lib.js';
import type { BoardPlatformAdapter } from '../../src/cli/common/board-live-cards-public.js';

// ============================================================================
// Firebase init
// ============================================================================

const app = initializeApp();
const db = getFirestore(app);

// ============================================================================
// Firestore key encoding (doc IDs cannot contain '/')
// ============================================================================

function encodeKey(key: string): string {
  return key.replace(/%/g, '%25').replace(/\//g, '%2F').replace(/\./g, '%2E');
}
function decodeKey(encoded: string): string {
  return encoded.replace(/%2E/g, '.').replace(/%2F/g, '/').replace(/%25/g, '%');
}

// ============================================================================
// Cached Firestore KVStorage
//
// The board-live-cards-lib requires synchronous read/write on KVStorage.
// We solve this by pre-loading the entire collection into cache on warmUp(),
// then serving reads from cache and writing through to Firestore.
// ============================================================================

interface WarmFlushable { warmUp(): Promise<void>; flush(): Promise<void>; }

function createCachedKv(collectionPath: string): KVStorage & WarmFlushable {
  const col = db.collection(collectionPath);
  const cache = new Map<string, unknown>();
  const pending: Promise<unknown>[] = [];
  let warm = false;

  return {
    async warmUp() {
      const snap = await col.get();
      cache.clear();
      for (const doc of snap.docs) cache.set(decodeKey(doc.id), doc.data()?.value ?? null);
      warm = true;
    },
    async flush() { if (pending.length) { await Promise.all(pending); pending.length = 0; } },
    read(key) { return warm && cache.has(key) ? (cache.get(key) ?? null) : null; },
    write(key, value) {
      cache.set(key, value);
      pending.push(col.doc(encodeKey(key)).set({ value }).catch(() => {}));
    },
    delete(key) {
      cache.delete(key);
      pending.push(col.doc(encodeKey(key)).delete().catch(() => {}));
    },
    listKeys(prefix?: string) {
      const keys = [...cache.keys()];
      return prefix ? keys.filter(k => k.startsWith(prefix)) : keys;
    },
  };
}

// ============================================================================
// Cached Firestore BlobStorage
// ============================================================================

function createCachedBlob(collectionPath: string): BlobStorage & WarmFlushable {
  type Entry = { text?: string | null; bytes?: number[] | null; contentType?: string; size?: number; updatedAt?: string };
  const col = db.collection(collectionPath);
  const cache = new Map<string, Entry>();
  const pending: Promise<unknown>[] = [];

  const now = () => new Date().toISOString();

  return {
    async warmUp() {
      const snap = await col.get();
      cache.clear();
      for (const doc of snap.docs) cache.set(decodeKey(doc.id), doc.data() as Entry);
    },
    async flush() { if (pending.length) { await Promise.all(pending); pending.length = 0; } },
    read(key) {
      const e = cache.get(key);
      if (!e) return null;
      if (typeof e.text === 'string') return e.text;
      if (e.bytes && Array.isArray(e.bytes)) return new TextDecoder().decode(new Uint8Array(e.bytes));
      return null;
    },
    write(key, content) {
      const entry: Entry = { text: content, contentType: 'text/plain', size: new TextEncoder().encode(content).byteLength, updatedAt: now() };
      cache.set(key, entry);
      pending.push(col.doc(encodeKey(key)).set(entry).catch(() => {}));
    },
    exists(key) { return cache.has(key); },
    remove(key) {
      cache.delete(key);
      pending.push(col.doc(encodeKey(key)).delete().catch(() => {}));
    },
    readBytes(key) {
      const e = cache.get(key);
      if (!e) return null;
      if (e.bytes && Array.isArray(e.bytes)) return new Uint8Array(e.bytes);
      if (typeof e.text === 'string') return new TextEncoder().encode(e.text);
      return null;
    },
    writeBytes(key, content) {
      const entry: Entry = { bytes: [...content], contentType: 'application/octet-stream', size: content.byteLength, updatedAt: now() };
      cache.set(key, entry);
      pending.push(col.doc(encodeKey(key)).set(entry).catch(() => {}));
    },
    listKeys(prefix?: string) {
      const keys = [...cache.keys()];
      return prefix ? keys.filter(k => k.startsWith(prefix)) : keys;
    },
    stat(key) {
      const e = cache.get(key);
      if (!e) return null;
      return { key, size: e.size ?? 0, updatedAt: e.updatedAt, contentType: e.contentType };
    },
  };
}

// ============================================================================
// Cached Firestore JournalStorageAdapter
// ============================================================================

function createCachedJournal(collectionPath: string): JournalStorageAdapter & WarmFlushable {
  const col = db.collection(collectionPath);
  let entries: JournalEntry[] = [];
  const pending: Promise<unknown>[] = [];
  let counter = 0;

  return {
    async warmUp() {
      const snap = await col.orderBy('createdAt', 'asc').get();
      entries = snap.docs.map(d => ({ id: d.id, payload: d.data()?.payload }));
      counter = entries.length;
    },
    async flush() { if (pending.length) { await Promise.all(pending); pending.length = 0; } },
    readAllEntries() { return [...entries]; },
    appendEntry(entry) {
      entries.push(entry);
      pending.push(col.doc(entry.id).set({ payload: entry.payload, createdAt: Date.now() }).catch(() => {}));
    },
    generateId() {
      counter++;
      return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${String(counter).padStart(4, '0')}`;
    },
  };
}

// ============================================================================
// Firestore AtomicRelayLock (single-instance safe)
// ============================================================================

function createLock(docPath: string): AtomicRelayLock {
  let held = false;
  return {
    tryAcquire() {
      if (held) return null;
      held = true;
      db.doc(docPath).set({ heldBy: 'cf', at: Date.now() }).catch(() => {});
      return () => { held = false; db.doc(docPath).delete().catch(() => {}); };
    },
  };
}

// ============================================================================
// Firestore CardSourceAdapter — reads seed cards from collection
// ============================================================================

function createCardSource(boardId: string): CardSourceAdapter & WarmFlushable {
  const col = db.collection(process.env.CARDS_COLLECTION || `boards/${boardId}/seed-cards`);
  let cards: Array<Record<string, unknown>> = [];
  return {
    async warmUp() {
      const snap = await col.get();
      cards = snap.docs.map(d => { const data = d.data(); if (!data.id) data.id = d.id; return data as Record<string, unknown>; });
    },
    async flush() {},
    listCards() { return [...cards]; },
  };
}

// ============================================================================
// Build BoardPlatformAdapter from Firestore primitives
// ============================================================================

function createAdapter(boardId: string, functionUrl: string): {
  adapter: BoardPlatformAdapter;
  cardSource: CardSourceAdapter & WarmFlushable;
  allWarm: WarmFlushable[];
} {
  const base = `boards/${boardId}`;
  const allWarm: WarmFlushable[] = [];

  // Caches to avoid duplicates
  const kvMap = new Map<string, KVStorage & WarmFlushable>();
  const blobMap = new Map<string, BlobStorage & WarmFlushable>();

  function getKv(ns: string) {
    if (kvMap.has(ns)) return kvMap.get(ns)!;
    const s = createCachedKv(`${base}/kv/${ns}/entries`);
    kvMap.set(ns, s); allWarm.push(s);
    return s;
  }
  function getBlob(ns: string) {
    const key = ns || '_root';
    if (blobMap.has(key)) return blobMap.get(key)!;
    const s = createCachedBlob(`${base}/blobs/${key}/entries`);
    blobMap.set(key, s); allWarm.push(s);
    return s;
  }

  const journal = createCachedJournal(`${base}/journal/entries`);
  allWarm.push(journal);

  const lock = createLock(`${base}/locks/board-lock`);

  const selfRef: ExecutionRef = {
    meta: 'board-live-cards',
    howToRun: 'http:post' as const,
    whatToRun: `::http-url::${functionUrl}`,
  };

  function hashFn(value: unknown): string {
    const str = JSON.stringify(value, Object.keys(value && typeof value === 'object' ? value as Record<string, unknown> : {}).sort());
    let h = 0;
    for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
    return Math.abs(h).toString(16).padStart(8, '0');
  }

  function genId(): string {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`.slice(0, 32).padEnd(32, '0');
  }

  function kvStorageForRef(ref: string) {
    // Firebase only supports ::firestore:: kind refs
    if (ref.startsWith('::')) {
      const inner = ref.slice(2);
      const idx = inner.indexOf('::');
      if (idx !== -1) {
        const kind = inner.slice(0, idx);
        const value = inner.slice(idx + 2);
        if (kind === 'firestore') {
          const safeName = value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-60);
          return getKv(`_ref/${safeName}`);
        }
        // Reject fs-path and other non-firestore kinds
        throw new Error(`Unsupported ref kind "${kind}" on Firebase. Use ::firestore:: refs.`);
      }
    }
    // Plain string ref — treat as Firestore namespace
    const safeName = ref.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-60);
    return getKv(`_ref/${safeName}`);
  }

  const adapter: BoardPlatformAdapter = {
    kvStorage: (ns) => getKv(ns),
    kvStorageForRef,
    blobStorage: (ns) => getBlob(ns),
    journalAdapter: () => journal,
    lock,
    selfRef,
    async dispatchExecution(ref, args) {
      if (ref.howToRun === 'http:post' || ref.howToRun === 'http:get') {
        let url = ref.whatToRun;
        if (url.startsWith('::')) { const i = url.indexOf('::', 2); if (i !== -1) url = url.slice(i + 2); }
        const method = ref.howToRun === 'http:get' ? 'GET' : 'POST';
        const opts: RequestInit = { method };
        if (method === 'POST') { opts.headers = { 'Content-Type': 'application/json' }; opts.body = JSON.stringify(args); }
        fetch(url, opts).catch(() => {});
        return { dispatched: true };
      }
      return { dispatched: false, error: `Unsupported howToRun "${ref.howToRun}" on Firebase` };
    },
    resolveBlob(ref) {
      const blob = getBlob('_root');
      const content = blob.read(ref.value);
      if (content === null) throw new Error(`Blob not found: ${ref.kind}::${ref.value}`);
      return content;
    },
    hashFn,
    genId,
    onWarn: (msg) => console.warn(`[board:${BOARD_ID}]`, msg),
  };

  const cardSource = createCardSource(boardId);
  allWarm.push(cardSource);

  return { adapter, cardSource, allWarm };
}

// ============================================================================
// Request / Response adapters (Express ↔ RuntimeRequest / RuntimeResponse)
// ============================================================================

function adaptReq(req: Parameters<Parameters<typeof onRequest>[1]>[0]): RuntimeRequest {
  return {
    method: req.method,
    url: req.url,
    headers: req.headers as Record<string, string | string[] | undefined>,
    on(event, listener) { (req as any).on(event, listener); },
    [Symbol.asyncIterator]() {
      const body = (req as any).rawBody || Buffer.from(JSON.stringify(req.body || {}));
      let done = false;
      return {
        next() {
          if (done) return Promise.resolve({ value: undefined as any, done: true as const });
          done = true;
          return Promise.resolve({ value: body as Buffer, done: false as const });
        },
        return() { return Promise.resolve({ value: undefined as any, done: true as const }); },
        throw(e: unknown) { return Promise.reject(e); },
        [Symbol.asyncIterator]() { return this; },
      };
    },
  };
}

function adaptRes(res: Parameters<Parameters<typeof onRequest>[1]>[1]): RuntimeResponse {
  return {
    writeHead(status, headers) {
      res.status(status);
      if (headers) for (const [k, v] of Object.entries(headers)) res.set(k, String(v));
    },
    write(data) { res.write(data); return true; },
    end(data?) { data ? res.send(data) : res.end(); },
  };
}

// ============================================================================
// Configuration
// ============================================================================

const BOARD_ID = process.env.BOARD_ID || 'default';

// ============================================================================
// Cloud Function (v2 HTTP)
// ============================================================================

export const boardApi = onRequest(
  {
    region: process.env.FUNCTION_REGION || 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 60,
    maxInstances: 1,
    minInstances: 0,
    concurrency: 10,
  },
  async (req, res) => {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'content-type,x-file-name',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
      });
      res.status(204).send('');
      return;
    }

    const functionUrl = process.env.FUNCTION_URL || `https://${req.hostname}${(req as any).baseUrl || ''}`;

    try {
      const { adapter, cardSource, allWarm } = createAdapter(BOARD_ID, functionUrl);

      // Warm all Firestore caches
      await Promise.all(allWarm.map(w => w.warmUp()));

      const runtime = createSingleBoardServerRuntime({
        apiBasePath: '/api/board',
        boardId: BOARD_ID,
        base: {
          label: 'base',
          boardAdapter: adapter,
          baseRef: { kind: 'firestore', value: `boards/${BOARD_ID}` },
          cardStoreRef: `::firestore::boards/${BOARD_ID}/card-store`,
          outputsStoreRef: `::firestore::boards/${BOARD_ID}/outputs`,
          cardSource,
        },
        invocationAdapter: { invoke: (ref, args) => adapter.dispatchExecution(ref, args) },
        logger: {
          info: (...a: unknown[]) => console.log(`[${BOARD_ID}]`, ...a),
          warn: (...a: unknown[]) => console.warn(`[${BOARD_ID}]`, ...a),
          error: (...a: unknown[]) => console.error(`[${BOARD_ID}]`, ...a),
        },
        serverUrl: functionUrl,
      });

      const url = new URL(req.url, `https://${req.hostname}`);
      const handled = await runtime.handleRuntimeApi(adaptReq(req), adaptRes(res), url);

      // Flush all pending writes
      await Promise.all(allWarm.map(w => w.flush()));

      if (!handled) {
        res.status(404).json({
          error: 'Not found',
          endpoints: [
            'GET /api/board/bootstrap',
            'GET /api/board/board-status',
            'GET /api/board/sse',
            'PATCH /api/board/cards/:id',
            'POST /api/board/cards/:id/actions',
            'GET /api/board/cards/:id/chats',
            'POST /api/board/cards/:id/files',
          ],
        });
      }
    } catch (err: unknown) {
      console.error(`[${BOARD_ID}] error:`, err);
      if (!res.headersSent) res.status(500).json({ error: (err as Error)?.message || 'Internal error' });
    }
  },
);
