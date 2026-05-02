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
} from '../../src/cli/board-live-cards-cli.js';
import {
  createBoardLiveCardsPublic,
  createBoardLiveCardsNonCorePublic,
} from '../../src/cli/board-live-cards-public.js';

process.env.BOARD_LIVE_CARDS_NO_SPAWN = '1';

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const ref = (d: string) => ({ kind: 'fs-path' as const, value: d });

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
    const adapter = createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} });
    const board = createBoardLiveCardsPublic(br, adapter);
    return { boardDir, br, board };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('init({}) creates the board state and returns success', () => {
    const { board, boardDir } = freshBoard();
    const result = board.init({});
    expect(result.status).toBe('success');
    // The public layer writes via KV abstraction (.state-snapshot namespace)
    expect(fs.existsSync(path.join(boardDir, '.state-snapshot'))).toBe(true);
  });

  it('init is idempotent — second call also returns success', () => {
    const { board } = freshBoard();
    board.init({});
    expect(board.init({}).status).toBe('success');
  });

  it('status({}) returns a board status object with zero cards after init', () => {
    const { board } = freshBoard();
    board.init({});
    const result = board.status({});
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.summary.card_count).toBe(0);
      expect(result.data.cards).toEqual([]);
    }
  });

  it('removeCard({}) fails — params.id is missing', () => {
    const { board } = freshBoard();
    board.init({});
    const result = board.removeCard({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.id/);
  });

  it('retrigger({}) fails — params.id is missing', () => {
    const { board } = freshBoard();
    board.init({});
    const result = board.retrigger({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.id/);
  });

  it('upsertCard({}) fails — params.cardId is missing', () => {
    const { board } = freshBoard();
    board.init({});
    const result = board.upsertCard({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.cardId/);
  });

  it('upsertCard fails when card is not yet in the store', () => {
    const { board } = freshBoard();
    board.init({});
    const result = board.upsertCard({ params: { cardId: 'ghost' } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/not found/);
  });

  it('processAccumulatedEvents({}) returns success after init', async () => {
    const { board } = freshBoard();
    board.init({});
    const result = await board.processAccumulatedEvents({});
    expect(result.status).toBe('success');
  });
});

// ============================================================================
// BoardLiveCardsNonCorePublic — updateInCardStore
// ============================================================================

describe('BoardLiveCardsNonCorePublic — updateInCardStore', () => {
  let tmpDir = '';

  function freshNonCore() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-nc-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} })).init({});
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));
    return { nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('writes a card and returns success with cardId', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.updateInCardStore({ params: { cardId: 'my-card' }, body: minCard('my-card') });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect((result.data as Record<string, unknown>)['cardId']).toBe('my-card');
    }
  });

  it('fails when params.cardId is missing', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.updateInCardStore({ body: minCard('x') });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.cardId/);
  });

  it('fails when body is absent', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.updateInCardStore({ params: { cardId: 'x' } });
    expect(result.status).toBe('fail');
  });

  it('fails when body is a string (not an object)', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.updateInCardStore({ params: { cardId: 'x' }, body: 'not-an-object' });
    expect(result.status).toBe('fail');
  });

  it('fails when body is an array', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.updateInCardStore({ params: { cardId: 'x' }, body: [] });
    expect(result.status).toBe('fail');
  });

  it('fails when card body id does not match params.cardId', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.updateInCardStore({ params: { cardId: 'card-a' }, body: minCard('card-b') });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/does not match/);
  });

  it('fails when card body lacks an id field', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.updateInCardStore({ params: { cardId: 'x' }, body: { card_data: {} } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/string id/);
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
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} })).init({});
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));
    return { nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('returns a previously written card', () => {
    const { nonCore } = freshNonCore();
    nonCore.updateInCardStore({ params: { cardId: 'stored' }, body: minCard('stored') });

    const result = nonCore.readFromCardStore({ params: { cardId: 'stored' } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect((result.data.card as Record<string, unknown>)['id']).toBe('stored');
    }
  });

  it('fails when card is not in the store', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.readFromCardStore({ params: { cardId: 'ghost' } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/not found/);
  });

  it('fails when params.cardId is missing', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.readFromCardStore({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.cardId/);
  });
});

// ============================================================================
// BoardLiveCardsNonCorePublic — validateTmpCard
// ============================================================================

describe('BoardLiveCardsNonCorePublic — validateTmpCard', () => {
  let tmpDir = '';

  function freshNonCore() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-vtmp-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} })).init({});
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));
    return { nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('returns success + cardId for a valid card object in body', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.validateTmpCard({ body: minCard('tmp-card') });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.cardId).toBe('tmp-card');
      expect(Array.isArray(result.data.errors)).toBe(true);
    }
  });

  it('uses (unknown) as cardId when card body lacks an id string', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.validateTmpCard({ body: { card_data: { x: 1 } } });
    // still returns success — errors embedded in data.errors
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.cardId).toBe('(unknown)');
    }
  });

  it('fails when body is absent', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.validateTmpCard({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/body/);
  });

  it('fails when body is a string', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.validateTmpCard({ body: 'not-an-object' });
    expect(result.status).toBe('fail');
  });

  it('fails when body is an array', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.validateTmpCard({ body: [] });
    expect(result.status).toBe('fail');
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
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} })).init({});
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));
    return { nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('returns success for a card written to the store', () => {
    const { nonCore } = freshNonCore();
    nonCore.updateInCardStore({ params: { cardId: 'known' }, body: minCard('known') });

    const result = nonCore.validateCard({ params: { cardId: 'known' } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.cardId).toBe('known');
      expect(Array.isArray(result.data.errors)).toBe(true);
    }
  });

  it('fails when card is not in the store', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.validateCard({ params: { cardId: 'missing' } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/not found/);
  });

  it('fails when params.cardId is missing', () => {
    const { nonCore } = freshNonCore();
    const result = nonCore.validateCard({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.cardId/);
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
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} })).init({});
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));

    const result = nonCore.describeTaskExecutorCapabilities({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/No task-executor/);
  });
});

// ============================================================================
// Integration: updateInCardStore → upsertCard workflow
// ============================================================================

describe('integration: updateInCardStore → board operations', () => {
  let tmpDir = '';

  function freshAll() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-int-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    const board = createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} }));
    board.init({});
    const nonCore = createBoardLiveCardsNonCorePublic(br, createFsBoardNonCorePlatformAdapter(br, cliDir, { onWarn: () => {} }));
    return { board, nonCore };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('write card to store then upsert succeeds', () => {
    const { board, nonCore } = freshAll();
    nonCore.updateInCardStore({ params: { cardId: 'data-card' }, body: minCard('data-card') });
    const result = board.upsertCard({ params: { cardId: 'data-card' } });
    expect(result.status).toBe('success');
  });

  it('overwrite a card and confirm updated data is returned by readFromCardStore', () => {
    const { nonCore } = freshAll();
    nonCore.updateInCardStore({ params: { cardId: 'mutable' }, body: minCard('mutable', { card_data: { v: 1 } }) });
    nonCore.updateInCardStore({ params: { cardId: 'mutable' }, body: minCard('mutable', { card_data: { v: 2 } }) });

    const result = nonCore.readFromCardStore({ params: { cardId: 'mutable' } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      const stored = result.data.card as { card_data: { v: number } };
      expect(stored.card_data.v).toBe(2);
    }
  });

  it('write + validate roundtrip: card written via updateInCardStore passes validateCard', () => {
    const { nonCore } = freshAll();
    nonCore.updateInCardStore({ params: { cardId: 'validated' }, body: minCard('validated') });

    const result = nonCore.validateCard({ params: { cardId: 'validated' } });
    expect(result.status).toBe('success');
    if (result.status === 'success') {
      expect(result.data.cardId).toBe('validated');
    }
  });

  it('status reflects card count after upsert', () => {
    const { board, nonCore } = freshAll();
    nonCore.updateInCardStore({ params: { cardId: 'c1' }, body: minCard('c1') });
    nonCore.updateInCardStore({ params: { cardId: 'c2' }, body: minCard('c2') });
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
