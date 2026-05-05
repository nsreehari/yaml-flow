/**
 * card-store-browser-api.ts
 *
 * Simple browser-facing card store API.
 * Wraps createCardStore() + createLocalStorageCardStorageAdapter()
 * into a minimal read/write interface suitable for browser consumption.
 */

import { createCardStore } from '../common/board-live-cards-lib.js';
import type { LiveCard } from '../common/board-live-cards-lib.js';
import { createLocalStorageCardStorageAdapter } from './storage-localstorage-adapters.js';

export type { LiveCard };

export interface BrowserCardStoreApi {
  getCard(id: string): LiveCard | null;
  getAllCards(): LiveCard[];
  upsertCard(card: LiveCard): void;
  removeCard(id: string): void;
}

/**
 * Create a browser card store backed by localStorage.
 *
 * @param namespace - localStorage key prefix (e.g. 'my-board:cards').
 *   Multiple stores can coexist by using distinct namespaces.
 */
export function createBrowserCardStoreApi(namespace: string): BrowserCardStoreApi {
  const adapter = createLocalStorageCardStorageAdapter(namespace);
  const store = createCardStore(adapter);

  return {
    getCard(id: string): LiveCard | null {
      return store.readCard(id);
    },
    getAllCards(): LiveCard[] {
      return store.readAllCards();
    },
    upsertCard(card: LiveCard): void {
      const key = adapter.defaultCardKey(card.id);
      store.writeCard(card.id, card, key);
    },
    removeCard(id: string): void {
      store.removeCard(id);
    },
  };
}
