import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { cli, loadBoard } from '../../src/cli/board-live-cards-cli.js';
import type { BoardLiveCard } from '../../src/cli/board-live-cards-cli.js';

process.env.BOARD_LIVE_CARDS_NO_SPAWN = '1';

const ticks = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function pollBoard(dir: string, pred: (tasks: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const live = loadBoard(dir);
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

  it('writes provided token payloads to runtime-out/data-objects', async () => {
    const dir = path.join(freshDir(), 'board');
    const runtimeOutDir = path.join(tmpDir, 'runtime-out');
    cli(['init', dir, '--runtime-out', runtimeOutDir]);

    const cardFile = path.join(tmpDir, 'orders-source.json');
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
    fs.writeFileSync(cardFile, JSON.stringify(card));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['upsert-card', '--rg', dir, '--card', cardFile]);
    logSpy.mockRestore();

    await pollBoard(dir, (tasks) => !!tasks['orders-source']);

    const ordersFile = path.join(runtimeOutDir, 'data-objects', 'orders');
    const metadataFile = path.join(runtimeOutDir, 'data-objects', 'metadata');
    await pollForFile(ordersFile);
    await pollForFile(metadataFile);

    expect(JSON.parse(fs.readFileSync(ordersFile, 'utf-8'))).toEqual(card.card_data?.orders);
    expect(JSON.parse(fs.readFileSync(metadataFile, 'utf-8'))).toEqual(card.card_data?.metadata);
  });

  it('writes computed_values snapshots even when the card has no provides', async () => {
    const dir = path.join(freshDir(), 'board');
    const runtimeOutDir = path.join(tmpDir, 'runtime-out');
    cli(['init', dir, '--runtime-out', runtimeOutDir]);

    const cardFile = path.join(tmpDir, 'totals.json');
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
    fs.writeFileSync(cardFile, JSON.stringify(card));

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    cli(['upsert-card', '--rg', dir, '--card', cardFile]);
    logSpy.mockRestore();

    await pollBoard(dir, (tasks) => !!tasks['totals-card']);

    const computedFile = path.join(runtimeOutDir, 'cards', 'totals-card.computed.json');
    await pollForFile(computedFile);

    expect(JSON.parse(fs.readFileSync(computedFile, 'utf-8'))).toEqual({
      schema_version: 'v1',
      card_id: 'totals-card',
      computed_values: {
        total: 50,
        count: 3,
      },
    });
  });
});
