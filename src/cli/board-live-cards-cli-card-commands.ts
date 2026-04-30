import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { LiveCard } from '../continuous-event-graph/live-cards-bridge.js';
import type { GraphEvent, TaskConfig } from '../event-graph/types.js';
import type { CardUpsertIndexEntry } from './board-live-cards-all-stores.js';

export type BoardLiveCard = LiveCard;

interface CardCommandDeps {
  resolveCardGlobMatches: (cardGlob: string) => string[];
  /**
   * Read the KV dedup entry for a card. Returns null if the card has never been upserted.
   * boardDir is passed so the dep can locate the right KV store without capturing it at construction time.
   */
  readCardUpsertEntry: (boardDir: string, cardId: string) => CardUpsertIndexEntry | null;
  /**
   * Write the KV dedup entry AFTER the journal entry has been appended.
   * Always called after appendEventToJournal — never before.
   */
  writeCardUpsertEntry: (boardDir: string, cardId: string, entry: CardUpsertIndexEntry) => void;
  /**
   * Derive the logical blobRef for a brand-new card (first upsert).
   * For fs: returns the absolute card file path.
   */
  defaultBlobRef: (cardId: string, absCardPath: string) => string;
  liveCardToTaskConfig: (card: BoardLiveCard) => TaskConfig;
  appendEventToJournal: (boardDir: string, event: GraphEvent) => void;
  processAccumulatedEventsInfinitePass: (boardDir: string) => Promise<boolean>;
}

export interface CardCommandHandlers {
  cmdUpsertCard: (args: string[]) => void;
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${(value as unknown[]).map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(',')}}`;
}

function computeTaskConfigHash(taskConfig: TaskConfig): string {
  return createHash('sha256').update(stableJson(taskConfig)).digest('hex');
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

    // -----------------------------------------------------------------------
    // Phase 1: validate entire batch before writing anything
    // -----------------------------------------------------------------------
    const batchByCardId = new Map<string, string>();   // cardId  → absPath
    const batchByCardPath = new Map<string, string>(); // absPath → cardId
    const plans: Array<{ card: BoardLiveCard; absCardPath: string }> = [];

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

      // Within-batch duplicate checks
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

      // Cross-batch id→file remapping guard (read KV once here for validation)
      const existing = deps.readCardUpsertEntry(dir, card.id);
      if (existing && existing.blobRef !== absCardPath) {
        console.error(
          `Upsert rejected: card id "${card.id}" is already mapped to "${existing.blobRef}", cannot remap to "${absCardPath}"`
        );
        process.exit(1);
      }

      batchByCardPath.set(absCardPath, card.id);
      batchByCardId.set(card.id, absCardPath);
      plans.push({ card, absCardPath });
    }

    // -----------------------------------------------------------------------
    // Phase 2: per-card hash check → journal (truth) → KV (cache)
    //
    // Write order: journal.append() THEN kv.write()
    // A crash between the two leaves a stale KV — the next upsert will see
    // "changed" and re-append a task-upsert; addNode is idempotent in the board.
    // -----------------------------------------------------------------------
    let changedCount = 0;
    let skippedCount = 0;
    const logs: string[] = [];

    for (const { card, absCardPath } of plans) {
      const taskConfig = deps.liveCardToTaskConfig(card);
      const taskConfigHash = computeTaskConfigHash(taskConfig);
      const existing = deps.readCardUpsertEntry(dir, card.id);
      const taskConfigChanged = existing?.taskConfigHash !== taskConfigHash;

      if (!taskConfigChanged && !restart) {
        skippedCount++;
        logs.push(`Card "${card.id}" unchanged — skipped.`);
        continue;
      }

      if (taskConfigChanged) {
        const blobRef = existing?.blobRef ?? deps.defaultBlobRef(card.id, absCardPath);

        // 1. Journal first — card blob is already on disk at absCardPath
        deps.appendEventToJournal(dir, {
          type: 'task-upsert',
          taskName: card.id,
          taskConfig,
          timestamp: new Date().toISOString(),
        });

        // 2. KV second — dedup cache update
        deps.writeCardUpsertEntry(dir, card.id, { blobRef, taskConfigHash, updatedAt: new Date().toISOString() });
      }

      if (restart) {
        deps.appendEventToJournal(dir, {
          type: 'task-restart',
          taskName: card.id,
          timestamp: new Date().toISOString(),
        });
      }

      changedCount++;
      logs.push(`Card "${card.id}" ${existing ? 'upserted (updated)' : 'upserted (inserted)'}${restart ? ' (restarted)' : ''}.`);
    }

    if (changedCount > 0) {
      void deps.processAccumulatedEventsInfinitePass(dir);
    }

    if (cardGlob) {
      console.log(
        `Processed ${cardFiles.length} cards from glob: ${cardGlob} ` +
        `(${changedCount} changed, ${skippedCount} skipped)${restart ? ' (restarted)' : ''}`
      );
    } else if (logs.length > 0) {
      console.log(logs[0]);
    }
  }

  return { cmdUpsertCard };
}

