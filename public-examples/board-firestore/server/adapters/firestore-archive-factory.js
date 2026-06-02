/**
 * firestore-archive-factory.js
 *
 * AsyncArchiveFactory backed by Firestore.
 * Each named stream is a subcollection: boards/{boardId}/archive-stream-{name}
 * Each named blob collection: boards/{boardId}/archive-blob-{name}
 *
 * NOTE: listStreams / listBlobs use Admin SDK's listCollections() — not available
 * in the browser Firestore JS SDK. In the browser, skip or maintain an index manually.
 *
 * @param {import('@google-cloud/firestore').Firestore} db
 * @param {string} boardId
 * @returns {import('yaml-flow/cloud-storage').AsyncArchiveFactory}
 */

import { createFirestoreJournalStorage } from './firestore-journal-storage.js';
import { createFirestoreBlobStorage } from './firestore-blob-storage.js';

export function createFirestoreArchiveFactory(db, boardId) {
  const boardDoc = db.collection('boards').doc(boardId);

  return {
    stream(name) {
      return createFirestoreJournalStorage(boardDoc.collection(`archive-stream-${name}`));
    },

    blob(name) {
      return createFirestoreBlobStorage(boardDoc.collection(`archive-blob-${name}`));
    },

    async listStreams(prefix = '') {
      const cols = await boardDoc.listCollections();
      const tag = `archive-stream-${prefix}`;
      return cols
        .map((c) => c.id)
        .filter((id) => id.startsWith(tag))
        .map((id) => id.slice('archive-stream-'.length));
    },

    async listBlobs(prefix = '') {
      const cols = await boardDoc.listCollections();
      const tag = `archive-blob-${prefix}`;
      return cols
        .map((c) => c.id)
        .filter((id) => id.startsWith(tag))
        .map((id) => id.slice('archive-blob-'.length));
    },

    config: {
      async get(k) {
        const snap = await boardDoc.collection('archive-config').doc('main').get();
        return snap.data()?.[k] ?? null;
      },
      async set(k, v) {
        await boardDoc.collection('archive-config').doc('main').set({ [k]: v }, { merge: true });
      },
    },
  };
}
