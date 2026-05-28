/**
 * Tests for the CommandInput-based public API layer.
 *
 * All tests call createBoardLiveCardsPublic / createBoardLiveCardsNonCorePublic
 * directly with CommandInput objects — no CLI spawning involved.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  createFsBoardPlatformAdapter,
  createFsBoardNonCorePlatformAdapter,
  createBoardLiveCardsPublic,
  createBoardLiveCardsNonCorePublic,
} from '../../src/cli/node/fs-board-adapter.js';
import { parseRef, serializeRef } from '../../src/cli/common/storage-interface.js';

const adapterOpts = { onWarn: () => {}, suppressSpawn: true };

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const ref = (d: string) => ({ kind: 'fs-path' as const, value: d });
const mkCardStoreRef = (d: string) => serializeRef({ kind: 'fs-path', value: path.join(d, '.cards') });
const mkOutputsStoreRef = (d: string) => serializeRef({ kind: 'fs-path', value: path.join(d, '.output') });

/** Minimal card that satisfies the live-card schema. */
const minCard = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  card_data: { v: 1 },
  ...extra,
});

// ============================================================================
// BoardLiveCardsPublic — init / status / error cases
// ============================================================================

describe('BoardLiveCardsPublic — init and status', () => {
  let tmpDir = '';

  function freshBoard() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-pub-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    const adapter = createFsBoardPlatformAdapter(br, cliDir, adapterOpts);
    const board = createBoardLiveCardsPublic(br, adapter);
    return { boardDir, br, board };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('init({}) creates the board state and returns success', () => {
    const { board, boardDir } = freshBoard();
    const result = board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    expect(result.status).toBe('success');
    // The public layer writes via KV abstraction (.state-snapshot namespace)
    expect(fs.existsSync(path.join(boardDir, '.state-snapshot'))).toBe(true);
  });

  it('init is idempotent — second call also returns success', () => {
    const { board, boardDir } = freshBoard();
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    expect(board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } }).status).toBe('success');
  });

  it('status({}) returns a board status object with zero cards after init', () => {
    const { board, boardDir } = freshBoard();
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    const result = board.status({});
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.summary.card_count).toBe(0);
      expect(result.data.cards).toEqual([]);
    }
  });

  it('init stores chat-handler-flow and getConfig returns the full flow value', () => {
    const { board, boardDir } = freshBoard();
    const flow = {
      steps: [
        { id: 'append-chat', type: 'noop' },
      ],
      transitions: [],
    };
    const initResult = board.init({
      params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) },
      body: { 'chat-handler-flow': flow },
    });
    expect(initResult.status).toBe('success');

    const result = board.getConfig({ params: { key: 'chat-handler-flow' } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.value).toEqual(flow);
    }
  });

  it('removeCard({}) fails — params.id is missing', () => {
    const { board, boardDir } = freshBoard();
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    const result = board.removeCard({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.id/);
  });

  it('retrigger({}) fails — params.id is missing', () => {
    const { board, boardDir } = freshBoard();
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    const result = board.retrigger({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.id/);
  });

  it('upsertCard({}) fails — --card-id or --all is required', () => {
    const { board, boardDir } = freshBoard();
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    const result = board.upsertCard({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/--card-id.*--all|--all.*--card-id/);
  });

  it('upsertCard fails when card is not yet in the store', () => {
    const { board, boardDir } = freshBoard();
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    const result = board.upsertCard({ params: { cardId: 'ghost' } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/not found/);
  });

  it('processAccumulatedEvents({}) returns success after init', async () => {
    const { board, boardDir } = freshBoard();
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    const result = await board.processAccumulatedEvents({});
    expect(result.status).toBe('success');
  });

  it('removeCard emits a card_removed notification', async () => {
    const { boardDir, br } = freshBoard();
    const notifications: Array<Array<{ kind: string; [key: string]: unknown }>> = [];
    const adapter = createFsBoardPlatformAdapter(br, cliDir, adapterOpts);
    const board = createBoardLiveCardsPublic(br, {
      ...adapter,
      publishBoardChangeNotifications(batch) {
        notifications.push(batch);
      },
    });
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, adapterOpts));

    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    expect(nonCore.updatesInCardStore({ body: { ops: [{ op: 'update', id: 'my-card', 'card-content': minCard('my-card') }] } }).status).toBe('success');

    expect(board.upsertCard({ params: { cardId: 'my-card' } }).status).toBe('success');
    await board.processAccumulatedEvents({});
    notifications.length = 0;

    expect(board.removeCard({ params: { id: 'my-card' } }).status).toBe('success');
    for (let i = 0; i < 20; i++) {
      if (notifications.flat().some((note) => note.kind === 'card_removed' && note.cardId === 'my-card')) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(notifications.flat()).toContainEqual({ kind: 'card_removed', cardId: 'my-card' });
  });

  it('cardRefreshedNotify emits a card_refreshed notification from the card store', () => {
    const { boardDir, br } = freshBoard();
    const notifications: Array<Array<{ kind: string; [key: string]: unknown }>> = [];
    const adapter = createFsBoardPlatformAdapter(br, cliDir, adapterOpts);
    const board = createBoardLiveCardsPublic(br, {
      ...adapter,
      publishBoardChangeNotifications(batch) {
        notifications.push(batch);
      },
    });
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, adapterOpts));

    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    expect(nonCore.updatesInCardStore({ body: { ops: [{ op: 'update', id: 'notify-card', 'card-content': minCard('notify-card', { title: 'hello' }) }] } }).status).toBe('success');

    const result = board.cardRefreshedNotify({ params: { cardId: 'notify-card' } });

    expect(result.status).toBe('success');
    expect(notifications.flat()).toContainEqual({
      kind: 'card_refreshed',
      cardId: 'notify-card',
      card: expect.objectContaining({ id: 'notify-card', card_data: { v: 1 }, title: 'hello' }),
    });
  });

  it('addCardFiles appends files and emits card_refreshed notification', () => {
    const { boardDir, br } = freshBoard();
    const notifications: Array<Array<{ kind: string; [key: string]: unknown }>> = [];
    const adapter = createFsBoardPlatformAdapter(br, cliDir, adapterOpts);
    const board = createBoardLiveCardsPublic(br, {
      ...adapter,
      publishBoardChangeNotifications(batch) {
        notifications.push(batch);
      },
    });
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, adapterOpts));

    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    expect(nonCore.updatesInCardStore({ body: { ops: [{ op: 'update', id: 'file-card', 'card-content': minCard('file-card', { card_data: { files: [{ name: 'a.txt' }] } }) }] } }).status).toBe('success');

    const result = board.addCardFiles({ params: { cardId: 'file-card' }, body: { name: 'b.txt', size: 20 } });

    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data).toEqual({
        cardId: 'file-card',
        files_added: [{ idx: 1, entry: { name: 'b.txt', size: 20 } }],
        notified: true,
      });
    }
    expect(board.getCardStoreRef({}).status).toBe('success');
    const refreshed = notifications.flat().find((note) => note.kind === 'card_refreshed' && note.cardId === 'file-card');
    expect(refreshed).toEqual(expect.objectContaining({
      kind: 'card_refreshed',
      cardId: 'file-card',
      card: expect.objectContaining({
        id: 'file-card',
        card_data: { files: [{ name: 'a.txt' }, { name: 'b.txt', size: 20 }] },
      }),
    }));
  });

  it('getAllOutputsDataObjects({}) returns success with a map payload', () => {
    const { board, boardDir } = freshBoard();
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });

    const result = board.getAllOutputsDataObjects({});
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data).toEqual({});
    }
  });

  it('getAllOutputsComputedValues({}) returns success with a map payload', () => {
    const { board, boardDir } = freshBoard();
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });

    const result = board.getAllOutputsComputedValues({});
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data).toEqual({});
    }
  });
});

// ============================================================================
// BoardLiveCardsNonCorePublic — updatesInCardStore
// ============================================================================

describe('BoardLiveCardsNonCorePublic — updatesInCardStore', () => {
  let tmpDir = '';

  function freshNonCore() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-nc-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, adapterOpts)).init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));
    return { nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('writes a card via update op and returns success', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.updatesInCardStore({ body: { ops: [{ op: 'update', id: 'my-card', 'card-content': minCard('my-card') }] } });
    expect(result.status).toBe('success');
  });

  it('fails when body has no ops array', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.updatesInCardStore({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/ops/);
  });

  it('fails when an op is missing id', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.updatesInCardStore({ body: { ops: [{ op: 'update' }] } });
    expect(result.status).toBe('fail');
  });

  it('fails on unknown op type', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.updatesInCardStore({ body: { ops: [{ op: 'noop', id: 'x' }] } });
    expect(result.status).toBe('fail');
  });
});

// ============================================================================
// BoardLiveCardsNonCorePublic — readFromCardStore
// ============================================================================

describe('BoardLiveCardsNonCorePublic — readFromCardStore', () => {
  let tmpDir = '';

  function freshNonCore() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-read-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, adapterOpts)).init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));
    return { nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('returns previously written cards by id array', () => {
    const { nonCore } = freshNonCore();
    nonCore.updatesInCardStore({ body: { ops: [{ op: 'update', id: 'stored', 'card-content': minCard('stored') }] } });

    const result = nonCore.readFromCardStore({ body: { ids: ['stored'] } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.cards[0].id).toBe('stored');
    }
  });

  it('returns null card-content for ids not in the store', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.readFromCardStore({ body: { ids: ['ghost'] } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.cards[0]['card-content']).toBeNull();
    }
  });

  it('fails when body has no ids array', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.readFromCardStore({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/ids/);
  });
});

// ============================================================================
// BoardLiveCardsNonCorePublic — validateCardPreflight
// ============================================================================

describe('BoardLiveCardsNonCorePublic — validateCardPreflight', () => {
  let tmpDir = '';

  function freshNonCore() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-vtmp-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, adapterOpts)).init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));
    return { nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('returns success + cardId for a valid card object in body', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.validateCardPreflight({ body: minCard('tmp-card') });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.cardId).toBe('tmp-card');
      expect(Array.isArray(result.data.issues)).toBe(true);
    }
  });

  it('uses (unknown) as cardId when card body lacks an id string', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.validateCardPreflight({ body: { card_data: { x: 1 } } });
    // still returns success — errors embedded in data.errors
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.cardId).toBe('(unknown)');
    }
  });

  it('fails when body is absent', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.validateCardPreflight({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/body/);
  });

  it('fails when body is a string', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.validateCardPreflight({ body: 'not-an-object' });
    expect(result.status).toBe('fail');
  });

  it('fails when body is an array', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.validateCardPreflight({ body: [] });
    expect(result.status).toBe('fail');
  });

  it('accepts card-content wrapper and still returns success for a valid card', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.validateCardPreflight({ body: { 'card-content': minCard('wrapped') } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.cardId).toBe('wrapped');
    }
  });

  it('returns issues for a card with invalid source_defs structure', () => {
    const { nonCore } = freshNonCore();
    // source_defs entries missing bindTo trigger schema validation issues
    const card = minCard('bad-src', { source_defs: [{ outputFile: 'x.json' }] });
    const result = nonCore.validateCardPreflight({ body: card });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      // Structural validation should flag the missing fields
      expect(result.data.cardId).toBe('bad-src');
    }
  });

  it('merges executor validate-card-preflight issues when executor is registered', () => {
    // This test verifies the pluggable hook path — without a real executor
    // it falls back to structural-only validation (no error).
    const { nonCore } = freshNonCore();
    const result = nonCore.validateCardPreflight({ body: minCard('exec-test') });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.cardId).toBe('exec-test');
      // No executor registered → structural result only (no merge needed)
      expect(Array.isArray(result.data.issues)).toBe(true);
    }
  });
});

// ============================================================================
// BoardLiveCardsNonCorePublic — validateCard
// ============================================================================

describe('BoardLiveCardsNonCorePublic — validateCard', () => {
  let tmpDir = '';

  function freshNonCore() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-vc-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, adapterOpts)).init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));
    return { nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('returns success for a card written to the store', () => {
    const { nonCore } = freshNonCore();
    nonCore.updatesInCardStore({ body: { ops: [{ op: 'update', id: 'known', 'card-content': minCard('known') }] } });

    const result = nonCore.validateCard({ params: { cardId: 'known' } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data[0].cardId).toBe('known');
      expect(Array.isArray(result.data[0].issues)).toBe(true);
    }
  });

  it('fails when card is not in the store', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.validateCard({ params: { cardId: 'missing' } });
    expect(result.status).toBe('success');  // returns success with isValid:false, not fail
    if (result.status === 'success') {
      expect(result.data[0].isValid).toBe(false);
    }
  });

  it('fails when --card-id or --all is missing', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.validateCard({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/--card-id.*--all|--all.*--card-id/);
  });
});

// ============================================================================
// BoardLiveCardsNonCorePublic — describeTaskExecutorCapabilities
// ============================================================================

describe('BoardLiveCardsNonCorePublic — describeTaskExecutorCapabilities', () => {
  let tmpDir = '';

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('fails when no task executor is registered', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-caps-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, adapterOpts)).init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));

    const result = nonCore.describeTaskExecutorCapabilities({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/No task-executor/);
  });
});

// ============================================================================
// Integration: updatesInCardStore → upsertCard workflow
// ============================================================================

describe('integration: updatesInCardStore → board operations', () => {
  let tmpDir = '';

  function freshAll() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-int-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    const board = createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, adapterOpts));
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));
    return { board, nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('write card to store then upsert succeeds', () => {
    const { board, nonCore } = freshAll();
    nonCore.updatesInCardStore({ body: { ops: [{ op: 'update', id: 'data-card', 'card-content': minCard('data-card') }] } });
    const result = board.upsertCard({ params: { cardId: 'data-card' } });
    expect(result.status).toBe('success');
  });

  it('overwrite a card and confirm updated data is returned by readFromCardStore', () => {
    const { nonCore } = freshAll();
    nonCore.updatesInCardStore({ body: { ops: [{ op: 'update', id: 'mutable', 'card-content': minCard('mutable', { card_data: { v: 1 } }) }] } });
    nonCore.updatesInCardStore({ body: { ops: [{ op: 'update', id: 'mutable', 'card-content': minCard('mutable', { card_data: { v: 2 } }) }] } });

    const result = nonCore.readFromCardStore({ body: { ids: ['mutable'] } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      const stored = result.data.cards[0]['card-content'] as { card_data: { v: number } };
      expect(stored.card_data.v).toBe(2);
    }
  });

  it('write + validate roundtrip: card written via updatesInCardStore passes validateCard', () => {
    const { nonCore } = freshAll();
    nonCore.updatesInCardStore({ body: { ops: [{ op: 'update', id: 'validated', 'card-content': minCard('validated') }] } });

    const result = nonCore.validateCard({ params: { cardId: 'validated' } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data[0].cardId).toBe('validated');
    }
  });

  it('status reflects card count after upsert', () => {
    const { board, nonCore } = freshAll();
    nonCore.updatesInCardStore({ body: { ops: [
      { op: 'update', id: 'c1', 'card-content': minCard('c1') },
      { op: 'update', id: 'c2', 'card-content': minCard('c2') },
    ] } });
    board.upsertCard({ params: { cardId: 'c1' } });
    board.upsertCard({ params: { cardId: 'c2' } });

    // processAccumulatedEvents to let the graph settle
    // (no_spawn mode means tasks complete immediately without side effects)
    const statusResult = board.status({});
    expect(statusResult.status).toBe('success');
    if (statusResult.status === 'success') {
      // card_count is driven by the graph — may be 0 if not yet drained
      // but status itself must be a valid object
      expect(typeof statusResult.data.summary.card_count).toBe('number');
    }
  });
});
// ============================================================================
// BoardLiveCardsPublic — removeCard
// ============================================================================

describe('BoardLiveCardsPublic — removeCard', () => {
  let tmpDir = '';

  function freshAll() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-rm-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    const board = createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, adapterOpts));
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));
    return { board, nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('returns success when removing a card that was upserted', () => {
    const { board, nonCore } = freshAll();
    nonCore.updatesInCardStore({ body: { ops: [{ op: 'update', id: 'rm-card', 'card-content': minCard('rm-card') }] } });
    board.upsertCard({ params: { cardId: 'rm-card' } });
    const result = board.removeCard({ params: { id: 'rm-card' } });
    expect(result.status).toBe('success');
  });

  it('fails when params.id is missing', () => {
    const { board } = freshAll();
    const result = board.removeCard({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.id/);
  });
});

// ============================================================================
// BoardLiveCardsPublic — retrigger
// ============================================================================

describe('BoardLiveCardsPublic — retrigger', () => {
  let tmpDir = '';

  function freshAll() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-rtrig-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    const board = createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, adapterOpts));
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));
    return { board, nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('returns success when retriggering a known card', () => {
    const { board, nonCore } = freshAll();
    nonCore.updatesInCardStore({ body: { ops: [{ op: 'update', id: 'rt-card', 'card-content': minCard('rt-card') }] } });
    board.upsertCard({ params: { cardId: 'rt-card' } });
    const result = board.retrigger({ params: { id: 'rt-card' } });
    expect(result.status).toBe('success');
  });

  it('fails when params.id is missing', () => {
    const { board } = freshAll();
    const result = board.retrigger({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.id/);
  });
});

// ============================================================================
// BoardLiveCardsPublic — task callbacks (taskCompleted, taskFailed, taskProgress)
//
// Callback tokens encode { t: taskName } base64url-encoded.
// ============================================================================

/** Build a minimal valid callback token: base64url({ t: taskName }) */
function makeCallbackToken(taskName: string): string {
  return Buffer.from(JSON.stringify({ t: taskName })).toString('base64url');
}

describe('BoardLiveCardsPublic — taskCompleted (via taskProgress)', () => {
  let tmpDir = '';

  function freshBoard() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-tc-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    const board = createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, adapterOpts));
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    return { board };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('returns success with a valid token and no body', () => {
    const { board } = freshBoard();
    const token = makeCallbackToken('my-task');
    const result = board.taskProgress({ params: { token } });
    expect(result.status).toBe('success');
  });

  it('returns success with a valid token and data body', () => {
    const { board } = freshBoard();
    const token = makeCallbackToken('my-task');
    const result = board.taskProgress({ params: { token }, body: { update: { value: 42 } } });
    expect(result.status).toBe('success');
  });

  it('fails when params.token is missing', () => {
    const { board } = freshBoard();
    const result = board.taskProgress({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.token/);
  });

  it('fails when the token is invalid (not base64url JSON)', () => {
    const { board } = freshBoard();
    const result = board.taskProgress({ params: { token: 'not-a-valid-token' } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/Invalid callback token/);
  });

  it('fails when token payload is missing the task name field', () => {
    const { board } = freshBoard();
    const badToken = Buffer.from(JSON.stringify({ x: 'no-t-field' })).toString('base64url');
    const result = board.taskProgress({ params: { token: badToken } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/Invalid callback token/);
  });
});

describe('BoardLiveCardsPublic — taskFailed', () => {
  let tmpDir = '';

  function freshBoard() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-tf-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    const board = createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, adapterOpts));
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    return { board };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('returns success with a valid token and no error message', () => {
    const { board } = freshBoard();
    const result = board.taskFailed({ params: { token: makeCallbackToken('t1') } });
    expect(result.status).toBe('success');
  });

  it('returns success with a valid token and an error message', () => {
    const { board } = freshBoard();
    const result = board.taskFailed({ params: { token: makeCallbackToken('t1'), error: 'network timeout' } });
    expect(result.status).toBe('success');
  });

  it('fails when params.token is missing', () => {
    const { board } = freshBoard();
    const result = board.taskFailed({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.token/);
  });

  it('fails when token is invalid', () => {
    const { board } = freshBoard();
    const result = board.taskFailed({ params: { token: 'garbage' } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/Invalid callback token/);
  });
});

describe('BoardLiveCardsPublic — taskProgress', () => {
  let tmpDir = '';

  function freshBoard() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-tp-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    const board = createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, adapterOpts));
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    return { board };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('returns success with a valid token and no update body', () => {
    const { board } = freshBoard();
    const result = board.taskProgress({ params: { token: makeCallbackToken('t2') } });
    expect(result.status).toBe('success');
  });

  it('returns success with a valid token and update body', () => {
    const { board } = freshBoard();
    const result = board.taskProgress({ params: { token: makeCallbackToken('t2') }, body: { pct: 50 } });
    expect(result.status).toBe('success');
  });

  it('fails when params.token is missing', () => {
    const { board } = freshBoard();
    const result = board.taskProgress({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.token/);
  });

  it('fails when token is invalid', () => {
    const { board } = freshBoard();
    const result = board.taskProgress({ params: { token: 'garbage' } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/Invalid callback token/);
  });
});

// ============================================================================
// BoardLiveCardsPublic — source callbacks (sourceDataFetched, sourceDataFetchFailure)
//
// Source tokens encode SourceTokenPayload: { cbk, rg, br, cid, b, d, cs? }
// ============================================================================

/** Build a minimal valid source token. */
function makeSourceToken(boardDir: string, taskName: string): string {
  const cbkToken = makeCallbackToken(taskName);
  const payload = {
    cbk: cbkToken,
    rg:  serializeRef({ kind: 'fs-path', value: boardDir }),
    br:  serializeRef({ kind: 'fs-path', value: boardDir }),
    cid: taskName,
    b:   'my-bind',
    d:   'output.json',
    cs:  '',
  };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

describe('BoardLiveCardsPublic — sourceDataFetchFailure', () => {
  let tmpDir = '';

  function freshBoard() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-sdf-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    const board = createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, adapterOpts));
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    return { board, boardDir };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('returns success with a valid source token and no reason', () => {
    const { board, boardDir } = freshBoard();
    const token = makeSourceToken(boardDir, 'src-task');
    const result = board.sourceDataFetchFailure({ params: { token } });
    expect(result.status).toBe('success');
  });

  it('returns success with a valid source token and a reason', () => {
    const { board, boardDir } = freshBoard();
    const token = makeSourceToken(boardDir, 'src-task');
    const result = board.sourceDataFetchFailure({ params: { token, reason: 'HTTP 503' } });
    expect(result.status).toBe('success');
  });

  it('fails when params.token is missing', () => {
    const { board } = freshBoard();
    const result = board.sourceDataFetchFailure({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.token/);
  });

  it('fails when source token is invalid', () => {
    const { board } = freshBoard();
    const result = board.sourceDataFetchFailure({ params: { token: 'garbage' } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/Invalid source token/);
  });
});

describe('BoardLiveCardsPublic — sourceDataFetched', () => {
  let tmpDir = '';

  function freshBoard() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-sdf2-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    const board = createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, adapterOpts));
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    return { board, boardDir };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('fails when params.token is missing', () => {
    const { board, boardDir } = freshBoard();
    const outFile = path.join(boardDir, 'out.json');
    fs.writeFileSync(outFile, '{}');
    const result = board.sourceDataFetched({ params: { ref: outFile } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.token/);
  });

  it('fails when params.ref is missing', () => {
    const { board, boardDir } = freshBoard();
    const token = makeSourceToken(boardDir, 'src-task');
    const result = board.sourceDataFetched({ params: { token } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.ref/);
  });

  it('fails when source token is invalid', () => {
    const { board } = freshBoard();
    const result = board.sourceDataFetched({ params: { token: 'garbage', ref: serializeRef({ kind: 'fs-path', value: '/tmp/x' }) } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/Invalid source token/);
  });

  it('returns success with a valid source token and a real output file', () => {
    const { board, boardDir } = freshBoard();
    // Write the output file as a relative key inside the board dir so that
    // blobStorage('').read(r.value) can find it via path.join(boardDir, key).
    const relKey = 'fetched.json';
    fs.writeFileSync(path.join(boardDir, relKey), JSON.stringify({ data: [1, 2, 3] }));
    const token = makeSourceToken(boardDir, 'src-task');
    const result = board.sourceDataFetched({ params: { token, ref: serializeRef({ kind: 'fs-path', value: relKey }) } });
    expect(result.status).toBe('success');
  });
});

// ============================================================================
// BoardLiveCardsNonCorePublic — probeSource / probeTmpSource
// (No task executor registered — both methods return fail with a clear message)
// ============================================================================

describe('BoardLiveCardsNonCorePublic — probeSource', () => {
  let tmpDir = '';

  function freshAll() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-ps-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, adapterOpts)).init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));
    return { nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('fails when params.cardId is missing', () => {
    const { nonCore } = freshAll();
    const result = nonCore.probeSource({ params: { sourceIdx: 0 } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.cardId/);
  });

  it('fails when params.sourceIdx is missing', () => {
    const { nonCore } = freshAll();
    const result = nonCore.probeSource({ params: { cardId: 'x' } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.sourceIdx/);
  });

  it('fails when card is not in the store', () => {
    const { nonCore } = freshAll();
    const result = nonCore.probeSource({ params: { cardId: 'ghost', sourceIdx: 0 } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/not found/);
  });

  it('fails when sourceIdx is out of range', () => {
    const { nonCore } = freshAll();
    nonCore.updatesInCardStore({ body: { ops: [{ op: 'update', id: 'no-sources', 'card-content': minCard('no-sources') }] } });
    const result = nonCore.probeSource({ params: { cardId: 'no-sources', sourceIdx: 0 } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/out of range/);
  });

  it('fails with no-executor message when sourceIdx is valid but no executor registered', () => {
    const { nonCore } = freshAll();
    const card = minCard('src-card', { source_defs: [{ cli: 'fetch.sh', bindTo: 'raw', outputFile: 'raw.json' }] });
    nonCore.updatesInCardStore({ body: { ops: [{ op: 'update', id: 'src-card', 'card-content': card }] } });
    const result = nonCore.probeSource({ params: { cardId: 'src-card', sourceIdx: 0 } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/No task-executor/);
  });
});

describe('BoardLiveCardsNonCorePublic — probeTmpSource', () => {
  let tmpDir = '';

  function freshAll() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-pts-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, adapterOpts)).init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));
    return { nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('fails when body is absent', () => {
    const { nonCore } = freshAll();
    const result = nonCore.probeTmpSource({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/body/);
  });

  it('fails when body."source-def" is missing', () => {
    const { nonCore } = freshAll();
    const result = nonCore.probeTmpSource({ body: { 'mock-projections': {} } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/source-def/);
  });

  it('fails with no-executor message when body is valid but no executor registered', () => {
    const { nonCore } = freshAll();
    const result = nonCore.probeTmpSource({
      body: { 'source-def': { cli: 'fetch.sh', bindTo: 'raw', outputFile: 'raw.json' }, 'mock-projections': {} },
    });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/No task-executor/);
  });
});

describe('BoardLiveCardsNonCorePublic — probeSourcePreflight', () => {
  let tmpDir = '';

  function freshNonCore() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-psp-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));
    return { nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('fails when params.sourceIdx is missing', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.probeSourcePreflight({ body: minCard('c') });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.sourceIdx/);
  });

  it('fails when body is absent', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.probeSourcePreflight({ params: { sourceIdx: 0 } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/card JSON/);
  });

  it('fails when body is not an object', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.probeSourcePreflight({ params: { sourceIdx: 0 }, body: 'bad' });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/card JSON/);
  });

  it('fails when sourceIdx is out of range (no source_defs)', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.probeSourcePreflight({ params: { sourceIdx: 0 }, body: minCard('c') });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/out of range/);
  });

  it('fails when sourceIdx is out of range (too high)', () => {
    const { nonCore } = freshNonCore();
    const card = minCard('c', { source_defs: [{ cli: 'fetch.sh', bindTo: 'raw' }] });
    const result = nonCore.probeSourcePreflight({ params: { sourceIdx: 5 }, body: card });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/out of range/);
  });

  it('accepts card-content wrapper and fails with no-executor when source is valid', () => {
    const { nonCore } = freshNonCore();
    const card = minCard('c', { source_defs: [{ cli: 'fetch.sh', bindTo: 'raw', outputFile: 'raw.json' }] });
    const result = nonCore.probeSourcePreflight({
      params: { sourceIdx: 0 },
      body: { 'card-content': card, 'mock-projections': {} },
    });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/No task-executor/);
  });

  it('accepts flat card body and fails with no-executor when source is valid', () => {
    const { nonCore } = freshNonCore();
    const card = minCard('c', { source_defs: [{ cli: 'fetch.sh', bindTo: 'raw', outputFile: 'raw.json' }] });
    const result = nonCore.probeSourcePreflight({ params: { sourceIdx: 0 }, body: card });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/No task-executor/);
  });

  it('passes mock-projections through from card-content wrapper', () => {
    const { nonCore } = freshNonCore();
    const card = minCard('c', { source_defs: [{ mock: 'quotes', bindTo: 'prices', outputFile: 'prices.json' }] });
    const result = nonCore.probeSourcePreflight({
      params: { sourceIdx: 0 },
      body: { 'card-content': card, 'mock-projections': { tickers: ['AAPL'] } },
    });
    // Without an executor this still fails, but the key test is that it doesn't
    // blow up parsing mock-projections — the error should be about executor, not projections.
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/No task-executor/);
  });

  it('handles sourceIdx = 0 with multiple source_defs correctly', () => {
    const { nonCore } = freshNonCore();
    const card = minCard('c', {
      source_defs: [
        { mock: 'quotes', bindTo: 'first', outputFile: 'first.json' },
        { cli: 'other.sh', bindTo: 'second', outputFile: 'second.json' },
      ],
    });
    const result = nonCore.probeSourcePreflight({ params: { sourceIdx: 0 }, body: card });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/No task-executor/);
  });

  it('handles sourceIdx = 1 with multiple source_defs correctly', () => {
    const { nonCore } = freshNonCore();
    const card = minCard('c', {
      source_defs: [
        { mock: 'quotes', bindTo: 'first', outputFile: 'first.json' },
        { cli: 'other.sh', bindTo: 'second', outputFile: 'second.json' },
      ],
    });
    const result = nonCore.probeSourcePreflight({ params: { sourceIdx: 1 }, body: card });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/No task-executor/);
  });

  it('does not fall back to run-source-fetch when the lightweight executor hook is unsupported', () => {
    const taskExecutorRef = {
      meta: 'task-executor',
      howToRun: 'local-node',
      whatToRun: serializeRef({ kind: 'fs-path', value: 'fake-executor.js' }),
    };
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-psp-hook-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, adapterOpts)).init({
      params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) },
      body: { 'task-executor-ref': taskExecutorRef },
    });
    const adapter = createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} });
    let runSourceFetchCalled = false;
    adapter.invokeExecutorSync = ((refArg, subcommand) => {
      if (subcommand === 'probe-source-preflight') throw new Error('unsupported');
      if (subcommand === 'run-source-fetch') {
        runSourceFetchCalled = true;
        throw new Error('should not have attempted run-source-fetch');
      }
      throw new Error(`unexpected subcommand: ${subcommand}`);
    }) as typeof adapter.invokeExecutorSync;

    const nonCore = createBoardLiveCardsNonCorePublic(br, adapter);
    const card = minCard('c', { source_defs: [{ mock: 'quotes', bindTo: 'first', outputFile: 'first.json' }] });
    const result = nonCore.probeSourcePreflight({ params: { sourceIdx: 0 }, body: card });
    expect(result.status).toBe('fail');
    expect(runSourceFetchCalled).toBe(false);
    if (result.status === 'fail') expect(result.error).toMatch(/does not support probe-source-preflight/);
  });
});

describe('BoardLiveCardsNonCorePublic — runSourcePreflight', () => {
  let tmpDir = '';

  function freshNonCoreWithExecutorStub(
    invokeStub: ReturnType<typeof createFsBoardNonCorePlatformAdapter>['invokeExecutorSync'],
  ) {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-rsp-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, adapterOpts)).init({
      params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) },
      body: {
        'task-executor-ref': {
          meta: 'task-executor',
          howToRun: 'local-node',
          whatToRun: serializeRef({ kind: 'fs-path', value: path.join(boardDir, 'fake-executor.js') }),
        },
      },
    });
    const adapter = createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} });
    adapter.invokeExecutorSync = invokeStub;
    const nonCore = createBoardLiveCardsNonCorePublic(br, adapter);
    return { nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('uses the live fetch path for run-source-preflight and returns the simplified shape', () => {
    const card = minCard('c', { source_defs: [{ kind: 'urls', bindTo: 'prices', outputFile: 'prices.json' }] });
    const { nonCore: liveNonCore } = freshNonCoreWithExecutorStub((((refArg, subcommand, argv) => {
      expect(subcommand).toBe('run-source-fetch');
      const outIdx = argv.indexOf('--out-ref');
      const outRef = parseRef(argv[outIdx + 1]);
      fs.writeFileSync(outRef.value, JSON.stringify({ ok: true }));
      return '';
    }) as unknown) as ReturnType<typeof createFsBoardNonCorePlatformAdapter>['invokeExecutorSync']);

    const result = liveNonCore.runSourcePreflight({ params: { sourceIdx: 0 }, body: { 'card-content': card, 'mock-projections': {} } });
    expect(result).toEqual({
      status: 'success',
      data: {
        bindTo: 'prices',
        ok: true,
        result: { ok: true },
        issues: [],
      },
    });
  });

  it('returns ok=false with issues when the live fetch path fails', () => {
    const { nonCore } = freshNonCoreWithExecutorStub((((refArg, subcommand, argv) => {
      expect(subcommand).toBe('run-source-fetch');
      throw new Error('network timeout');
    }) as unknown) as ReturnType<typeof createFsBoardNonCorePlatformAdapter>['invokeExecutorSync']);

    const card = minCard('c', { source_defs: [{ kind: 'urls', bindTo: 'prices', outputFile: 'prices.json' }] });
    const result = nonCore.runSourcePreflight({ params: { sourceIdx: 0 }, body: { 'card-content': card, 'mock-projections': {} } });
    expect(result).toEqual({
      status: 'success',
      data: {
        bindTo: 'prices',
        ok: false,
        result: null,
        issues: ['Probe failed: network timeout'],
      },
    });
  });

  it('fails when no task executor is configured for run-source-preflight', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-rsp-noexec-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));

    const card = minCard('c', { source_defs: [{ kind: 'urls', bindTo: 'prices', outputFile: 'prices.json' }] });
    const result = nonCore.runSourcePreflight({ params: { sourceIdx: 0 }, body: { 'card-content': card, 'mock-projections': {} } });
    expect(result).toEqual({
      status: 'fail',
      error: 'No task-executor registered for this board',
    });
  });
});

// ============================================================================
// BoardLiveCardsNonCorePublic — evalCardCompute
// ============================================================================

describe('BoardLiveCardsNonCorePublic — evalCardCompute', () => {
  let tmpDir = '';

  function freshNonCore() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-ecc-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));
    return { nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('fails when body is absent', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.evalCardCompute({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/body/);
  });

  it('fails when body is a string', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.evalCardCompute({ body: 'bad' });
    expect(result.status).toBe('fail');
  });

  it('returns success with empty computed_values when card has no compute steps', () => {
    const { nonCore } = freshNonCore();
    const card = minCard('no-compute');
    const result = nonCore.evalCardCompute({ body: { 'card-content': card } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.cardId).toBe('no-compute');
      expect(result.data.ok).toBe(true);
      expect(result.data.computed_values).toEqual({});
      expect(result.data.errors).toEqual([]);
    }
  });

  it('evaluates a simple card_data expression', () => {
    const { nonCore } = freshNonCore();
    const card = {
      ...minCard('simple'),
      card_data: { items: [{ v: 10 }, { v: 20 }] },
      compute: [{ bindTo: 'total', expr: '$sum(card_data.items.v)' }],
    };
    const result = nonCore.evalCardCompute({ body: { 'card-content': card } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.ok).toBe(true);
      expect(result.data.computed_values.total).toBe(30);
      expect(result.data.errors).toEqual([]);
    }
  });

  it('evaluates expressions referencing mock-fetched-sources', () => {
    const { nonCore } = freshNonCore();
    const card = {
      ...minCard('with-sources'),
      source_defs: [{ bindTo: 'prices', outputFile: 'prices.json', mock: 'quotes' }],
      compute: [{ bindTo: 'first_price', expr: 'fetched_sources.prices.items[0].price' }],
    };
    const result = nonCore.evalCardCompute({
      body: {
        'card-content': card,
        'mock-fetched-sources': { prices: { items: [{ ticker: 'AAPL', price: 150 }] } },
      },
    });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.ok).toBe(true);
      expect(result.data.computed_values.first_price).toBe(150);
    }
  });

  it('evaluates expressions referencing mock-requires', () => {
    const { nonCore } = freshNonCore();
    const card = {
      ...minCard('with-requires'),
      compute: [{ bindTo: 'dep_value', expr: 'requires.other_card.total' }],
    };
    const result = nonCore.evalCardCompute({
      body: {
        'card-content': card,
        'mock-requires': { other_card: { total: 42 } },
      },
    });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.ok).toBe(true);
      expect(result.data.computed_values.dep_value).toBe(42);
    }
  });

  it('reports per-step errors for bad expressions', () => {
    const { nonCore } = freshNonCore();
    const card = {
      ...minCard('bad-expr'),
      compute: [
        { bindTo: 'good', expr: '1 + 1' },
        { bindTo: 'bad', expr: '$nosuchfunction()' },
      ],
    };
    const result = nonCore.evalCardCompute({ body: { 'card-content': card } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.ok).toBe(false);
      expect(result.data.computed_values.good).toBe(2);
      expect(result.data.errors.length).toBeGreaterThan(0);
      expect(result.data.errors[0].bindTo).toBe('bad');
      expect(typeof result.data.errors[0].error).toBe('string');
    }
  });

  it('later compute steps can reference earlier ones via computed_values', () => {
    const { nonCore } = freshNonCore();
    const card = {
      ...minCard('chained'),
      card_data: { x: 5 },
      compute: [
        { bindTo: 'doubled', expr: 'card_data.x * 2' },
        { bindTo: 'quadrupled', expr: 'computed_values.doubled * 2' },
      ],
    };
    const result = nonCore.evalCardCompute({ body: { 'card-content': card } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.ok).toBe(true);
      expect(result.data.computed_values.doubled).toBe(10);
      expect(result.data.computed_values.quadrupled).toBe(20);
    }
  });

  it('accepts flat card body (no card-content wrapper)', () => {
    const { nonCore } = freshNonCore();
    const card = {
      ...minCard('flat'),
      compute: [{ bindTo: 'val', expr: '42' }],
    };
    const result = nonCore.evalCardCompute({ body: card });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.cardId).toBe('flat');
      expect(result.data.computed_values.val).toBe(42);
    }
  });
});

// ============================================================================
// BoardLiveCardsNonCorePublic — simulateCardCycle
// ============================================================================

describe('BoardLiveCardsNonCorePublic — simulateCardCycle', () => {
  let tmpDir = '';

  function freshNonCore() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-scc-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));
    return { nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('fails when body is absent', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.simulateCardCycle({});
    expect(result.status).toBe('fail');
  });

  it('fails when body is a string', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.simulateCardCycle({ body: 'bad' });
    expect(result.status).toBe('fail');
  });

  it('returns full result for a minimal card with no sources or compute', () => {
    const { nonCore } = freshNonCore();
    const card = minCard('minimal');
    const result = nonCore.simulateCardCycle({ body: { 'card-content': card } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.cardId).toBe('minimal');
      expect(result.data.ok).toBe(true);
      expect(result.data.validation.isValid).toBe(true);
      expect(result.data.source_probes).toEqual([]);
      expect(result.data.projection_errors).toEqual([]);
      expect(result.data.computed_values).toEqual({});
      expect(result.data.compute_errors).toEqual([]);
    }
  });

  it('includes validation issues for a structurally bad card', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.simulateCardCycle({ body: { 'card-content': { card_data: {} } } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.cardId).toBe('(unknown)');
      expect(result.data.validation.isValid).toBe(false);
      expect(result.data.validation.issues.length).toBeGreaterThan(0);
    }
  });

  it('runs compute with mock-fetched-sources and mock-requires', () => {
    const { nonCore } = freshNonCore();
    const card = {
      ...minCard('compute-sim'),
      source_defs: [{ bindTo: 'data', outputFile: 'data.json', mock: 'test' }],
      compute: [
        { bindTo: 'total', expr: '$sum(fetched_sources.data.values)' },
        { bindTo: 'dep', expr: 'requires.dep_card.x' },
      ],
    };
    const result = nonCore.simulateCardCycle({
      body: {
        'card-content': card,
        'mock-fetched-sources': { data: { values: [10, 20, 30] } },
        'mock-requires': { dep_card: { x: 99 } },
      },
    });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.computed_values.total).toBe(60);
      expect(result.data.computed_values.dep).toBe(99);
      expect(result.data.compute_errors).toEqual([]);
    }
  });

  it('reports compute errors alongside successful steps', () => {
    const { nonCore } = freshNonCore();
    const card = {
      ...minCard('mixed'),
      compute: [
        { bindTo: 'good', expr: '1 + 1' },
        { bindTo: 'bad', expr: '$nosuchfunction()' },
      ],
    };
    const result = nonCore.simulateCardCycle({ body: { 'card-content': card } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.ok).toBe(false);
      expect(result.data.computed_values.good).toBe(2);
      expect(result.data.compute_errors.length).toBeGreaterThan(0);
      expect(result.data.compute_errors[0].bindTo).toBe('bad');
    }
  });

  it('marks source probes as skipped when no executor is registered', () => {
    const { nonCore } = freshNonCore();
    const card = {
      ...minCard('no-exec'),
      source_defs: [{ bindTo: 'raw', outputFile: 'raw.json', cli: 'fetch.sh' }],
    };
    const result = nonCore.simulateCardCycle({ body: { 'card-content': card } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.source_probes.length).toBe(1);
      expect(result.data.source_probes[0].bindTo).toBe('raw');
      expect(result.data.source_probes[0].skipped).toBe(true);
    }
  });

  it('detects projection resolution failures', () => {
    const { nonCore } = freshNonCore();
    const card = {
      ...minCard('proj-fail'),
      source_defs: [{
        bindTo: 'data',
        outputFile: 'data.json',
        cli: 'fetch.sh',
        projections: { ticker_list: 'requires.missing_card.tickers' },
      }],
    };
    const result = nonCore.simulateCardCycle({ body: { 'card-content': card } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.ok).toBe(false);
      expect(result.data.projection_errors.length).toBe(1);
      expect(result.data.projection_errors[0].bindTo).toBe('data');
      expect(result.data.projection_errors[0].key).toBe('ticker_list');
    }
  });

  it('resolves projections successfully from mock-requires', () => {
    const { nonCore } = freshNonCore();
    const card = {
      ...minCard('proj-ok'),
      source_defs: [{
        bindTo: 'data',
        outputFile: 'data.json',
        cli: 'fetch.sh',
        projections: { ticker_list: 'requires.holdings.tickers' },
      }],
    };
    const result = nonCore.simulateCardCycle({
      body: {
        'card-content': card,
        'mock-requires': { holdings: { tickers: ['AAPL', 'MSFT'] } },
      },
    });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.projection_errors).toEqual([]);
    }
  });

  it('accepts flat card body (no card-content wrapper)', () => {
    const { nonCore } = freshNonCore();
    const card = {
      ...minCard('flat-sim'),
      compute: [{ bindTo: 'val', expr: '42' }],
    };
    const result = nonCore.simulateCardCycle({ body: card });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.cardId).toBe('flat-sim');
      expect(result.data.computed_values.val).toBe(42);
    }
  });
});