import type { LiveCard } from '../continuous-event-graph/live-cards-bridge.js';
import type { GraphEvent, TaskConfig } from '../event-graph/types.js';
import type { CardUpsertIndexEntry, CardStore } from './board-live-cards-all-stores.js';

export type BoardLiveCard = LiveCard;

// CardCommandDeps — all platform-specific concerns are injected
interface CardCommandDeps {
  /** Compute a stable content hash of a TaskConfig for dedup. Injected to keep this module platform-free. */
  hashTaskConfig: (taskConfig: TaskConfig) => string;
  /** Read a card from the board's authoritative CardStore. */
  getCardStore: (boardDir: string) => CardStore;
  /**
   * Read the KV dedup entry for a card. Returns null if the card has never been upserted.
   */
  readCardUpsertEntry: (boardDir: string, cardId: string) => CardUpsertIndexEntry | null;
  /**
   * Write the KV dedup entry AFTER the journal entry has been appended.
   */
  writeCardUpsertEntry: (boardDir: string, cardId: string, entry: CardUpsertIndexEntry) => void;
  liveCardToTaskConfig: (card: BoardLiveCard) => TaskConfig;
  appendEventToJournal: (boardDir: string, event: GraphEvent) => void;
  processAccumulatedEventsInfinitePass: (boardDir: string) => Promise<boolean>;
}

export interface CardCommandHandlers {
  cmdUpsertCard: (args: string[]) => void;
  /** Core upsert: card must already be in CardStore. Used by compat layer and clean CLI. */
  upsertCardById: (boardDir: string, cardId: string, restart: boolean) => string;
}

export function createCardCommandHandlers(deps: CardCommandDeps): CardCommandHandlers {
  /**
   * Core upsert logic: given a card already in CardStore, hash, dedup, journal.
   * Called by clean CLI (--card-id) and by compat layer (after writing card to store).
   */
  function upsertCardById(boardDir: string, cardId: string, restart: boolean): string {
    const card = deps.getCardStore(boardDir).readCard(cardId);
    if (!card) {
      throw new Error(`Card "${cardId}" not found in CardStore at ${boardDir}`);
    }

    const taskConfig = deps.liveCardToTaskConfig(card);
    const taskConfigHash = deps.hashTaskConfig(taskConfig);
    const existing = deps.readCardUpsertEntry(boardDir, cardId);
    const taskConfigChanged = existing?.taskConfigHash !== taskConfigHash;

    if (!taskConfigChanged && !restart) {
      return `Card "${cardId}" unchanged — skipped.`;
    }

    if (taskConfigChanged) {
      const blobRef = existing?.blobRef ?? deps.getCardStore(boardDir).readCardKey(cardId) ?? cardId;

      // 1. Journal first — card blob is already in CardStore
      deps.appendEventToJournal(boardDir, {
        type: 'task-upsert',
        taskName: cardId,
        taskConfig,
        timestamp: new Date().toISOString(),
      });

      // 2. KV second — dedup cache update
      deps.writeCardUpsertEntry(boardDir, cardId, { blobRef, taskConfigHash, updatedAt: new Date().toISOString() });
    }

    if (restart) {
      deps.appendEventToJournal(boardDir, {
        type: 'task-restart',
        taskName: cardId,
        timestamp: new Date().toISOString(),
      });
    }

    return `Card "${cardId}" ${existing ? 'upserted (updated)' : 'upserted (inserted)'}${restart ? ' (restarted)' : ''}.`;
  }

  function cmdUpsertCard(args: string[]): void {
    const rgIdx = args.indexOf('--rg');
    const cardIdIdx = args.indexOf('--card-id');
    const restart = args.includes('--restart');
    const boardDir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
    const cardId = cardIdIdx !== -1 ? args[cardIdIdx + 1] : undefined;

    if (!boardDir || !cardId) {
      console.error('Usage: board-live-cards upsert-card --rg <dir> --card-id <id> [--restart]');
      process.exit(1);
    }

    const msg = upsertCardById(boardDir, cardId, restart);
    void deps.processAccumulatedEventsInfinitePass(boardDir);
    console.log(msg);
  }

  return { cmdUpsertCard, upsertCardById };
}

