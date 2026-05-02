import * as fs from 'node:fs';
import * as path from 'node:path';
import fg from 'fast-glob';
import type { LiveCard, CardAdminStore } from './board-live-cards-all-stores.js';
import type { CommandResponse } from './board-live-cards-lib-types.js';
import { Resp } from './board-live-cards-lib-types.js';
import { createFsKvStorage } from './storage-fs-adapters.js';
import { serializeRef } from './storage-interface.js';
import type { KindValueRef } from './storage-interface.js';

export type BoardLiveCard = LiveCard;

/** KV-backed index of cardId → absolute source file path, maintained by the compat layer. */
function getCompatSourceKv(boardDir: string) {
  return createFsKvStorage(path.join(boardDir, '.compat-card-sources'));
}

interface CompatDeps {
  getCardAdminStore: (baseRef: KindValueRef) => CardAdminStore;
  upsertCardById: (baseRef: KindValueRef, cardId: string, restart: boolean) => string;
  validateCards: (cards: Record<string, unknown>[], baseRef: KindValueRef | undefined) => CommandResponse<{ cardId: string; errors: string[] }>[];
  processAccumulatedEventsInfinitePass: (baseRef: KindValueRef) => Promise<boolean>;
  cmdSourceDataFetched: (args: string[]) => void;
}

export interface CompatCommandHandlers {
  compatUpsertCard: (args: string[]) => void;
  compatValidateCard: (args: string[]) => void;
  compatSourceDataFetchedTmp: (args: string[]) => void;
}

export function createCompatCommandHandlers(deps: CompatDeps): CompatCommandHandlers {

  function resolveCardGlobMatches(cardGlob: string): string[] {
    const patterns = cardGlob
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
      .map(p => p.replace(/\\/g, '/'));
    const matches = fg.sync(patterns, { absolute: true, onlyFiles: true, unique: true, dot: false });
    return [...matches].map(m => path.resolve(m)).sort((a, b) => a.localeCompare(b));
  }

  function readCardFromFile(filePath: string): BoardLiveCard {
    if (!fs.existsSync(filePath)) throw new Error(`Card file not found: ${filePath}`);
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as BoardLiveCard;
    } catch (err) {
      throw new Error(`Invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function compatUpsertCard(args: string[]): void {
    const rgIdx = args.indexOf('--rg');
    const cardIdx = args.indexOf('--card');
    const globIdx = args.indexOf('--card-glob');
    const restart = args.includes('--restart');
    const boardDirRaw = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
    const boardRef: KindValueRef | undefined = boardDirRaw ? { kind: 'fs-path', value: path.resolve(boardDirRaw) } : undefined;
    const cardFile = cardIdx !== -1 ? args[cardIdx + 1] : undefined;
    const cardGlob = globIdx !== -1 ? args[globIdx + 1] : undefined;

    if (!boardRef || (!cardFile && !cardGlob) || (cardFile && cardGlob)) {
      console.error('Usage: board-live-cards upsert-card --rg <dir> (--card <card.json> | --card-glob <glob>) [--restart]');
      process.exit(1);
    }

    const files = cardFile
      ? [path.resolve(cardFile)]
      : resolveCardGlobMatches(cardGlob!);

    if (files.length === 0) {
      console.error(`No card files matched glob: ${cardGlob}`);
      process.exit(1);
    }

    // Phase 1: parse all files, check for duplicates and id→path remapping
    const plans: Array<{ card: BoardLiveCard; absPath: string }> = [];
    const seenIds = new Map<string, string>(); // cardId → absPath
    const compatKv = getCompatSourceKv(boardRef.value);

    for (const absPath of files) {
      const card = readCardFromFile(absPath);
      if (!card.id) {
        console.error(`Card JSON must have an "id" field (${absPath})`);
        process.exit(1);
      }
      const conflict = seenIds.get(card.id);
      if (conflict && conflict !== absPath) {
        console.error(`Upsert rejected: card id "${card.id}" appears in multiple files ("${conflict}" vs "${absPath}")`);
        process.exit(1);
      }
      seenIds.set(card.id, absPath);
      // Check id→path remapping: if card was previously upserted from a different file, reject
      const knownPath = compatKv.read(card.id) as string | null;
      if (knownPath && path.resolve(knownPath) !== absPath) {
        console.error(
          `Upsert rejected: card id "${card.id}" is already registered at "${knownPath}" ` +
          `— refusing to remap from "${absPath}"`,
        );
        process.exit(1);
      }
      plans.push({ card, absPath });
    }

    // Phase 2: write to CardStore then upsert via clean handler (which expects --base-ref)
    const store = deps.getCardAdminStore(boardRef);
    let changedCount = 0;
    let skippedCount = 0;
    const logs: string[] = [];

    for (const { card } of plans) {
      store.writeCard(card.id, card);
      const msg = deps.upsertCardById(boardRef, card.id, restart);
      if (msg.includes('skipped')) { skippedCount++; } else { changedCount++; }
      logs.push(msg);
      compatKv.write(card.id, plans.find(p => p.card === card)!.absPath);
    }

    if (changedCount > 0) {
      void deps.processAccumulatedEventsInfinitePass(boardRef);
    }

    if (cardGlob) {
      console.log(
        `Processed ${files.length} cards from glob: ${cardGlob} ` +
        `(${changedCount} changed, ${skippedCount} skipped)${restart ? ' (restarted)' : ''}`,
      );
    } else if (logs.length > 0) {
      console.log(logs[0]);
    }
  }

  function compatValidateCard(args: string[]): void {
    const rgIdx = args.indexOf('--rg');
    const cardIdx = args.indexOf('--card');
    const globIdx = args.indexOf('--card-glob');
    const boardDirRaw = rgIdx !== -1 ? args[rgIdx + 1] : undefined;
    // Internally resolve --rg to an absolute path; downstream validateCards receives the ref
    const boardRef: KindValueRef | undefined = boardDirRaw ? { kind: 'fs-path', value: path.resolve(boardDirRaw) } : undefined;
    const cardFile = cardIdx !== -1 ? args[cardIdx + 1] : undefined;
    const cardGlob = globIdx !== -1 ? args[globIdx + 1] : undefined;

    if ((!cardFile && !cardGlob) || (cardFile && cardGlob)) {
      throw new Error('Usage: board-live-cards validate-card (--card <card.json> | --card-glob <glob>) [--rg <boardDir>]');
    }

    const files = cardFile
      ? [path.resolve(cardFile)]
      : resolveCardGlobMatches(cardGlob!);

    if (files.length === 0) {
      throw new Error(`No card files matched glob: ${cardGlob}`);
    }

    // Parse files, collecting I/O errors separately
    const cards: Record<string, unknown>[] = [];
    const fileErrors: Array<{ label: string; error: string }> = [];

    for (const f of files) {
      const label = path.relative(process.cwd(), f) || f;
      if (!fs.existsSync(f)) {
        fileErrors.push({ label, error: 'file not found' });
        continue;
      }
      try {
        cards.push(JSON.parse(fs.readFileSync(f, 'utf-8')));
      } catch (err) {
        fileErrors.push({ label, error: `invalid JSON — ${err instanceof Error ? err.message : String(err)}` });
      }
    }

    for (const { label, error } of fileErrors) {
      console.error(`FAIL  ${label}: ${error}`);
    }

    // Validate parsed cards via clean handler
    const results = deps.validateCards(cards, boardRef);
    let failures = fileErrors.length;

    for (const r of results) {
      const label = r.data.cardId;
      if (Resp.isSuccess(r)) {
        console.log(`OK    ${label}`);
      } else {
        console.error(`FAIL  ${label}:`);
        for (const err of r.data.errors) console.error(`        ${err}`);
        failures++;
      }
    }

    if (failures > 0) {
      throw new Error(`${failures} of ${files.length} card(s) failed validation.`);
    }
    console.log(`\n${files.length} card(s) passed validation.`);
  }

  function compatSourceDataFetchedTmp(args: string[]): void {
    const tmpIdx = args.indexOf('--tmp');
    if (tmpIdx === -1 || !args[tmpIdx + 1]) {
      console.error('Usage (compat): board-live-cards source-data-fetched --tmp <file> --token <sourceToken>');
      process.exit(1);
    }
    const tmpFile = args[tmpIdx + 1];
    const remainingArgs = args.filter((_, i) => i !== tmpIdx && i !== tmpIdx + 1);
    deps.cmdSourceDataFetched([...remainingArgs, '--ref', serializeRef({ kind: 'fs-path', value: tmpFile })]);
  }

  return { compatUpsertCard, compatValidateCard, compatSourceDataFetchedTmp };
}

