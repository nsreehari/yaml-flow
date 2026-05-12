import { L as LiveCard } from '../board-live-cards-lib-tjYsPt5U.js';

/**
 * card-store-browser-api.ts
 *
 * Simple browser-facing card store API.
 * Wraps createCardStore() + createLocalStorageCardStorageAdapter()
 * into a minimal read/write interface suitable for browser consumption.
 */

interface BrowserCardStoreApi {
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
declare function createBrowserCardStoreApi(namespace: string): BrowserCardStoreApi;

export { type BrowserCardStoreApi, LiveCard, createBrowserCardStoreApi };
