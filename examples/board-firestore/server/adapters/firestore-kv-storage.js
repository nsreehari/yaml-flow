/**
 * firestore-kv-storage.js
 *
 * AsyncKVStorage backed by a Firestore CollectionReference.
 * Each key is stored as a document with fields: { k, value }
 * where k = original key string, value = arbitrary JSON value.
 *
 * Document ID: base64url(key)  — avoids '/' and other Firestore-forbidden chars.
 *
 * @param {import('@google-cloud/firestore').CollectionReference} col
 * @returns {import('yaml-flow/cloud-storage').AsyncKVStorage}
 */

function encodeDocId(key) {
  return Buffer.from(key).toString('base64url');
}

function decodeDocId(docId) {
  return Buffer.from(docId, 'base64url').toString();
}

export function createFirestoreKvStorage(col) {
  return {
    async read(key) {
      const snap = await col.doc(encodeDocId(key)).get();
      if (!snap.exists) return null;
      return snap.data()?.value ?? null;
    },

    async write(key, value) {
      await col.doc(encodeDocId(key)).set({ k: key, value });
    },

    async delete(key) {
      await col.doc(encodeDocId(key)).delete();
    },

    async listKeys(prefix = '') {
      let q = col;
      if (prefix) {
        q = col.where('k', '>=', prefix).where('k', '<', prefix + '\uf8ff');
      }
      const snap = await q.orderBy('k').get();
      return snap.docs.map((d) => d.data().k ?? decodeDocId(d.id));
    },
  };
}
