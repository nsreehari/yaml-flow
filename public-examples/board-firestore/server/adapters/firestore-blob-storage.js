/**
 * firestore-blob-storage.js
 *
 * AsyncBlobStorage backed by Firestore for text/small blobs.
 * Document shape: { k, content, contentType?, bytesBase64? }
 *
 * Binary blobs (readBytes/writeBytes) are stored as base64-encoded strings.
 * For production use with files > 1 MB, replace writeBytes/readBytes with
 * Firebase Storage (Cloud Storage for Firebase) and store the GCS path here.
 *
 * @param {import('@google-cloud/firestore').CollectionReference} col
 * @returns {import('yaml-flow/cloud-storage').AsyncBlobStorage}
 */

function encodeDocId(key) {
  return Buffer.from(key).toString('base64url');
}

function decodeDocId(docId) {
  return Buffer.from(docId, 'base64url').toString();
}

export function createFirestoreBlobStorage(col) {
  return {
    async read(key) {
      const snap = await col.doc(encodeDocId(key)).get();
      if (!snap.exists) return null;
      return snap.data()?.content ?? null;
    },

    async write(key, content) {
      await col.doc(encodeDocId(key)).set({ k: key, content });
    },

    async exists(key) {
      const snap = await col.doc(encodeDocId(key)).get();
      return snap.exists;
    },

    async remove(key) {
      await col.doc(encodeDocId(key)).delete();
    },

    async readBytes(key) {
      const snap = await col.doc(encodeDocId(key)).get();
      if (!snap.exists) return null;
      const data = snap.data();
      if (data?.bytesBase64) return Buffer.from(data.bytesBase64, 'base64');
      if (data?.content) return Buffer.from(data.content);
      return null;
    },

    async writeBytes(key, bytes) {
      // NOTE: Firestore 1 MB doc limit. For larger files use Firebase Storage.
      const bytesBase64 = Buffer.from(bytes).toString('base64');
      await col.doc(encodeDocId(key)).set({ k: key, bytesBase64 });
    },

    async listKeys(prefix = '') {
      let q = col;
      if (prefix) {
        q = col.where('k', '>=', prefix).where('k', '<', prefix + '\uf8ff');
      }
      const snap = await q.orderBy('k').get();
      return snap.docs.map((d) => d.data().k ?? decodeDocId(d.id));
    },

    async stat(key) {
      const snap = await col.doc(encodeDocId(key)).get();
      if (!snap.exists) return null;
      const data = snap.data();
      const size = data?.bytesBase64
        ? Math.floor((data.bytesBase64.length * 3) / 4)
        : (data?.content?.length ?? 0);
      return { key, size, contentType: data?.contentType ?? 'application/octet-stream' };
    },

    keyRef(key) {
      return { kind: 'firestore-blob', value: `${col.path}/${encodeDocId(key)}` };
    },
  };
}
