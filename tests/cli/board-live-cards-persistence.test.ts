import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createBoardLiveCardsPublic,
} from '../../src/cli/common/board-live-cards-public.js';
import {
  createFsBoardPlatformAdapter,
} from '../../src/cli/node/fs-board-adapter.js';
import {
  createStateSnapshotStore,
  snapshotEntriesToBoardEnvelope,
  BOARD_GRAPH_KEY,
  createCardStore,
} from '../../src/cli/common/board-live-cards-lib.js';
import type { BoardLiveCard } from '../../src/cli/common/board-live-cards-lib.js';
import { createCardStorePublic } from '../../src/cli/common/card-store-lib-public.js';
import { createFsStateSnapshotStorageAdapter, createFsCardStorageAdapter } from '../../src/cli/node/storage-fs-adapters.js';
import { restore } from '../../src/continuous-event-graph/index.js';

process.env.BOARD_LIVE_CARDS_NO_SPAWN = '1';

const ref = (d: string) => ({ kind: 'fs-path' as const, value: d });
const cardStoreRef = (boardDir: string) => '::fs-path::' + path.join(boardDir, '.cards');
const outputsStoreRef = (boardDir: string) => '::fs-path::' + path.join(boardDir, '.output');
const ticks = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const cliDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));

function board(dir: string) {
  const br = ref(dir);
  return createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} }));
}

const snapshotStore = createStateSnapshotStore(createFsStateSnapshotStorageAdapter());

function loadBoard(baseRef: { kind: string; value: string }) {
  const snap = snapshotStore.readSnapshot(baseRef.value);
  if (!snap.values[BOARD_GRAPH_KEY]) throw new Error(`Missing board state at: ${baseRef.value}`);
  return restore(snapshotEntriesToBoardEnvelope(snap.values).graph);
}

function writeCardToStore(boardDir: string, card: { id: string } & Record<string, unknown>): void {
  const result = createCardStorePublic(
    createCardStore(createFsCardStorageAdapter(path.join(boardDir, '.cards'))),
  ).set({ body: card });
  if (result.status !== 'success') throw new Error(`writeCardToStore failed: ${result.error}`);
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
    board(dir).init({ params: { cardStoreRef: cardStoreRef(dir), outputsStoreRef: outputsStoreRef(dir) } });

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

    board(dir).upsertCard({ params: { cardId: 'orders-source' } });

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
    board(dir).init({ params: { cardStoreRef: cardStoreRef(dir), outputsStoreRef: outputsStoreRef(dir) } });

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

    board(dir).upsertCard({ params: { cardId: 'totals-card' } });

    await pollBoard(dir, (tasks) => !!tasks['totals-card']);

    const computedFile = path.join(dir, '.output', 'cards', 'totals-card', 'computed_values.json');
    await pollForFile(computedFile);

    expect(JSON.parse(fs.readFileSync(computedFile, 'utf-8'))).toEqual({
      total: 50,
      count: 3,
    });
  });
});
