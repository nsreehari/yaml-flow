/**
 * server-runtime/firebase/index.ts
 *
 * Barrel export for Firebase adapters.
 * Import from 'yaml-flow/server-runtime/firebase' to get all Firebase adapters.
 */

export {
  createCachedFirestoreKvStorage,
  createCachedFirestoreBlobStorage,
  createCachedFirestoreJournalAdapter,
  createFirestoreAtomicRelayLock,
  createFirestoreServerMetaStore,
} from './firestore-adapters.js';

export {
  createFirebaseBoardPlatformAdapter,
  type FirebaseBoardAdapter,
  type FirebaseBoardAdapterOptions,
  type Flushable,
} from './firebase-board-adapter.js';
