import {
  parseRef,
  serializeRef,
  type KindValueRef,
  type QueueMessage,
} from '../cli/common/storage-interface.js';
import type {
  AsyncBoardPlatformAdapter,
} from '../cli/cloud/index.js';
import type {
  AsyncArchiveFactory,
  AsyncAtomicRelayLock,
  AsyncBlobStorage,
  AsyncJournalStorage,
  AsyncKVStorage,
  AsyncQueueStorage,
  AsyncScratchStorage,
} from '../cli/cloud/storage-async-interface.js';
import { createHostedAsyncBoardPlatformAdapter } from '../cli/cloud/index.js';
import { computeStableJsonHashBrowser } from '../cli/browser-api/storage-localstorage-adapters.js';
import { createAsyncChatStorage } from '../cli/common/chat-storage-lib.js';

export interface FirestoreDocumentSnapshotLike {
  readonly exists: boolean;
  readonly id: string;
  data(): Record<string, any> | undefined;
}

export interface FirestoreQuerySnapshotLike {
  readonly docs: FirestoreDocumentSnapshotLike[];
  readonly empty?: boolean;
}

export interface FirestoreTransactionLike {
  get(ref: FirestoreDocumentLike): Promise<FirestoreDocumentSnapshotLike>;
  set(ref: FirestoreDocumentLike, data: Record<string, any>, options?: Record<string, any>): void;
  update(ref: FirestoreDocumentLike, data: Record<string, any>): void;
  delete(ref: FirestoreDocumentLike): void;
}

export interface FirestoreQueryLike {
  get(): Promise<FirestoreQuerySnapshotLike>;
  where(field: string, op: string, value: unknown): FirestoreQueryLike;
  orderBy(field: string, direction?: 'asc' | 'desc'): FirestoreQueryLike;
  limit(count: number): FirestoreQueryLike;
}

export interface FirestoreCollectionLike extends FirestoreQueryLike {
  readonly path: string;
  readonly firestore: FirestoreLike;
  doc(id?: string): FirestoreDocumentLike;
}

export interface FirestoreDocumentLike {
  readonly id: string;
  readonly path: string;
  readonly firestore: FirestoreLike;
  get(): Promise<FirestoreDocumentSnapshotLike>;
  set(data: Record<string, any>, options?: Record<string, any>): Promise<void>;
  update(data: Record<string, any>): Promise<void>;
  delete(): Promise<void>;
  collection(name: string): FirestoreCollectionLike;
  listCollections?(): Promise<FirestoreCollectionLike[]>;
}

export interface FirestoreLike {
  collection(path: string): FirestoreCollectionLike;
  runTransaction<T>(updateFn: (tx: FirestoreTransactionLike) => Promise<T>): Promise<T>;
  batch?(): {
    delete(ref: FirestoreDocumentLike): void;
    commit(): Promise<void>;
  };
}

export interface FirestoreBoardRefs {
  baseRef: KindValueRef;
  boardRuntimeStoreRef: string;
  cardStoreRef: string;
  outputsStoreRef: string;
  queueStoreRef: string;
  scratchStoreRef: string;
  chatStoreRef: string;
  artifactsStoreRef: string;
  fetchedSourcesStoreRef: string;
}

function safeChatCardKey(cardId: string): string {
  return String(cardId).replace(/[^a-zA-Z0-9_-]/g, '_');
}

export interface FirestoreQueueStorageOptions {
  defaultVisibilityMs?: number;
}

export interface FirestoreBoardAdapterOptions {
  refs?: Partial<FirestoreBoardRefs>;
  holderId?: string;
  requestProcessAccumulated?: () => void | Promise<void>;
  publishBoardChangeNotifications?: (notifications: unknown[]) => void | Promise<void>;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function stableHash16(value: unknown): string {
  return computeStableJsonHashBrowser(value).slice(0, 16);
}

function uuidLike(): string {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}

function encodeDocId(key: string): string {
  return base64UrlEncode(String(key));
}

function lexicalId(): string {
  const ts = String(Date.now()).padStart(13, '0');
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${ts}-${rand}`;
}

function tryParseRef(ref: string): KindValueRef | null {
  try {
    return parseRef(ref);
  } catch {
    return null;
  }
}

function requireCollectionPath(ref: string, fallback: string): string {
  const parsed = tryParseRef(ref);
  if (parsed?.kind === 'firestore' && parsed.value) return parsed.value;
  return fallback;
}

function stripUndefinedDeep<T>(value: T): T {
  if (value === undefined) return null as T;
  if (Array.isArray(value)) {
    return value.map((entry) => stripUndefinedDeep(entry === undefined ? null : entry)) as T;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, stripUndefinedDeep(entry)]);
    return Object.fromEntries(entries) as T;
  }
  return value;
}

function boardDoc(db: FirestoreLike, boardId: string): FirestoreDocumentLike {
  return db.collection('boards').doc(boardId);
}

function boardCollection(db: FirestoreLike, boardId: string, name: string): FirestoreCollectionLike {
  return boardDoc(db, boardId).collection(name);
}

export function makeFirestoreRef(path: string): KindValueRef {
  return { kind: 'firestore', value: String(path) };
}

export function serializeFirestoreRef(path: string): string {
  return serializeRef(makeFirestoreRef(path));
}

export function createFirestoreBoardRefs(boardId: string): FirestoreBoardRefs {
  return {
    baseRef: makeFirestoreRef(`boards/${boardId}`),
    boardRuntimeStoreRef: serializeFirestoreRef(`boards/${boardId}/runtime-board`),
    cardStoreRef: serializeFirestoreRef(`boards/${boardId}/cards`),
    outputsStoreRef: serializeFirestoreRef(`boards/${boardId}/runtime-out`),
    queueStoreRef: serializeFirestoreRef(`boards/${boardId}/runtime`),
    scratchStoreRef: serializeFirestoreRef(`boards/${boardId}/scratch`),
    chatStoreRef: serializeFirestoreRef(`boards/${boardId}/chat`),
    artifactsStoreRef: serializeFirestoreRef(`boards/${boardId}/files`),
    fetchedSourcesStoreRef: serializeFirestoreRef(`boards/${boardId}/sources`),
  };
}

export function createFirestoreKvStorage(col: FirestoreCollectionLike): AsyncKVStorage {
  return {
    async read(key: string) {
      const snap = await col.doc(encodeDocId(key)).get();
      return snap.exists ? (snap.data()?.value ?? null) : null;
    },
    async write(key: string, value: unknown) {
      await col.doc(encodeDocId(key)).set(stripUndefinedDeep({ k: key, value }));
    },
    async delete(key: string) {
      await col.doc(encodeDocId(key)).delete();
    },
    async listKeys(prefix = '') {
      const query = prefix
        ? col.where('k', '>=', prefix).where('k', '<', `${prefix}\uf8ff`).orderBy('k')
        : col.orderBy('k');
      const snap = await query.get();
      return snap.docs.map((doc) => doc.data()?.k ?? doc.id);
    },
  };
}

export function createFirestoreJournalStorage(col: FirestoreCollectionLike): AsyncJournalStorage {
  return {
    async append(payload: unknown) {
      const id = lexicalId();
      await col.doc(id).set(stripUndefinedDeep({ id, createdAt: new Date().toISOString(), payload }));
      return { id, payload };
    },
    async readAll() {
      const snap = await col.orderBy('id').get();
      return snap.docs.map((doc) => {
        const data = doc.data() ?? {};
        return { id: String(data.id ?? doc.id), payload: data.payload };
      });
    },
    async readAfter(cursor: string | null) {
      const query = cursor
        ? col.where('id', '>', cursor).orderBy('id')
        : col.orderBy('id');
      const snap = await query.get();
      const entries = snap.docs.map((doc) => {
        const data = doc.data() ?? {};
        return { id: String(data.id ?? doc.id), payload: data.payload };
      });
      return {
        entries,
        newCursor: entries.length > 0 ? entries[entries.length - 1].id : cursor,
      };
    },
    async clear() {
      const snap = await col.get();
      if (typeof col.firestore.batch === 'function') {
        const batch = col.firestore.batch();
        for (const doc of snap.docs) batch.delete(col.doc(doc.id));
        await batch.commit();
        return;
      }
      await Promise.all(snap.docs.map((doc) => col.doc(doc.id).delete()));
    },
  };
}

export function createFirestoreBlobStorage(col: FirestoreCollectionLike): AsyncBlobStorage {
  return {
    async read(key: string) {
      const snap = await col.doc(encodeDocId(key)).get();
      return snap.exists ? (snap.data()?.content ?? null) : null;
    },
    async write(key: string, content: string) {
      await col.doc(encodeDocId(key)).set({ k: key, content });
    },
    async exists(key: string) {
      const snap = await col.doc(encodeDocId(key)).get();
      return snap.exists;
    },
    async remove(key: string) {
      await col.doc(encodeDocId(key)).delete();
    },
    async readBytes(key: string) {
      const snap = await col.doc(encodeDocId(key)).get();
      if (!snap.exists) return null;
      const data = snap.data() ?? {};
      if (typeof data.bytesBase64 === 'string') return base64ToBytes(data.bytesBase64);
      if (typeof data.content === 'string') return new TextEncoder().encode(data.content);
      return null;
    },
    async writeBytes(key: string, bytes: Uint8Array) {
      await col.doc(encodeDocId(key)).set({
        k: key,
        bytesBase64: bytesToBase64(bytes),
      });
    },
    async listKeys(prefix = '') {
      const query = prefix
        ? col.where('k', '>=', prefix).where('k', '<', `${prefix}\uf8ff`).orderBy('k')
        : col.orderBy('k');
      const snap = await query.get();
      return snap.docs.map((doc) => doc.data()?.k ?? doc.id);
    },
    async stat(key: string) {
      const snap = await col.doc(encodeDocId(key)).get();
      if (!snap.exists) return null;
      const data = snap.data() ?? {};
      const size = typeof data.bytesBase64 === 'string'
        ? Math.floor((data.bytesBase64.length * 3) / 4)
        : typeof data.content === 'string'
          ? data.content.length
          : 0;
      return { key, size, contentType: String(data.contentType ?? 'application/octet-stream') };
    },

    async renameKey(from: string, to: string): Promise<boolean> {
      const snap = await col.doc(encodeDocId(from)).get();
      if (!snap.exists) return false;
      const data = snap.data() ?? {};
      await col.doc(encodeDocId(to)).set({ ...data, k: to });
      await col.doc(encodeDocId(from)).delete();
      return true;
    },
  };
}

export function createFirestoreScratchStorage(col: FirestoreCollectionLike): AsyncScratchStorage {
  const blob = createFirestoreBlobStorage(col);
  return {
    ...blob,
    async getUniqueKey(prefix = 'scratch-', suffix = '') {
      return `${prefix}${lexicalId()}${suffix}`;
    },
    async create(data: string, prefix = 'scratch-', suffix = '') {
      const key = `${prefix}${lexicalId()}${suffix}`;
      await blob.write(key, data);
      return key;
    },
    keyRef(key: string) {
      return makeFirestoreRef(`${col.path}/${encodeDocId(key)}`);
    },
    config: {
      async get(k: string) {
        const raw = await blob.read(`__config__/${k}`);
        if (raw == null) return null;
        try {
          return JSON.parse(raw);
        } catch {
          return raw;
        }
      },
      async set(k: string, v: unknown) {
        await blob.write(`__config__/${k}`, JSON.stringify(v));
      },
    },
  };
}

export function createFirestoreArchiveFactory(db: FirestoreLike, boardId: string): AsyncArchiveFactory {
  const doc = boardDoc(db, boardId);
  return {
    stream(name: string) {
      return createFirestoreJournalStorage(doc.collection(`archive-stream-${name}`));
    },
    blob(name: string) {
      return createFirestoreBlobStorage(doc.collection(`archive-blob-${name}`));
    },
    async listStreams(prefix = '') {
      if (typeof doc.listCollections !== 'function') return [];
      const cols = await doc.listCollections();
      return cols
        .map((col) => col.path.split('/').at(-1) ?? '')
        .filter((name) => name.startsWith(`archive-stream-${prefix}`))
        .map((name) => name.slice('archive-stream-'.length));
    },
    async listBlobs(prefix = '') {
      if (typeof doc.listCollections !== 'function') return [];
      const cols = await doc.listCollections();
      return cols
        .map((col) => col.path.split('/').at(-1) ?? '')
        .filter((name) => name.startsWith(`archive-blob-${prefix}`))
        .map((name) => name.slice('archive-blob-'.length));
    },
    config: {
      async get(k: string) {
        const snap = await doc.collection('archive-config').doc('main').get();
        return snap.exists ? (snap.data()?.[k] ?? null) : null;
      },
      async set(k: string, v: unknown) {
        await doc.collection('archive-config').doc('main').set(stripUndefinedDeep({ [k]: v }), { merge: true });
      },
    },
  };
}

export function createFirestoreLock(lockDoc: FirestoreDocumentLike, opts: { holderId?: string; ttlMs?: number } = {}): AsyncAtomicRelayLock {
  const holderId = opts.holderId ?? uuidLike();
  const ttlMs = opts.ttlMs ?? 30_000;

  return {
    async tryAcquire() {
      try {
        await lockDoc.firestore.runTransaction(async (tx) => {
          const snap = await tx.get(lockDoc);
          const nowIso = new Date().toISOString();
          if (snap.exists) {
            const data = snap.data() ?? {};
            if (data.held === true && typeof data.expiresAt === 'string' && data.expiresAt > nowIso) {
              throw Object.assign(new Error('locked'), { code: 'locked' });
            }
          }
          tx.set(lockDoc, {
            held: true,
            holderId,
            acquiredAt: nowIso,
            expiresAt: new Date(Date.now() + ttlMs).toISOString(),
          });
        });
      } catch (error: any) {
        if (error?.code === 'locked') return null;
        throw error;
      }

      return async () => {
        try {
          await lockDoc.firestore.runTransaction(async (tx) => {
            const snap = await tx.get(lockDoc);
            if (!snap.exists) return;
            const data = snap.data() ?? {};
            if (data.holderId === holderId) tx.update(lockDoc, { held: false, holderId: null });
          });
        } catch {
          // best-effort release
        }
      };
    },
  };
}

export function createFirestoreQueueStorage(col: FirestoreCollectionLike, opts: FirestoreQueueStorageOptions = {}): AsyncQueueStorage {
  const defaultVisibilityMs = opts.defaultVisibilityMs ?? 30_000;

  return {
    async enqueue<T>(body: T) {
      const id = lexicalId();
      const nowIso = new Date().toISOString();
      await col.doc(id).set(stripUndefinedDeep({
        id,
        body,
        enqueuedAt: nowIso,
        attempt: 0,
        staged: false,
        visibleAfter: nowIso,
        leaseToken: null,
        leaseExpiresAt: null,
        dead: false,
        deadReason: null,
      }));
      return { id, body, enqueuedAt: nowIso, attempt: 0 };
    },
    async enqueueMany<T>(bodies: T[]) {
      const queued = [] as QueueMessage<T>[];
      for (const body of bodies) queued.push(await this.enqueue(body));
      return queued;
    },
    async enqueueIfAbsent<T>(body: T, dedupKey: string) {
      const existing = await col.where('dedupKey', '==', dedupKey).where('dead', '==', false).limit(1).get();
      if (existing.docs.length > 0) return null;
      const id = lexicalId();
      const nowIso = new Date().toISOString();
      await col.doc(id).set(stripUndefinedDeep({
        id,
        body,
        dedupKey,
        enqueuedAt: nowIso,
        attempt: 0,
        staged: false,
        visibleAfter: nowIso,
        leaseToken: null,
        leaseExpiresAt: null,
        dead: false,
        deadReason: null,
      }));
      return { id, body, enqueuedAt: nowIso, attempt: 0 };
    },
    async stage<T>(body: T, opts: { dedupKey?: string } = {}) {
      if (opts.dedupKey) {
        const existing = await col.where('dedupKey', '==', opts.dedupKey).where('dead', '==', false).limit(1).get();
        if (existing.docs.length > 0) return null;
      }
      const id = lexicalId();
      const nowIso = new Date().toISOString();
      await col.doc(id).set(stripUndefinedDeep({
        id,
        body,
        dedupKey: opts.dedupKey,
        enqueuedAt: nowIso,
        attempt: 0,
        staged: true,
        visibleAfter: null,
        leaseToken: null,
        leaseExpiresAt: null,
        dead: false,
        deadReason: null,
      }));
      return { id, body, enqueuedAt: nowIso, attempt: 0 };
    },
    async commitStaged(messageId: string) {
      try {
        await col.firestore.runTransaction(async (tx) => {
          const ref = col.doc(messageId);
          const snap = await tx.get(ref);
          if (!snap.exists) throw new Error('missing');
          const data = snap.data() ?? {};
          if (data.dead === true || data.staged !== true) throw new Error('not-staged');
          tx.update(ref, {
            staged: false,
            enqueuedAt: new Date().toISOString(),
            attempt: 0,
            visibleAfter: new Date().toISOString(),
          });
        });
        return true;
      } catch {
        return false;
      }
    },
    async discardStaged(messageId: string, reason?: string) {
      try {
        await col.firestore.runTransaction(async (tx) => {
          const ref = col.doc(messageId);
          const snap = await tx.get(ref);
          if (!snap.exists) throw new Error('missing');
          const data = snap.data() ?? {};
          if (data.dead === true || data.staged !== true) throw new Error('not-staged');
          tx.update(ref, {
            staged: false,
            dead: true,
            deadReason: reason ?? 'discarded',
          });
        });
        return true;
      } catch {
        return false;
      }
    },
    async peekStaged(prefix = '') {
      const snap = await col.where('dead', '==', false).where('staged', '==', true).orderBy('enqueuedAt').get();
      return snap.docs
        .map((doc) => doc.data() ?? {})
        .filter((entry) => !prefix || String(entry.id ?? '').startsWith(prefix))
        .map((entry) => ({
          id: String(entry.id ?? ''),
          body: entry.body,
          enqueuedAt: String(entry.enqueuedAt ?? ''),
          attempt: Number(entry.attempt ?? 0),
        }));
    },
    async lease(options: { max?: number; visibilityMs?: number } = {}) {
      const max = Math.max(1, Number(options.max ?? 1));
      const visibilityMs = Math.max(1, Number(options.visibilityMs ?? defaultVisibilityMs));
      const nowIso = new Date().toISOString();
      const snap = await col
        .where('dead', '==', false)
        .where('staged', '==', false)
        .where('visibleAfter', '<=', nowIso)
        .orderBy('visibleAfter')
        .limit(max * 4)
        .get();
      const leased: Array<Record<string, any>> = [];
      for (const doc of snap.docs) {
        if (leased.length >= max) break;
        const docRef = col.doc(doc.id);
        try {
          let leasedMessage: Record<string, any> | null = null;
          await col.firestore.runTransaction(async (tx) => {
            const fresh = await tx.get(docRef);
            if (!fresh.exists) throw new Error('gone');
            const data = fresh.data() ?? {};
            const txNowIso = new Date().toISOString();
            if (data.dead === true) throw new Error('dead');
            if (data.staged === true) throw new Error('staged');
            if (typeof data.visibleAfter === 'string' && data.visibleAfter > txNowIso) throw new Error('hidden');
            if (data.leaseToken && typeof data.leaseExpiresAt === 'string' && data.leaseExpiresAt > txNowIso) throw new Error('leased');
            const leaseToken = uuidLike();
            const leaseExpiresAt = new Date(Date.now() + visibilityMs).toISOString();
            const attempt = Number(data.attempt ?? 0) + 1;
            tx.update(docRef, { leaseToken, leaseExpiresAt, attempt });
            leasedMessage = {
              id: String(data.id ?? doc.id),
              body: data.body,
              enqueuedAt: String(data.enqueuedAt ?? txNowIso),
              attempt,
              leaseToken,
              leaseExpiresAt,
            };
          });
          if (leasedMessage) leased.push(leasedMessage);
        } catch {
          // race or hidden; skip
        }
      }
      return leased as any;
    },
    async ack(messageId: string, leaseToken: string) {
      try {
        await col.firestore.runTransaction(async (tx) => {
          const ref = col.doc(messageId);
          const snap = await tx.get(ref);
          if (!snap.exists) return;
          const data = snap.data() ?? {};
          if (data.leaseToken !== leaseToken) throw new Error('token mismatch');
          tx.delete(ref);
        });
        return true;
      } catch {
        return false;
      }
    },
    async nack(messageId: string, leaseToken: string, opts: { dead?: boolean; reason?: string } = {}) {
      try {
        await col.firestore.runTransaction(async (tx) => {
          const ref = col.doc(messageId);
          const snap = await tx.get(ref);
          if (!snap.exists) return;
          const data = snap.data() ?? {};
          if (data.leaseToken !== leaseToken) throw new Error('token mismatch');
          if (opts.dead === true) {
            tx.update(ref, {
              dead: true,
              deadReason: opts.reason ?? 'nacked',
              leaseToken: null,
              leaseExpiresAt: null,
            });
          } else {
            tx.update(ref, {
              leaseToken: null,
              leaseExpiresAt: null,
              visibleAfter: new Date().toISOString(),
            });
          }
        });
        return true;
      } catch {
        return false;
      }
    },
    async peekActive(prefix = '') {
      const snap = await col.where('dead', '==', false).where('staged', '==', false).orderBy('enqueuedAt').get();
      return snap.docs
        .map((doc) => doc.data() ?? {})
        .filter((entry) => !prefix || String(entry.id ?? '').startsWith(prefix))
        .map((entry) => ({
          id: String(entry.id ?? ''),
          body: entry.body,
          enqueuedAt: String(entry.enqueuedAt ?? ''),
          attempt: Number(entry.attempt ?? 0),
        }));
    },
    async peekDeadLetter(prefix = '') {
      const snap = await col.where('dead', '==', true).orderBy('enqueuedAt').get();
      return snap.docs
        .map((doc) => doc.data() ?? {})
        .filter((entry) => !prefix || String(entry.id ?? '').startsWith(prefix))
        .map((entry) => ({
          id: String(entry.id ?? ''),
          body: entry.body,
          enqueuedAt: String(entry.enqueuedAt ?? ''),
          attempt: Number(entry.attempt ?? 0),
          reason: entry.deadReason,
        }));
    },
  };
}

export function createFirestoreBoardAdapter(
  db: FirestoreLike,
  boardId: string,
  options: FirestoreBoardAdapterOptions = {},
): AsyncBoardPlatformAdapter {
  return createHostedAsyncBoardPlatformAdapter({
    boardId,
    kvStorage(namespace) {
      return createFirestoreKvStorage(boardCollection(db, boardId, `kv-${namespace || 'root'}`));
    },
    kvStorageForRef(ref) {
      return createFirestoreKvStorage(db.collection(requireCollectionPath(ref, `boards/${boardId}/kv-root`)));
    },
    blobStorage(namespace) {
      return createFirestoreBlobStorage(boardCollection(db, boardId, `blobs-${namespace || 'root'}`));
    },
    blobStorageForRef(ref) {
      return createFirestoreBlobStorage(db.collection(requireCollectionPath(ref, `boards/${boardId}/blobs-root`)));
    },
    chatStorageForRef(ref) {
      const root = requireCollectionPath(ref, `boards/${boardId}/chat`);
      return createAsyncChatStorage(
        (cardId) => createFirestoreJournalStorage(db.collection(`${root}-journal-${safeChatCardKey(cardId)}`)),
        createFirestoreKvStorage(db.collection(`${root}-kv`)),
      );
    },
    queueStoreRef: createFirestoreBoardRefs(boardId).queueStoreRef,
    queueStorageForRef(ref, lane) {
      const root = requireCollectionPath(ref, `boards/${boardId}/runtime`);
      return createFirestoreQueueStorage(db.collection(`${root}-${lane}`));
    },
    scratchStorage() {
      return createFirestoreScratchStorage(boardCollection(db, boardId, 'scratch'));
    },
    scratchStorageForRef(ref) {
      return createFirestoreScratchStorage(db.collection(requireCollectionPath(ref, `boards/${boardId}/scratch`)));
    },
    archiveFactory() {
      return createFirestoreArchiveFactory(db, boardId);
    },
    archiveFactoryForRef(ref) {
      const parsed = tryParseRef(ref);
      const altBoardId = parsed?.kind === 'firestore-board' ? parsed.value : boardId;
      return createFirestoreArchiveFactory(db, altBoardId);
    },
    journalStorage() {
      return createFirestoreJournalStorage(boardCollection(db, boardId, 'journal'));
    },
    journalStorageForRef(ref) {
      const root = requireCollectionPath(ref, `boards/${boardId}/runtime-board`);
      return createFirestoreJournalStorage(db.collection(`${root}-journal`));
    },
    lock: createFirestoreLock(boardCollection(db, boardId, 'locks').doc('board-lock'), {
      holderId: options.holderId,
    }),
    hashFn(value) {
      return stableHash16(value);
    },
    genId() {
      return lexicalId();
    },
    supportsDirectSourceOutput(ref) {
      return ref.howToRun === 'queue-storage' || ref.howToRun === 'http:post';
    },
    requestProcessAccumulated: options.requestProcessAccumulated,
    publishBoardChangeNotifications: options.publishBoardChangeNotifications as any,
    onWarn: (msg) => console.warn(`[firestore-board-adapter:${boardId}] ${msg}`),
  });
}

export function createFirestoreBoardRuntimeBundle(db: FirestoreLike, boardId: string, options: FirestoreBoardAdapterOptions = {}) {
  const refs = {
    ...createFirestoreBoardRefs(boardId),
    ...(options.refs ?? {}),
  };
  const boardAdapter = createFirestoreBoardAdapter(db, boardId, options);
  return {
    refs,
    boardAdapter,
  };
}
