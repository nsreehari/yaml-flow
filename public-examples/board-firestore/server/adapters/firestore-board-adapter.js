/**
 * firestore-board-adapter.js
 *
 * Composes all Firestore-backed storage primitives into an AsyncBoardPlatformAdapter
 * using createHostedAsyncBoardPlatformAdapter from yaml-flow/cloud-storage.
 *
 * Firestore collection layout under boards/{boardId}/:
 *   kv-{namespace}/          AsyncKVStorage per namespace
 *   journal/                 single board journal
 *   worker-queue/            board worker task queue
 *   chat-queue/              chat agent dispatch queue
 *   process-queue/           processAccumulated trigger queue
 *   blobs-{namespace}/       AsyncBlobStorage per namespace
 *   scratch/                 ephemeral scratch storage
 *   archive-stream-{name}/   archive journal streams
 *   archive-blob-{name}/     archive blob collections
 *   archive-config/          archive config KV
 *   locks/board-lock         AtomicRelayLock document
 *
 * @param {import('@google-cloud/firestore').Firestore} db
 * @param {string} boardId
 * @param {{ holderId?: string, requestProcessAccumulated?: () => void }} [options]
 * @returns {import('yaml-flow/cloud-storage').AsyncBoardPlatformAdapter}
 */

import { createHash, randomUUID } from 'node:crypto';
import { createHostedAsyncBoardPlatformAdapter } from 'yaml-flow/cloud-storage';

import { createFirestoreKvStorage } from './firestore-kv-storage.js';
import { createFirestoreJournalStorage } from './firestore-journal-storage.js';
import { createFirestoreQueueStorage } from './firestore-queue-storage.js';
import { createFirestoreBlobStorage } from './firestore-blob-storage.js';
import { createFirestoreScratchStorage } from './firestore-scratch-storage.js';
import { createFirestoreArchiveFactory } from './firestore-archive-factory.js';
import { createFirestoreLock } from './firestore-lock.js';

function parseKindValueRef(ref) {
  const PREFIX = 'b64:';
  if (!ref.startsWith(PREFIX)) return { kind: 'unknown', value: ref };
  const b64 = ref.slice(PREFIX.length)
    .replace(/-/g, '+').replace(/_/g, '/')
    + '='.repeat((4 - (ref.length - PREFIX.length) % 4) % 4);
  return JSON.parse(Buffer.from(b64, 'base64').toString());
}

function lexicalId() {
  const ts = String(Date.now()).padStart(13, '0');
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${ts}-${rand}`;
}

export function createFirestoreBoardAdapter(db, boardId, options = {}) {
  const boardDoc = db.collection('boards').doc(boardId);

  return createHostedAsyncBoardPlatformAdapter({
    boardId,

    // ── KV storage ────────────────────────────────────────────────────────
    kvStorage(namespace) {
      return createFirestoreKvStorage(boardDoc.collection(`kv-${namespace || 'root'}`));
    },
    kvStorageForRef(ref) {
      const parsed = parseKindValueRef(ref);
      // ref.value is treated as a full Firestore collection path when kind='firestore'
      const col = parsed.kind === 'firestore'
        ? db.collection(parsed.value)
        : boardDoc.collection(`kv-ref-${Buffer.from(ref).toString('base64url').slice(0, 16)}`);
      return createFirestoreKvStorage(col);
    },

    // ── Blob storage ──────────────────────────────────────────────────────
    blobStorage(namespace) {
      return createFirestoreBlobStorage(boardDoc.collection(`blobs-${namespace || 'root'}`));
    },

    // ── Scratch storage ───────────────────────────────────────────────────
    scratchStorage() {
      return createFirestoreScratchStorage(boardDoc.collection('scratch'));
    },
    scratchStorageForRef(ref) {
      const parsed = parseKindValueRef(ref);
      const col = parsed.kind === 'firestore'
        ? db.collection(parsed.value)
        : boardDoc.collection('scratch');
      return createFirestoreScratchStorage(col);
    },

    // ── Archive factory ───────────────────────────────────────────────────
    archiveFactory() {
      return createFirestoreArchiveFactory(db, boardId);
    },
    archiveFactoryForRef(ref) {
      const parsed = parseKindValueRef(ref);
      const altBoardId = parsed.kind === 'firestore' ? parsed.value : `${boardId}-archive`;
      return createFirestoreArchiveFactory(db, altBoardId);
    },

    // ── Journal storage ───────────────────────────────────────────────────
    journalStorage() {
      return createFirestoreJournalStorage(boardDoc.collection('journal'));
    },

    // ── Queue storage ─────────────────────────────────────────────────────
    queueStorage: createFirestoreQueueStorage(boardDoc.collection('worker-queue')),
    chatAgentQueueStorage: createFirestoreQueueStorage(boardDoc.collection('chat-queue')),
    processAccumulatedQueueStorage: createFirestoreQueueStorage(boardDoc.collection('process-queue')),

    // ── Lock ──────────────────────────────────────────────────────────────
    lock: createFirestoreLock(
      boardDoc.collection('locks').doc('board-lock'),
      { holderId: options.holderId ?? randomUUID() },
    ),

    // ── Utilities ─────────────────────────────────────────────────────────
    hashFn(value) {
      return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
    },

    genId() {
      return lexicalId();
    },

    requestProcessAccumulated: options.requestProcessAccumulated,
    publishBoardChangeNotifications: options.publishBoardChangeNotifications,
    onWarn: (msg) => console.warn(`[firestore-board-adapter:${boardId}] ${msg}`),
  });
}
