/**
 * firestore-queue-storage.js
 *
 * AsyncQueueStorage backed by Firestore with visibility-timeout leasing.
 *
 * Document shape:
 *   { id, body, enqueuedAt, attempt, visibleAfter, leaseToken, leaseExpiresAt,
 *     dead, deadReason, dedupKey? }
 *
 * Leasing is done via Firestore transactions: find visible messages,
 * then atomically claim each one (optimistic concurrency — skip on race).
 *
 * Required Firestore composite index for the lease query:
 *   Collection group: <your collection>
 *   Fields: dead ASC, visibleAfter ASC
 *
 * @param {import('@google-cloud/firestore').CollectionReference} col
 * @param {{ defaultVisibilityMs?: number }} [options]
 * @returns {import('yaml-flow/cloud-storage').AsyncQueueStorage}
 */

import { randomUUID } from 'node:crypto';

function lexicalId() {
  const ts = String(Date.now()).padStart(13, '0');
  const rand = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `${ts}-${rand}`;
}

export function createFirestoreQueueStorage(col, options = {}) {
  const defaultVisibilityMs = options.defaultVisibilityMs ?? 30_000;

  return {
    async enqueue(body) {
      const id = lexicalId();
      const now = new Date().toISOString();
      await col.doc(id).set({
        id,
        body,
        enqueuedAt: now,
        attempt: 0,
        visibleAfter: now,
        leaseToken: null,
        leaseExpiresAt: null,
        dead: false,
        deadReason: null,
      });
      return { id, body, enqueuedAt: now };
    },

    async enqueueIfAbsent(body, dedupKey) {
      const existing = await col
        .where('dedupKey', '==', dedupKey)
        .where('dead', '==', false)
        .limit(1)
        .get();
      if (!existing.empty) return null;
      const id = lexicalId();
      const now = new Date().toISOString();
      await col.doc(id).set({
        id,
        body,
        enqueuedAt: now,
        attempt: 0,
        visibleAfter: now,
        leaseToken: null,
        leaseExpiresAt: null,
        dead: false,
        deadReason: null,
        dedupKey,
      });
      return { id, body, enqueuedAt: now };
    },

    async lease(opts = {}) {
      const max = opts.max ?? 1;
      const visibilityMs = opts.visibilityMs ?? defaultVisibilityMs;
      const nowIso = new Date().toISOString();

      // Find visible, non-dead messages — fetch extra to tolerate races
      const snap = await col
        .where('dead', '==', false)
        .where('visibleAfter', '<=', nowIso)
        .orderBy('visibleAfter')
        .limit(max * 4)
        .get();

      const leased = [];
      for (const doc of snap.docs) {
        if (leased.length >= max) break;

        const data = doc.data();
        // Skip if currently leased and lease hasn't expired
        if (data.leaseToken && data.leaseExpiresAt > nowIso) continue;

        const leaseToken = randomUUID();
        const leaseExpiresAt = new Date(Date.now() + visibilityMs).toISOString();

        try {
          let claimedAttempt = 0;
          await col.firestore.runTransaction(async (tx) => {
            const fresh = await tx.get(doc.ref);
            if (!fresh.exists) throw Object.assign(new Error('gone'), { code: 'gone' });
            const d = fresh.data();
            if (d.dead) throw Object.assign(new Error('dead'), { code: 'dead' });
            if (d.leaseToken && d.leaseExpiresAt > new Date().toISOString()) {
              throw Object.assign(new Error('taken'), { code: 'taken' });
            }
            claimedAttempt = (d.attempt ?? 0) + 1;
            tx.update(doc.ref, { leaseToken, leaseExpiresAt, attempt: claimedAttempt });
          });
          leased.push({
            id: data.id,
            body: data.body,
            enqueuedAt: data.enqueuedAt,
            attempt: claimedAttempt,
            leaseToken,
            leaseExpiresAt,
          });
        } catch {
          // Race condition — skip this message
        }
      }
      return leased;
    },

    async ack(messageId, leaseToken) {
      try {
        await col.firestore.runTransaction(async (tx) => {
          const ref = col.doc(messageId);
          const snap = await tx.get(ref);
          if (!snap.exists) return;
          if (snap.data().leaseToken !== leaseToken) throw new Error('token mismatch');
          tx.delete(ref);
        });
        return true;
      } catch {
        return false;
      }
    },

    async nack(messageId, leaseToken, opts = {}) {
      try {
        await col.firestore.runTransaction(async (tx) => {
          const ref = col.doc(messageId);
          const snap = await tx.get(ref);
          if (!snap.exists) return;
          if (snap.data().leaseToken !== leaseToken) throw new Error('token mismatch');
          if (opts.dead) {
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

    async peekActive(prefix) {
      const snap = await col.where('dead', '==', false).orderBy('enqueuedAt').get();
      return snap.docs
        .map((d) => d.data())
        .filter((d) => !prefix || String(d.id).startsWith(prefix))
        .map((d) => ({ id: d.id, body: d.body, enqueuedAt: d.enqueuedAt }));
    },

    async peekDeadLetter(prefix) {
      const snap = await col.where('dead', '==', true).orderBy('enqueuedAt').get();
      return snap.docs
        .map((d) => d.data())
        .filter((d) => !prefix || String(d.id).startsWith(prefix))
        .map((d) => ({ id: d.id, body: d.body, enqueuedAt: d.enqueuedAt, reason: d.deadReason }));
    },
  };
}
