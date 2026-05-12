import { C as CommandInput, a as CommandResult, L as LiveCard, b as CardAdminStore } from './board-live-cards-public-tPOHGSGu.js';
import './execution-refs.js';
import './types-BBhqYGhE.js';

/**
 * card-store-lib-public.ts
 *
 * Platform-free public API for card store read/write operations.
 *
 * Follows the same CommandInput / CommandResult convention as
 * board-live-cards-public.ts.  No platform code here — inject a
 * CardAdminStore built from your platform adapter.
 *
 * Usage:
 *   import { createCardStorePublic } from './card-store-lib-public.js';
 *   import { createCardStore } from './board-live-cards-lib.js';
 *   import { createFsCardStorageAdapter } from '../node/storage-fs-adapters.js';
 *
 *   const store = createCardStorePublic(
 *     createCardStore(createFsCardStorageAdapter(dir))
 *   );
 *   const result = store.set({ body: card });         // write one card
 *   const result = store.set({ body: [c1, c2] });     // write many
 *   const result = store.get({ params: { id: 'x' } });
 *   const result = store.del({ body: { ids: ['x', 'y'] } });
 */

interface CardStorePublic {
    /** Read one card (params.id) or all cards. */
    get(input: CommandInput): CommandResult<{
        cards: LiveCard[];
    }>;
    /**
     * Write cards into the store.
     * body: single card object { id, ... } or an array of card objects.
     */
    set(input: CommandInput): CommandResult<{
        count: number;
    }>;
    /**
     * Delete cards by ID.
     * body.ids: string[]  — delete several cards at once
     * params.id: string   — delete a single card (alternative, can combine with body.ids)
     */
    del(input: CommandInput): CommandResult<{
        count: number;
    }>;
    /**
     * Patch one card using dot-path assignment.
     * params.id: string
     * params.path: dot path (e.g. "card_data.form.name")
     * body.value: value to assign (or body itself if value is omitted)
     */
    patch(input: CommandInput): CommandResult<{
        count: number;
    }>;
}
declare function createCardStorePublic(store: CardAdminStore): CardStorePublic;

export { type CardStorePublic, createCardStorePublic };
