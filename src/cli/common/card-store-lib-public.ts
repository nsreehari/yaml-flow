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

import type { CommandInput, CommandResult } from './board-live-cards-public.js';
import type { CardAdminStore, LiveCard } from './board-live-cards-lib.js';

// ============================================================================
// CardStorePublic — public interface
// ============================================================================

export interface CardStorePublic {
  /** Read one card (params.id) or all cards. */
  get(input: CommandInput): CommandResult<{ cards: LiveCard[] }>;

  /**
   * Write cards into the store.
   * body: single card object { id, ... } or an array of card objects.
   */
  set(input: CommandInput): CommandResult<{ count: number }>;

  /**
   * Delete cards by ID.
   * body.ids: string[]  — delete several cards at once
   * params.id: string   — delete a single card (alternative, can combine with body.ids)
   */
  del(input: CommandInput): CommandResult<{ count: number }>;
}

// ============================================================================
// createCardStorePublic — factory
// ============================================================================

export function createCardStorePublic(store: CardAdminStore): CardStorePublic {
  // Internal result builders mirroring the board-live-cards-public pattern.
  function ok<T>(data: T): CommandResult<T> {
    return { status: 'success', data } as CommandResult<T>;
  }
  function fail<T>(error: string): CommandResult<T> {
    return { status: 'fail', error } as CommandResult<T>;
  }
  function oops<T>(e: unknown): CommandResult<T> {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) } as CommandResult<T>;
  }

  return {
    get(input: CommandInput): CommandResult<{ cards: LiveCard[] }> {
      try {
        const id = input.params?.['id'] as string | undefined;
        if (id) {
          const card = store.readCard(id);
          if (!card) return fail(`card "${id}" not found`);
          return ok({ cards: [card] });
        }
        return ok({ cards: store.readAllCards() });
      } catch (e) { return oops(e); }
    },

    set(input: CommandInput): CommandResult<{ count: number }> {
      try {
        const body = input.body;
        if (body == null) return fail('set requires a body (card object or array of cards)');
        const cards: LiveCard[] = Array.isArray(body) ? body as LiveCard[] : [body as LiveCard];
        for (const card of cards) {
          if (typeof card.id !== 'string') {
            return fail('each card must have a string `id` field');
          }
          store.writeCard(card.id, card);
        }
        return ok({ count: cards.length });
      } catch (e) { return oops(e); }
    },

    del(input: CommandInput): CommandResult<{ count: number }> {
      try {
        const bodyIds = (input.body as { ids?: string[] } | undefined)?.ids ?? [];
        const paramId = input.params?.['id'] as string | undefined;
        const ids = paramId ? [...bodyIds, paramId] : bodyIds;
        if (ids.length === 0) return fail('del requires body.ids (string[]) or params.id');
        for (const id of ids) store.removeCard(id);
        return ok({ count: ids.length });
      } catch (e) { return oops(e); }
    },
  };
}
