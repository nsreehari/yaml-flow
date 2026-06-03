/**
 * firestore-scratch-storage.js
 *
 * AsyncScratchStorage backed by Firestore.
 * Extends AsyncBlobStorage with ephemeral-key creation and a config sub-map.
 *
 * @param {import('@google-cloud/firestore').CollectionReference} col
 * @returns {import('yaml-flow/cloud-storage').AsyncScratchStorage}
 */

import { createFirestoreBlobStorage } from './firestore-blob-storage.js';

function lexicalId() {
  const ts = String(Date.now()).padStart(13, '0');
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${ts}-${rand}`;
}

export function createFirestoreScratchStorage(col) {
  const blob = createFirestoreBlobStorage(col);

  return {
    ...blob,

    async getUniqueKey(prefix = 'scratch-', suffix = '') {
      return `${prefix}${lexicalId()}${suffix}`;
    },

    async create(data, prefix = 'scratch-', suffix = '') {
      const key = `${prefix}${lexicalId()}${suffix}`;
      await blob.write(key, data);
      return key;
    },

    keyRef(key) {
      return { kind: 'firestore-blob', value: `${col.path}/${Buffer.from(key).toString('base64url')}` };
    },

    config: {
      async get(k) {
        const content = await blob.read(`__config__/${k}`);
        if (content == null) return null;
        try { return JSON.parse(content); } catch { return content; }
      },
      async set(k, v) {
        await blob.write(`__config__/${k}`, JSON.stringify(v));
      },
    },
  };
}
