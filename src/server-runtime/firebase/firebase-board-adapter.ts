/**
 * firebase-board-adapter.ts
 *
 * Constructs a BoardPlatformAdapter backed entirely by Firestore.
 * Used by the Firebase Cloud Function host to wire into the platform-free runtime.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * FREE TIER VIABILITY
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * All storage is Firestore — no Cloud Storage / GCS dependency.
 * Firestore free quota: 1 GiB storage, 50 K reads, 20 K writes per day.
 *
 * Binary file uploads are stored as byte arrays in Firestore documents.
 * Firestore max document size is 1 MiB. For files > ~800 KB the adapter
 * would need chunking or GCS fallback. For most board use cases (small
 * YAML/JSON cards, chat text, small file attachments) this is sufficient.
 *
 * Cloud Functions v2 (Blaze plan): 2 M invocations/month free.
 * A billing account is required but charges are $0 within free quotas.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { BoardPlatformAdapter } from '../../cli/common/board-live-cards-public.js';
import type { KindValueRef } from '../../cli/common/storage-interface.js';
import type { ExecutionRef } from '../../cli/common/execution-interface.js';
import {
  createCachedFirestoreKvStorage,
  createCachedFirestoreBlobStorage,
  createCachedFirestoreJournalAdapter,
  createFirestoreAtomicRelayLock,
} from './firestore-adapters.js';

// ============================================================================
// Flushable — adapters that need warmUp/flush lifecycle
// ============================================================================

export interface Flushable {
  warmUp(): Promise<void>;
  flush(): Promise<void>;
}

// ============================================================================
// createFirebaseBoardPlatformAdapter
// ============================================================================

export interface FirebaseBoardAdapterOptions {
  db: Firestore;
  boardId: string;

  /**
   * The public HTTPS URL of this Cloud Function.
   * Used as the selfRef so executors can call back.
   * e.g. 'https://us-central1-my-project.cloudfunctions.net/boardApi'
   */
  functionUrl: string;

  /**
   * Optional: custom dispatch for ExecutionRefs.
   * If not provided, only 'http:post' and 'http:get' refs are dispatched
   * (via fetch). Local node/python refs are skipped with a warning.
   */
  dispatchOverride?: (ref: ExecutionRef, args: Record<string, unknown>) => Promise<{ dispatched: boolean; error?: string }>;

  /** Optional warn sink */
  onWarn?: (msg: string) => void;
}

export interface FirebaseBoardAdapter {
  adapter: BoardPlatformAdapter;
  /** Call at start of request to load Firestore data into cache */
  warmUp(): Promise<void>;
  /** Call at end of request to flush pending Firestore writes */
  flush(): Promise<void>;
}

export function createFirebaseBoardPlatformAdapter(
  opts: FirebaseBoardAdapterOptions,
): FirebaseBoardAdapter {
  const { db, boardId, functionUrl, dispatchOverride, onWarn } = opts;
  const basePath = `boards/${boardId}`;

  // Track all flushable stores created during this request
  const flushables: Flushable[] = [];

  function makeKv(namespace: string) {
    const store = createCachedFirestoreKvStorage(db, `${basePath}/kv/${namespace}/entries`);
    flushables.push(store);
    return store;
  }

  function makeBlobStorage(namespace: string) {
    const path = namespace ? `${basePath}/blobs/${namespace}/entries` : `${basePath}/blobs/_root/entries`;
    const store = createCachedFirestoreBlobStorage(db, path);
    flushables.push(store);
    return store;
  }

  const journalAdapter = createCachedFirestoreJournalAdapter(db, `${basePath}/journal/entries`);
  flushables.push(journalAdapter);

  const lock = createFirestoreAtomicRelayLock(db, `${basePath}/locks/board-lock`);

  // Cache of created stores (avoid duplicates for same namespace)
  const kvCache = new Map<string, ReturnType<typeof createCachedFirestoreKvStorage>>();
  const blobCache = new Map<string, ReturnType<typeof createCachedFirestoreBlobStorage>>();

  function getKv(namespace: string) {
    if (kvCache.has(namespace)) return kvCache.get(namespace)!;
    const store = makeKv(namespace);
    kvCache.set(namespace, store);
    return store;
  }

  function getBlobStorage(namespace: string) {
    if (blobCache.has(namespace)) return blobCache.get(namespace)!;
    const store = makeBlobStorage(namespace);
    blobCache.set(namespace, store);
    return store;
  }

  // kvStorageForRef: Firebase only supports ::firestore:: kind refs
  function kvStorageForRef(ref: string): ReturnType<typeof createCachedFirestoreKvStorage> {
    if (ref.startsWith('::')) {
      const inner = ref.slice(2);
      const idx = inner.indexOf('::');
      if (idx !== -1) {
        const kind = inner.slice(0, idx);
        const value = inner.slice(idx + 2);
        if (kind === 'firestore') {
          return getKv(`_ref/${value}`);
        }
        throw new Error(`Unsupported ref kind "${kind}" on Firebase. Use ::firestore:: refs.`);
      }
    }
    // Plain string ref — treat as Firestore namespace
    const safeName = ref.replace(/[^a-zA-Z0-9_-]/g, '_').slice(-60);
    return getKv(`_ref/${safeName}`);
  }

  const selfRef: ExecutionRef = {
    meta: 'board-live-cards',
    howToRun: 'http:post' as const,
    whatToRun: `::http-url::${functionUrl}`,
  };

  function computeHash(value: unknown): string {
    // Simple deterministic hash for Firestore — no crypto dependency
    const str = JSON.stringify(value, Object.keys(value && typeof value === 'object' ? value as Record<string, unknown> : {}).sort());
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash |= 0; // 32-bit integer
    }
    return Math.abs(hash).toString(16).padStart(8, '0');
  }

  function genId(): string {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(36).slice(2, 10);
    return `${ts}${rand}`.slice(0, 32).padEnd(32, '0');
  }

  async function dispatchExecution(
    ref: ExecutionRef,
    args: Record<string, unknown>,
  ): Promise<{ dispatched: boolean; error?: string }> {
    if (dispatchOverride) return dispatchOverride(ref, args);

    const howToRun = ref.howToRun;
    if (howToRun === 'http:post' || howToRun === 'http:get') {
      const urlRef = ref.whatToRun;
      let url = urlRef;
      if (urlRef.startsWith('::')) {
        const inner = urlRef.slice(2);
        const idx = inner.indexOf('::');
        if (idx !== -1) url = inner.slice(idx + 2);
      }

      try {
        const method = howToRun === 'http:get' ? 'GET' : 'POST';
        const fetchOpts: RequestInit = { method };
        if (method === 'POST') {
          fetchOpts.headers = { 'Content-Type': 'application/json' };
          fetchOpts.body = JSON.stringify(args);
        }
        // Fire-and-forget: don't await the response body
        fetch(url, fetchOpts).catch((err) => {
          onWarn?.(`dispatchExecution fetch error: ${err?.message || err}`);
        });
        return { dispatched: true };
      } catch (err: unknown) {
        return { dispatched: false, error: (err as Error)?.message || String(err) };
      }
    }

    // local-node, local-python, local-process — cannot run on Firebase
    if (howToRun === 'built-in') {
      // Built-in handlers could be supported if registered
      return { dispatched: false, error: `built-in handler not registered: ${ref.whatToRun}` };
    }

    onWarn?.(`Cannot dispatch ${howToRun} execution on Firebase. Only http:post/http:get are supported.`);
    return { dispatched: false, error: `Unsupported howToRun "${howToRun}" on Firebase. Use http:post or http:get.` };
  }

  function resolveBlob(ref: KindValueRef): string {
    if (ref.kind === 'firestore') {
      const blobStore = getBlobStorage('_root');
      const content = blobStore.read(ref.value);
      if (content === null) throw new Error(`Blob not found: ${ref.kind}::${ref.value}`);
      return content;
    }
    throw new Error(`Cannot resolve blob ref kind "${ref.kind}" on Firebase. Use "firestore" kind.`);
  }

  const adapter: BoardPlatformAdapter = {
    kvStorage: (namespace) => getKv(namespace),
    kvStorageForRef,
    blobStorage: (namespace) => getBlobStorage(namespace),
    journalAdapter: () => journalAdapter,
    lock,
    selfRef,
    dispatchExecution,
    resolveBlob,
    hashFn: computeHash,
    genId,
    onWarn,
  };

  return {
    adapter,
    async warmUp() {
      // Warm up all stores in parallel
      await Promise.all(flushables.map(f => f.warmUp()));
    },
    async flush() {
      await Promise.all(flushables.map(f => f.flush()));
    },
  };
}
