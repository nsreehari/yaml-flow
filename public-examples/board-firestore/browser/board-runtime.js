/**
 * board-firestore/browser/board-runtime.js
 *
 * Shows how to instantiate the ServerRuntimeControlface IIFE in a browser
 * backed by the Firebase JS SDK (v9 modular) instead of the Admin SDK.
 *
 * This file is NOT bundled — it is a plain ES module that your build tool
 * (Vite, webpack, etc.) would process. Import it from your SPA's main entry.
 *
 * Architecture:
 *   Browser <──Firestore JS SDK──> Cloud Firestore
 *       │                                │
 *       │  ServerRuntimeControlface      │
 *       └── createSingleBoardServerRuntime() reads/writes Firestore directly
 *
 * The worker (server/worker.js) runs the queue lanes and can process AI card
 * requests without exposing any service account credentials to the browser.
 */

import { initializeApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  getDocs,
} from 'firebase/firestore';

// ── IMPORTANT: ServerRuntimeControlface is loaded as a browser IIFE ───────────
// Add this to your HTML: <script src="/browser/server-runtime-controlface.js"></script>
// Then window.ServerRuntimeControlface is available.
const { createSingleBoardServerRuntime } = window.ServerRuntimeControlface;

// ── Firebase config — replace with your project values ────────────────────────
const firebaseConfig = {
  apiKey: 'YOUR_API_KEY',
  authDomain: 'YOUR_PROJECT.firebaseapp.com',
  projectId: 'YOUR_PROJECT_ID',
  storageBucket: 'YOUR_PROJECT.appspot.com',
  appId: 'YOUR_APP_ID',
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const BOARD_ID = 'default';

// ── Browser-compatible base64url helpers ───────────────────────────────────────
function encodeDocId(key) {
  return btoa(encodeURIComponent(key).replace(/%([0-9A-F]{2})/g, (_, p1) => String.fromCharCode(parseInt(p1, 16))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeRef(kind, value) {
  const json = JSON.stringify({ kind, value });
  const b64 = btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `b64:${b64}`;
}

// ── Minimal Firestore KV adapter for the browser (Firebase JS SDK) ─────────────
function createBrowserKvStorage(colRef) {
  return {
    async read(key) {
      const snap = await getDoc(doc(colRef, encodeDocId(key)));
      if (!snap.exists()) return null;
      return snap.data()?.value ?? null;
    },
    async write(key, value) {
      await setDoc(doc(colRef, encodeDocId(key)), { k: key, value });
    },
    async delete(key) {
      await deleteDoc(doc(colRef, encodeDocId(key)));
    },
    async listKeys(prefix = '') {
      let q = colRef;
      if (prefix) {
        q = query(colRef, where('k', '>=', prefix), where('k', '<', prefix + '\uf8ff'), orderBy('k'));
      } else {
        q = query(colRef, orderBy('k'));
      }
      const snap = await getDocs(q);
      return snap.docs.map((d) => d.data().k ?? d.id);
    },
  };
}

// ── Minimal Firestore blob adapter for the browser ────────────────────────────
function createBrowserBlobStorage(colRef) {
  return {
    async read(key) {
      const snap = await getDoc(doc(colRef, encodeDocId(key)));
      if (!snap.exists()) return null;
      return snap.data()?.content ?? null;
    },
    async write(key, content) {
      await setDoc(doc(colRef, encodeDocId(key)), { k: key, content });
    },
    async exists(key) {
      const snap = await getDoc(doc(colRef, encodeDocId(key)));
      return snap.exists();
    },
    async remove(key) {
      await deleteDoc(doc(colRef, encodeDocId(key)));
    },
    async listKeys(prefix = '') {
      let q = prefix
        ? query(colRef, where('k', '>=', prefix), where('k', '<', prefix + '\uf8ff'), orderBy('k'))
        : query(colRef, orderBy('k'));
      const snap = await getDocs(q);
      return snap.docs.map((d) => d.data().k ?? d.id);
    },
  };
}

// ── Board platform adapter shim for browser use ────────────────────────────────
// NOTE: The browser adapter is read-heavy (renders current card state) and
// delegates writes to the worker. The runtime will route execution dispatch
// to the worker via HTTP if you configure invocationAdapter with an http:post ref.
function createBrowserFirestoreAdapter() {
  const boardDoc = (name) => collection(db, 'boards', BOARD_ID, name);

  return {
    kvStorage: (namespace) => createBrowserKvStorage(boardDoc(`kv-${namespace || 'root'}`)),
    kvStorageForRef: (ref) => createBrowserKvStorage(boardDoc('kv-root')),
    blobStorage: (namespace) => createBrowserBlobStorage(boardDoc(`blobs-${namespace || 'root'}`)),
    scratchStorage: () => ({
      ...createBrowserBlobStorage(boardDoc('scratch')),
      getUniqueKey: (prefix = 'scratch-') => `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`,
      create: async (data, prefix = 'scratch-') => {
        const key = `${prefix}${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await createBrowserBlobStorage(boardDoc('scratch')).write(key, data);
        return key;
      },
      keyRef: (key) => ({ kind: 'firestore-blob', value: key }),
      config: {
        get: async (k) => {
          const v = await createBrowserBlobStorage(boardDoc('scratch')).read(`__config__/${k}`);
          if (v == null) return null;
          try { return JSON.parse(v); } catch { return v; }
        },
        set: async (k, v) =>
          createBrowserBlobStorage(boardDoc('scratch')).write(`__config__/${k}`, JSON.stringify(v)),
      },
    }),
    scratchStorageForRef: () => ({ read: async () => null, write: async () => {}, exists: async () => false, remove: async () => {}, listKeys: async () => [], getUniqueKey: () => `${Date.now()}`, create: async () => `${Date.now()}`, keyRef: () => ({ kind: 'unknown', value: '' }), config: { get: async () => null, set: async () => {} } }),
    journalStorage: () => ({
      append: async (payload) => {
        const id = `${String(Date.now()).padStart(13, '0')}-${Math.random().toString(36).slice(2, 10)}`;
        await setDoc(doc(db, 'boards', BOARD_ID, 'journal', id), { id, createdAt: new Date().toISOString(), payload });
        return { id, payload };
      },
      readAll: async () => {
        const snap = await getDocs(query(collection(db, 'boards', BOARD_ID, 'journal'), orderBy('id')));
        return snap.docs.map((d) => ({ id: d.data().id, payload: d.data().payload }));
      },
      readAfter: async (cursor) => {
        let q = cursor
          ? query(collection(db, 'boards', BOARD_ID, 'journal'), where('id', '>', cursor), orderBy('id'))
          : query(collection(db, 'boards', BOARD_ID, 'journal'), orderBy('id'));
        const snap = await getDocs(q);
        const entries = snap.docs.map((d) => ({ id: d.data().id, payload: d.data().payload }));
        return { entries, newCursor: entries.at(-1)?.id ?? cursor };
      },
    }),
    archiveFactory: () => ({
      stream: (name) => ({
        append: async (payload) => {
          const id = `${String(Date.now()).padStart(13, '0')}-${Math.random().toString(36).slice(2, 10)}`;
          await setDoc(doc(db, 'boards', BOARD_ID, `archive-stream-${name}`, id), { id, createdAt: new Date().toISOString(), payload });
          return { id, payload };
        },
        readAll: async () => {
          const snap = await getDocs(query(collection(db, 'boards', BOARD_ID, `archive-stream-${name}`), orderBy('id')));
          return snap.docs.map((d) => ({ id: d.data().id, payload: d.data().payload }));
        },
        readAfter: async (cursor) => {
          const q = cursor
            ? query(collection(db, 'boards', BOARD_ID, `archive-stream-${name}`), where('id', '>', cursor), orderBy('id'))
            : query(collection(db, 'boards', BOARD_ID, `archive-stream-${name}`), orderBy('id'));
          const snap = await getDocs(q);
          const entries = snap.docs.map((d) => ({ id: d.data().id, payload: d.data().payload }));
          return { entries, newCursor: entries.at(-1)?.id ?? cursor };
        },
      }),
      blob: (name) => createBrowserBlobStorage(collection(db, 'boards', BOARD_ID, `archive-blob-${name}`)),
      listStreams: async () => [],   // Not available in JS SDK — use Admin SDK or maintain an index
      listBlobs: async () => [],
      config: {
        get: async (k) => { const s = await getDoc(doc(db, 'boards', BOARD_ID, 'archive-config', 'main')); return s.data()?.[k] ?? null; },
        set: async (k, v) => setDoc(doc(db, 'boards', BOARD_ID, 'archive-config', 'main'), { [k]: v }, { merge: true }),
      },
    }),
    archiveFactoryForRef: () => null,

    // Queue storage: browser-side is read-only; the worker handles leasing
    // Use null for browser-only apps; the worker processes queued tasks.
    boardWorkerStore: () => null,
    chatAgentStore: () => null,
    processAccumulatedStore: () => null,

    // Lock: no-op in browser (worker holds the real lock)
    lock: { tryAcquire: async () => async () => {} },

    hashFn: (value) => {
      // Browser-safe hash (djb2 — for display only, not crypto security)
      const str = JSON.stringify(value);
      let hash = 5381;
      for (let i = 0; i < str.length; i++) hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
      return (hash >>> 0).toString(16).padStart(8, '0');
    },

    genId: () => `${String(Date.now()).padStart(13, '0')}-${Math.random().toString(36).slice(2, 10)}`,

    dispatchExecution: async (_ref, _args) => ({ dispatched: false, error: 'browser-only' }),
  };
}

// ── Bootstrap the in-browser runtime ──────────────────────────────────────────
export function createBoardRuntime() {
  const boardAdapter = createBrowserFirestoreAdapter();

  const runtime = createSingleBoardServerRuntime({
    boardId: BOARD_ID,
    boards: [
      {
        label: `Board — ${BOARD_ID}`,
        boardAdapter,
        baseRef: { kind: 'firestore', value: `boards/${BOARD_ID}` },
        cardStoreRef: makeRef('firestore', `boards/${BOARD_ID}/cards`),
        outputsStoreRef: makeRef('firestore', `boards/${BOARD_ID}/runtime-out`),
      },
    ],
    invocationAdapter: {
      // Dispatch executions to the worker via HTTP
      async invoke(ref, args) {
        const workerUrl = window.__BOARD_WORKER_URL__ ?? 'http://localhost:7900';
        const res = await fetch(`${workerUrl}/api/board/invoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref, args }),
        });
        if (!res.ok) return { dispatched: false, error: `worker HTTP ${res.status}` };
        return res.json();
      },
    },
  });

  return runtime;
}

// ── Usage example ──────────────────────────────────────────────────────────────
// const runtime = createBoardRuntime();
// const boardStatus = await runtime.handleRuntimeApi(fakeReq, fakeRes, url);
//
// Or call runtime methods directly:
// await runtime.processAccumulatedLane();   // trigger a card computation pass
// const cards = await runtime.cardStore?.list();  // read current card state
