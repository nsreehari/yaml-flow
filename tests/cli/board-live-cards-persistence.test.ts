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
import { createStateSnapshotAdapter } from '../../src/cli/common/board-live-cards-storage.js';
import type { BoardLiveCard } from '../../src/cli/common/board-live-cards-lib.js';
import { createCardStorePublic } from '../../src/cli/common/card-store-lib-public.js';
import { computeStableJsonHash, createFsCardStorageAdapter, createFsKvStorage } from '../../src/cli/node/storage-fs-adapters.js';
import { restore } from '../../src/continuous-event-graph/index.js';
import { parseRef, serializeRef } from '../../src/cli/common/storage-interface.js';



const ref = (d: string) => ({ kind: 'fs-path' as const, value: d });
const boardRuntimeStoreRef = (boardDir: string) => serializeRef({ kind: 'fs-path', value: path.join(boardDir, '.runtime-board') });
const queueStoreRef = (boardDir: string) => serializeRef({ kind: 'fs-path', value: path.join(boardDir, '.queue') });
const cardStoreRef = (boardDir: string) => serializeRef({ kind: 'fs-path', value: path.join(boardDir, '.cards') });
const outputsStoreRef = (boardDir: string) => serializeRef({ kind: 'fs-path', value: path.join(boardDir, '.output') });
const chatStoreRef = (boardDir: string) => serializeRef({ kind: 'fs-path', value: path.join(boardDir, '.chat') });
const artifactsStoreRef = (boardDir: string) => serializeRef({ kind: 'fs-path', value: path.join(boardDir, '.files') });
const fetchedSourcesStoreRef = (boardDir: string) => serializeRef({ kind: 'fs-path', value: path.join(boardDir, '.sources') });
const scratchStoreRef = (boardDir: string) => serializeRef({ kind: 'fs-path', value: path.join(boardDir, '.scratch') });
const archiveStoreRef = (boardDir: string) => serializeRef({ kind: 'fs-path', value: path.join(boardDir, '.archive') });
const initParams = (boardDir: string) => ({
  boardRuntimeStoreRef: boardRuntimeStoreRef(boardDir),
  queueStoreRef: queueStoreRef(boardDir),
  cardStoreRef: cardStoreRef(boardDir),
  outputsStoreRef: outputsStoreRef(boardDir),
  chatStoreRef: chatStoreRef(boardDir),
  artifactsStoreRef: artifactsStoreRef(boardDir),
  fetchedSourcesStoreRef: fetchedSourcesStoreRef(boardDir),
  scratchStoreRef: scratchStoreRef(boardDir),
  archiveStoreRef: archiveStoreRef(boardDir),
});
const ticks = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const cliDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));

function board(dir: string) {
  const br = ref(dir);
  return createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {}, suppressSpawn: true }), {
    boardRuntimeStoreRef: boardRuntimeStoreRef(dir),
  });
}

const snapshotStore = createStateSnapshotStore(createStateSnapshotAdapter((scopeId) => createFsKvStorage(scopeId), computeStableJsonHash));

function loadBoard(baseRef: { kind: string; value: string }) {
  const runtimePath = parseRef(boardRuntimeStoreRef(baseRef.value)).value;
  const snap = snapshotStore.readSnapshot(runtimePath);
  if (!snap.values[BOARD_GRAPH_KEY]) throw new Error(`Missing board state at: ${runtimePath}`);
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
    const liveBoard = board(dir);
    liveBoard.init({ params: initParams(dir) });

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

    liveBoard.upsertCard({ params: { cardId: 'orders-source' } });
    expect((await liveBoard.processAccumulatedEvents({})).status).toBe('success');

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
    const liveBoard = board(dir);
    liveBoard.init({ params: initParams(dir) });

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

    liveBoard.upsertCard({ params: { cardId: 'totals-card' } });
    expect((await liveBoard.processAccumulatedEvents({})).status).toBe('success');

    await pollBoard(dir, (tasks) => !!tasks['totals-card']);

    const computedFile = path.join(dir, '.output', 'cards', 'totals-card', 'computed_values.json');
    await pollForFile(computedFile);

    expect(JSON.parse(fs.readFileSync(computedFile, 'utf-8'))).toEqual({
      total: 50,
      count: 3,
    });
  });
});
