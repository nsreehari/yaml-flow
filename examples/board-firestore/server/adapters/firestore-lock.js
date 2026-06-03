/**
 * firestore-lock.js
 *
 * AsyncAtomicRelayLock backed by a Firestore document + runTransaction.
 *
 * Document shape: { held, holderId, expiresAt, acquiredAt }
 * Guarantees at-most-one holder via Firestore transaction atomicity.
 *
 * @param {import('@google-cloud/firestore').DocumentReference} lockDoc
 * @param {{ holderId?: string, ttlMs?: number }} [options]
 * @returns {import('yaml-flow/cloud-storage').AsyncAtomicRelayLock}
 */

import { randomUUID } from 'node:crypto';

export function createFirestoreLock(lockDoc, options = {}) {
  const holderId = options.holderId ?? randomUUID();
  const ttlMs = options.ttlMs ?? 30_000;

  return {
    async tryAcquire() {
      let released = false;

      try {
        await lockDoc.firestore.runTransaction(async (tx) => {
          const snap = await tx.get(lockDoc);
          const now = new Date();
          if (snap.exists) {
            const d = snap.data();
            if (d.held && d.expiresAt > now.toISOString()) {
              throw Object.assign(new Error('locked'), { code: 'locked' });
            }
          }
          tx.set(lockDoc, {
            held: true,
            holderId,
            expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
            acquiredAt: now.toISOString(),
          });
        });
      } catch (err) {
        if (err?.code === 'locked') return null;
        throw err;
      }

      return async () => {
        if (released) return;
        released = true;
        try {
          await lockDoc.firestore.runTransaction(async (tx) => {
            const snap = await tx.get(lockDoc);
            if (snap.exists && snap.data().holderId === holderId) {
              tx.update(lockDoc, { held: false, holderId: null });
            }
          });
        } catch {
          // Best-effort release — lock will expire via TTL
        }
      };
    },
  };
}
