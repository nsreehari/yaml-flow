/**
 * firestore-journal-storage.js
 *
 * AsyncJournalStorage backed by a Firestore CollectionReference.
 * Each entry is stored as: { id, createdAt, payload }
 * IDs are lexicographically sortable (timestamp prefix) so ORDER BY id
 * gives insertion order.
 *
 * @param {import('@google-cloud/firestore').CollectionReference} col
 * @returns {import('yaml-flow/cloud-storage').AsyncJournalStorage}
 */

function lexicalId() {
  const ts = String(Date.now()).padStart(13, '0');
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${ts}-${rand}`;
}

export function createFirestoreJournalStorage(col) {
  return {
    async append(payload) {
      const id = lexicalId();
      const doc = { id, createdAt: new Date().toISOString(), payload };
      await col.doc(id).set(doc);
      return { id, payload };
    },

    async readAll() {
      const snap = await col.orderBy('id').get();
      return snap.docs.map((d) => ({ id: d.data().id, payload: d.data().payload }));
    },

    async readAfter(cursor) {
      let q = col.orderBy('id');
      if (cursor) q = col.where('id', '>', cursor).orderBy('id');
      const snap = await q.get();
      const entries = snap.docs.map((d) => ({ id: d.data().id, payload: d.data().payload }));
      return {
        entries,
        newCursor: entries.length > 0 ? entries[entries.length - 1].id : cursor,
      };
    },

    async clear() {
      const snap = await col.get();
      const batchSize = 500;
      for (let i = 0; i < snap.docs.length; i += batchSize) {
        const batch = col.firestore.batch();
        for (const doc of snap.docs.slice(i, i + batchSize)) batch.delete(doc.ref);
        await batch.commit();
      }
    },
  };
}
