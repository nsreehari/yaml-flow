import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cli, loadBoard,
  createBoardLiveCardsNonCorePublic, createFsBoardNonCorePlatformAdapter,
} from '../../src/cli/board-live-cards-cli.js';
import type { BoardLiveCard } from '../../src/cli/board-live-cards-cli.js';

process.env.BOARD_LIVE_CARDS_NO_SPAWN = '1';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const ref = (d: string) => ({ kind: 'fs-path' as const, value: d });
const ticks = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function writeCardToStore(boardDir: string, card: { id: string } & Record<string, unknown>): void {
  const br = ref(boardDir);
  const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, testDir, { onWarn: () => {} }));
  nonCore.updateInCardStore({ params: { cardId: card.id }, body: card });
}

async function pollBoard(boardDir: string, pred: (tasks: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = loadBoard(ref(boardDir));
    if (pred(live.config.tasks as Record<string, unknown>)) return;
    await ticks(100);
  }
  throw new Error('pollBoard timed out');
}

async function pollForFile(filePath: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await ticks(100);
  }
  throw new Error(`pollForFile timed out: ${filePath}`);
}

describe('board-live-cards CLI persistence', () => {
  let tmpDir = '';

  function freshDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-persistence-test-'));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  });

  it('writes provided token payloads to .output/data-objects/', async () => {
    const dir = path.join(freshDir(), 'board');
    await cli(['init', '--base-ref', '::fs-path::' + dir]);

    const card: BoardLiveCard = {
      id: 'orders-source',
      provides: [
        { bindTo: 'orders', ref: 'card_data.orders' },
        { bindTo: 'metadata', ref: 'card_data.metadata' },
      ],
      card_data: {
        orders: [
          { id: 'ORD-1', amount: 10 },
          { id: 'ORD-2', amount: 20 },
        ],
        metadata: { source: 'test-suite', version: 1 },
      },
    };
    writeCardToStore(dir, card);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cli(['upsert-card', '--base-ref', '::fs-path::' + dir, '--card-id', 'orders-source']);
    logSpy.mockRestore();

    await pollBoard(dir, (tasks) => !!tasks['orders-source']);

    const dataObjectsDir = path.join(dir, '.output', 'data-objects');
    const ordersFile = path.join(dataObjectsDir, 'orders.json');
    const metadataFile = path.join(dataObjectsDir, 'metadata.json');
    await pollForFile(ordersFile);
    await pollForFile(metadataFile);

    expect(JSON.parse(fs.readFileSync(ordersFile, 'utf-8'))).toEqual(card.card_data?.orders);
    expect(JSON.parse(fs.readFileSync(metadataFile, 'utf-8'))).toEqual(card.card_data?.metadata);
  });

  it('writes computed_values snapshots to .output/cards/<cardId>/computed_values.json', async () => {
    const dir = path.join(freshDir(), 'board');
    await cli(['init', '--base-ref', '::fs-path::' + dir]);

    const card: BoardLiveCard = {
      id: 'totals-card',
      card_data: {
        items: [{ value: 5 }, { value: 15 }, { value: 30 }],
      },
      compute: [
        { bindTo: 'total', expr: '$sum(card_data.items.value)' },
        { bindTo: 'count', expr: '$count(card_data.items)' },
      ],
    };
    writeCardToStore(dir, card);

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await cli(['upsert-card', '--base-ref', '::fs-path::' + dir, '--card-id', 'totals-card']);
    logSpy.mockRestore();

    await pollBoard(dir, (tasks) => !!tasks['totals-card']);

    const computedFile = path.join(dir, '.output', 'cards', 'totals-card', 'computed_values.json');
    await pollForFile(computedFile);

    expect(JSON.parse(fs.readFileSync(computedFile, 'utf-8'))).toEqual({
      total: 50,
      count: 3,
    });
  });
});
