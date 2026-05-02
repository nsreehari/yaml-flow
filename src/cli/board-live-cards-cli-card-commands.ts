import type { LiveCard } from '../continuous-event-graph/live-cards-bridge.js';
import type { GraphEvent, TaskConfig } from '../event-graph/types.js';
import type { CardUpsertIndexEntry, CardStore } from './board-live-cards-all-stores.js';
import { parseRef } from './storage-interface.js';
import type { KindValueRef } from './storage-interface.js';

export type BoardLiveCard = LiveCard;

// CardCommandDeps — all platform-specific concerns are injected
interface CardCommandDeps {
  /** Compute a stable content hash of a TaskConfig for dedup. Injected to keep this module platform-free. */
  hashTaskConfig: (taskConfig: TaskConfig) => string;
  /** Read a card from the board's authoritative CardStore. */
  getCardStore: (baseRef: KindValueRef) => CardStore;
  /**
   * Read the KV dedup entry for a card. Returns null if the card has never been upserted.
   */
  readCardUpsertEntry: (baseRef: KindValueRef, cardId: string) => CardUpsertIndexEntry | null;
  /**
   * Write the KV dedup entry AFTER the journal entry has been appended.
   */
  writeCardUpsertEntry: (baseRef: KindValueRef, cardId: string, entry: CardUpsertIndexEntry) => void;
  liveCardToTaskConfig: (card: BoardLiveCard) => TaskConfig;
  appendEventToJournal: (baseRef: KindValueRef, event: GraphEvent) => void;
  processAccumulatedEventsInfinitePass: (baseRef: KindValueRef) => Promise<boolean>;
}

export interface CardCommandHandlers {
  cmdUpsertCard: (args: string[]) => void;
  /** Core upsert: card must already be in CardStore. Used by compat layer and clean CLI. */
  upsertCardById: (baseRef: KindValueRef, cardId: string, restart: boolean) => string;
}

export function createCardCommandHandlers(deps: CardCommandDeps): CardCommandHandlers {
  /**
   * Core upsert logic: given a card already in CardStore, hash, dedup, journal.
   * Called by clean CLI (--card-id) and by compat layer (after writing card to store).
   */
  function upsertCardById(baseRef: KindValueRef, cardId: string, restart: boolean): string {
    const card = deps.getCardStore(baseRef).readCard(cardId);
    if (!card) {
      throw new Error(`Card "${cardId}" not found in CardStore at ${baseRef.value}`);
    }

    const taskConfig = deps.liveCardToTaskConfig(card);
    const taskConfigHash = deps.hashTaskConfig(taskConfig);
    const existing = deps.readCardUpsertEntry(baseRef, cardId);
    const taskConfigChanged = existing?.taskConfigHash !== taskConfigHash;

    if (!taskConfigChanged && !restart) {
      return `Card "${cardId}" unchanged — skipped.`;
    }

    if (taskConfigChanged) {
      const blobRef = existing?.blobRef ?? deps.getCardStore(baseRef).readCardKey(cardId) ?? cardId;

      // 1. Journal first — card blob is already in CardStore
      deps.appendEventToJournal(baseRef, {
        type: 'task-upsert',
        taskName: cardId,
        taskConfig,
        timestamp: new Date().toISOString(),
      });

      // 2. KV second — dedup cache update
      deps.writeCardUpsertEntry(baseRef, cardId, { blobRef, taskConfigHash, updatedAt: new Date().toISOString() });
    }

    if (restart) {
      deps.appendEventToJournal(baseRef, {
        type: 'task-restart',
        taskName: cardId,
        timestamp: new Date().toISOString(),
      });
    }

    return `Card "${cardId}" ${existing ? 'upserted (updated)' : 'upserted (inserted)'}${restart ? ' (restarted)' : ''}.`;
  }

  function cmdUpsertCard(args: string[]): void {
    const brIdx = args.indexOf('--base-ref');
    const cardIdIdx = args.indexOf('--card-id');
    const restart = args.includes('--restart');
    const baseRefRaw = brIdx !== -1 ? args[brIdx + 1] : undefined;
    const baseRef = baseRefRaw ? parseRef(baseRefRaw) : undefined;
    const cardId = cardIdIdx !== -1 ? args[cardIdIdx + 1] : undefined;

    if (!baseRef || !cardId) {
      console.error('Usage: board-live-cards upsert-card --base-ref <::kind::value> --card-id <id> [--restart]');
      process.exit(1);
    }

    const msg = upsertCardById(baseRef, cardId, restart);
    void deps.processAccumulatedEventsInfinitePass(baseRef);
    console.log(msg);
  }

  return { cmdUpsertCard, upsertCardById };
}

