import * as fs from 'node:fs';
import * as path from 'node:path';
import type { LiveCard } from '../continuous-event-graph/live-cards-bridge.js';
import type { GraphEvent, TaskConfig } from '../event-graph/types.js';

export type BoardLiveCard = LiveCard;

export interface CardInventoryEntry {
  cardId: string;
  cardFilePath: string;
  addedAt: string;
}

export interface CardInventoryIndex {
  byCardId: Map<string, CardInventoryEntry>;
  byCardPath: Map<string, CardInventoryEntry>;
}

interface CardCommandDeps {
  resolveCardGlobMatches: (cardGlob: string) => string[];
  buildCardInventoryIndex: (boardDir: string) => CardInventoryIndex;
  appendCardInventory: (boardDir: string, entry: CardInventoryEntry) => void;
  liveCardToTaskConfig: (card: BoardLiveCard) => TaskConfig;
  appendEventToJournal: (boardDir: string, event: GraphEvent) => void;
  processAccumulatedEventsInfinitePass: (boardDir: string) => Promise<boolean>;
}

export interface CardCommandHandlers {
  cmdUpsertCard: (args: string[]) => void;
}

export function createCardCommandHandlers(deps: CardCommandDeps): CardCommandHandlers {
  function cmdUpsertCard(args: string[]): void {
    const rgIdx = args.indexOf('--rg');
    const cardIdx = args.indexOf('--card');
    const globIdx = args.indexOf('--card-glob');
    const cardIdIdx = args.indexOf('--card-id');
    const restart = args.includes('--restart');
    const dir = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
    const cardFile = cardIdx !== -1 ? args[cardIdx + 1] : undefined;
    const cardGlob = globIdx !== -1 ? args[globIdx + 1] : undefined;
    const requestedCardId = cardIdIdx !== -1 ? args[cardIdIdx + 1] : undefined;

    if (!dir || (!cardFile && !cardGlob) || (cardFile && cardGlob)) {
      console.error('Usage: board-live-cards upsert-card --rg <dir> (--card <card.json> | --card-glob <glob>) [--card-id <card-id>] [--restart]');
      process.exit(1);
    }

    if (cardGlob && requestedCardId) {
      console.error('Usage: --card-id may be used only with --card (single file), not with --card-glob');
      process.exit(1);
    }

    const cardFiles = cardFile
      ? [path.resolve(cardFile)]
      : deps.resolveCardGlobMatches(cardGlob!);

    if (!cardFile && cardFiles.length === 0) {
      console.error(`No card files matched glob: ${cardGlob}`);
      process.exit(1);
    }

    const idx = deps.buildCardInventoryIndex(dir);
    const batchByCardId = new Map<string, string>();
    const batchByCardPath = new Map<string, string>();
    const plans: Array<{
      card: BoardLiveCard;
      absCardPath: string;
      isInsert: boolean;
    }> = [];
    const logs: string[] = [];

    // Phase 1: pre-validate entire batch (atomicity guard)
    for (const absCardPath of cardFiles) {
      if (!fs.existsSync(absCardPath)) {
        console.error(`Card file not found: ${absCardPath}`);
        process.exit(1);
      }

      const card: BoardLiveCard = JSON.parse(fs.readFileSync(absCardPath, 'utf-8'));
      if (!card.id) {
        console.error(`Card JSON must have an "id" field (${absCardPath})`);
        process.exit(1);
      }

      if (requestedCardId && requestedCardId !== card.id) {
        console.error(
          `Card id mismatch: --card-id "${requestedCardId}" does not match file id "${card.id}" (${absCardPath})`
        );
        process.exit(1);
      }

      const seenPathCardId = batchByCardPath.get(absCardPath);
      if (seenPathCardId && seenPathCardId !== card.id) {
        console.error(
          `Upsert rejected: file "${absCardPath}" appears multiple times in batch with conflicting ids ` +
          `("${seenPathCardId}" vs "${card.id}")`
        );
        process.exit(1);
      }

      const seenCardPath = batchByCardId.get(card.id);
      if (seenCardPath && seenCardPath !== absCardPath) {
        console.error(
          `Upsert rejected: card id "${card.id}" appears multiple times in batch with conflicting files ` +
          `("${seenCardPath}" vs "${absCardPath}")`
        );
        process.exit(1);
      }

      const existingById = idx.byCardId.get(card.id);
      const existingByPath = idx.byCardPath.get(absCardPath);

      // Enforce strict one-to-one mapping between card id and file path.
      if (existingByPath && existingByPath.cardId !== card.id) {
        console.error(
          `Upsert rejected: file "${absCardPath}" is already mapped to card id "${existingByPath.cardId}", ` +
          `cannot remap to "${card.id}"`
        );
        process.exit(1);
      }

      if (existingById && existingById.cardFilePath !== absCardPath) {
        console.error(
          `Upsert rejected: card id "${card.id}" is already mapped to file "${existingById.cardFilePath}", ` +
          `cannot remap to "${absCardPath}"`
        );
        process.exit(1);
      }

      batchByCardPath.set(absCardPath, card.id);
      batchByCardId.set(card.id, absCardPath);

      plans.push({
        card,
        absCardPath,
        isInsert: !existingById,
      });
    }

    // Phase 2: commit writes after full pre-validation succeeds
    for (const plan of plans) {
      const { card, absCardPath, isInsert } = plan;

      if (isInsert) {
        const newEntry: CardInventoryEntry = {
          cardId: card.id,
          cardFilePath: absCardPath,
          addedAt: new Date().toISOString(),
        };
        deps.appendCardInventory(dir, newEntry);
        idx.byCardId.set(card.id, newEntry);
        idx.byCardPath.set(absCardPath, newEntry);
      }

      const taskConfig = deps.liveCardToTaskConfig(card);
      deps.appendEventToJournal(dir, {
        type: 'task-upsert',
        taskName: card.id,
        taskConfig,
        timestamp: new Date().toISOString(),
      });

      if (restart) {
        deps.appendEventToJournal(dir, {
          type: 'task-restart',
          taskName: card.id,
          timestamp: new Date().toISOString(),
        });
      }

      logs.push(`Card "${card.id}" ${isInsert ? 'upserted (inserted)' : 'upserted (updated)'}${restart ? ' (restarted)' : ''}.`);
    }

    void deps.processAccumulatedEventsInfinitePass(dir);
    if (cardGlob) {
      console.log(`Upserted ${cardFiles.length} cards from glob: ${cardGlob}${restart ? ' (restarted)' : ''}`);
    } else {
      console.log(logs[0]);
    }
  }

  return { cmdUpsertCard };
}
