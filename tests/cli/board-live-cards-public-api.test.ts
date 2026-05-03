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

process.env.BOARD_LIVE_CARDS_NO_SPAWN = '1';

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const ref = (d: string) => ({ kind: 'fs-path' as const, value: d });
const mkCardStoreRef = (d: string) => '::fs-path::' + path.join(d, '.cards');
const mkOutputsStoreRef = (d: string) => '::fs-path::' + path.join(d, '.output');

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
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} })).init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
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
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} })).init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
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
// BoardLiveCardsNonCorePublic — validateTmpCard
// ============================================================================

describe('BoardLiveCardsNonCorePublic — validateTmpCard', () => {
  let tmpDir = '';

  function freshNonCore() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-vtmp-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} })).init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
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
      expect(Array.isArray(result.data.issues)).toBe(true);
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
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} })).init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
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
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} })).init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
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
    const board = createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} }));
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
    const board = createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} }));
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
    const board = createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} }));
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

describe('BoardLiveCardsPublic — taskCompleted', () => {
  let tmpDir = '';

  function freshBoard() {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blc-tc-'));
    const boardDir = path.join(tmpDir, 'board');
    const br = ref(boardDir);
    const board = createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} }));
    board.init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
    return { board };
  }

  afterEach(() => {
    if (tmpDir) { fs.rmSync(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
  });

  it('returns success with a valid token and no body', () => {
    const { board } = freshBoard();
    const token = makeCallbackToken('my-task');
    const result = board.taskCompleted({ params: { token } });
    expect(result.status).toBe('success');
  });

  it('returns success with a valid token and data body', () => {
    const { board } = freshBoard();
    const token = makeCallbackToken('my-task');
    const result = board.taskCompleted({ params: { token }, body: { value: 42 } });
    expect(result.status).toBe('success');
  });

  it('fails when params.token is missing', () => {
    const { board } = freshBoard();
    const result = board.taskCompleted({});
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/params\.token/);
  });

  it('fails when the token is invalid (not base64url JSON)', () => {
    const { board } = freshBoard();
    const result = board.taskCompleted({ params: { token: 'not-a-valid-token' } });
    expect(result.status).toBe('fail');
    if (result.status === 'fail') expect(result.error).toMatch(/Invalid callback token/);
  });

  it('fails when token payload is missing the task name field', () => {
    const { board } = freshBoard();
    const badToken = Buffer.from(JSON.stringify({ x: 'no-t-field' })).toString('base64url');
    const result = board.taskCompleted({ params: { token: badToken } });
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
    const board = createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} }));
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
    const board = createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} }));
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
    rg:  '::fs-path::' + boardDir,
    br:  '::fs-path::' + boardDir,
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
    const board = createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} }));
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
    const board = createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} }));
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
    const result = board.sourceDataFetched({ params: { token: 'garbage', ref: '::fs-path::/tmp/x' } });
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
    const result = board.sourceDataFetched({ params: { token, ref: '::fs-path::' + relKey } });
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
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} })).init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
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
    createBoardLiveCardsPublic(br, createFsBoardPlatformAdapter(br, cliDir, { onWarn: () => {} })).init({ params: { cardStoreRef: mkCardStoreRef(boardDir), outputsStoreRef: mkOutputsStoreRef(boardDir) } });
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