/**
 * server-runtime-integration.test.ts
 *
 * Integration test that boots the NEW platform-free server runtime
 * (src/server-runtime/index.ts) with Node FS adapters and verifies
 * it can bootstrap cards, serve board-status, patch cards, upload files,
 * send chat actions, and stream SSE.
 *
 * This proves the Node host path works end-to-end.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';

// ── Import from the platform-free runtime ──────────────────────────────────
import { createSingleBoardServerRuntime } from '../../src/server-runtime/index.js';
import type {
  SingleBoardRuntimeOptions,
  RuntimeRequest,
  RuntimeResponse,
  CardSourceAdapter,
} from '../../src/server-runtime/types.js';
import { createCardStorePublic } from '../../src/cli/common/card-store-lib-public.js';
import { createCardStore } from '../../src/cli/common/board-live-cards-lib.js';

// ── Import FS adapters (Node-specific) ─────────────────────────────────────
import { createFsBoardPlatformAdapter } from '../../src/cli/node/fs-board-adapter.js';
import { serializeRef, parseRef } from '../../src/cli/common/storage-interface.js';
import { createInMemoryChatStorage } from '../../src/cli/common/chat-storage-lib.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_CARDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cards');

const TEST_PORT = 7900 + Math.floor(Math.random() * 100);
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-srt-'));
const BOARD_DIR = path.join(TEST_ROOT, 'runtime');
const CARD_STORE_DIR = path.join(TEST_ROOT, 'card-store');
const OUTPUTS_DIR = path.join(TEST_ROOT, 'outputs');
const API_BASE = `http://127.0.0.1:${TEST_PORT}/api/board`;

let server: http.Server | null = null;
const testChatStorage = createInMemoryChatStorage();
const sseConnected: string[] = [];
const sseDisconnected: string[] = [];
const sseWriters = new Map<string, (payload: unknown) => void>();
const channelSubscribed: Array<{ clientId: string; channelName: string; params: { cardId?: string } }> = [];
const channelUnsubscribed: Array<{ clientId: string; channelName: string; params: { cardId?: string } }> = [];

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ── CardSourceAdapter from FS ──────────────────────────────────────────────
function createFsCardSource(cardsDir: string): CardSourceAdapter {
  return {
    listCards(): Array<Record<string, unknown>> {
      const files = fs.readdirSync(cardsDir).filter(f => f.endsWith('.json'));
      return files.map(f => {
        const raw = fs.readFileSync(path.join(cardsDir, f), 'utf-8');
        return JSON.parse(raw);
      }).filter((card): card is Record<string, unknown> & { id: string } =>
        !!card && typeof card === 'object' && typeof (card as { id?: unknown }).id === 'string' && (card as { id: string }).id.trim().length > 0,
      );
    },
  };
}

beforeAll(async () => {
  // Create directories
  fs.mkdirSync(BOARD_DIR, { recursive: true });
  fs.mkdirSync(CARD_STORE_DIR, { recursive: true });
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });

  // Copy card files to a test-local dir
  const testCardsDir = path.join(TEST_ROOT, 'cards');
  fs.mkdirSync(testCardsDir, { recursive: true });
  for (const entry of fs.readdirSync(SOURCE_CARDS_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.json')) {
      fs.copyFileSync(path.join(SOURCE_CARDS_DIR, entry.name), path.join(testCardsDir, entry.name));
    }
  }

  const baseRef = parseRef(serializeRef({ kind: 'fs-path', value: BOARD_DIR }));
  const boardAdapter = createFsBoardPlatformAdapter(baseRef, repoRoot, { suppressSpawn: true });

  const runtimeOptions: SingleBoardRuntimeOptions = {
    apiBasePath: '/api/board',
    boardId: 'test-board',
    chatStorage: testChatStorage,
    boards: [{
      label: 'base',
      boardAdapter,
      baseRef,
      cardStoreRef: serializeRef({ kind: 'fs-path', value: CARD_STORE_DIR }),
      outputsStoreRef: serializeRef({ kind: 'fs-path', value: OUTPUTS_DIR }),
      cardSource: createFsCardSource(testCardsDir),
    }],
    logger: {
      info: () => {},
      warn: () => {},
      error: console.error,
    },
    serverUrl: `http://127.0.0.1:${TEST_PORT}`,
    onSseClientConnected(clientId, writer) {
      sseConnected.push(clientId);
      sseWriters.set(clientId, writer);
    },
    onSseClientDisconnected(clientId) {
      sseDisconnected.push(clientId);
      sseWriters.delete(clientId);
    },
    onChannelSubscribed(clientId, channelName, params) {
      channelSubscribed.push({ clientId, channelName, params });
    },
    onChannelUnsubscribed(clientId, channelName, params) {
      channelUnsubscribed.push({ clientId, channelName, params });
    },
  };

  // Preload cards into the persisted card store used by runtime bootstrap.
  const preloadKv = boardAdapter.kvStorageForRef(runtimeOptions.boards[0].cardStoreRef);
  const preloadStore = createCardStorePublic(createCardStore({
    readIndex: () => preloadKv.read('_index'),
    writeIndex: (idx: unknown) => preloadKv.write('_index', idx),
    readCard: (id: string) => preloadKv.read(id),
    writeCard: (id: string, card: unknown) => {
      preloadKv.write(id, card);
      return id;
    },
    removeCard: (id: string) => preloadKv.delete(id),
    cardExists: (id: string) => preloadKv.read(id) !== null,
    defaultCardKey: (id: string) => id,
  } as any));
  const sourceCards = createFsCardSource(testCardsDir).listCards();
  for (const card of sourceCards) {
    if (typeof card.id !== 'string' || card.id.trim().length === 0) continue;
    const setResult = preloadStore.set({ body: card });
    if (setResult.status !== 'success') {
      throw new Error(`failed to preload card: ${setResult.error || 'unknown error'}`);
    }
  }

  const runtime = createSingleBoardServerRuntime(runtimeOptions);

  // Start an HTTP server using the platform-free runtime
  server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    if (method === 'OPTIONS') {
      res.writeHead(204, runtime.corsHeaders);
      res.end();
      return;
    }
    const url = new URL(req.url || '/', `http://127.0.0.1:${TEST_PORT}`);
    const handled = await runtime.handleRuntimeApi(
      req as unknown as RuntimeRequest,
      res as unknown as RuntimeResponse,
      url,
    );
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  await new Promise<void>((resolve) => {
    server!.listen(TEST_PORT, '127.0.0.1', resolve);
  });
});

afterAll(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  try { fs.rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ============================================================================
// Tests
// ============================================================================

describe('platform-free server runtime (Node host)', () => {
  it('GET /api/board/init-board returns runtime payload', async () => {
    const res = await fetch(`${API_BASE}/init-board`);
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('cardDefinitions');
    expect(data).toHaveProperty('statusSnapshot');
  });

  it('GET /api/board/board-status returns card definitions', async () => {
    const res = await fetch(`${API_BASE}/board-status`);
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('cardDefinitions');
    const cards = data.cardDefinitions as Array<Record<string, unknown>>;
    expect(cards.length).toBeGreaterThan(0);
    // Verify expected card IDs
    const ids = cards.map(c => c.id);
    expect(ids).toContain('card-portfolio');
    expect(ids).toContain('card-my-identity');
  });

  it('GET /api/board/board-status returns current status', async () => {
    const res = await fetch(`${API_BASE}/board-status`);
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('cardDefinitions');
    expect(data).toHaveProperty('cardRuntimeById');
  });

  it('POST /api/board/callback/board-worker/:token/success returns a client error for an invalid source token', async () => {
    const ref = serializeRef({ kind: 'fs-path', value: path.join(TEST_ROOT, 'missing-source.json') });
    const res = await fetch(`${API_BASE}/callback/board-worker/${encodeURIComponent('not-a-valid-token')}/success`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref }),
    });
    expect(res.status).toBe(400);
    const data = await res.json() as Record<string, unknown>;
    expect(String(data.error || '')).toContain('Invalid source token');
  });

  it('PATCH /api/board/cards/:id updates card data', async () => {
    // Get a card that exists
    const statusRes = await fetch(`${API_BASE}/board-status`);
    const statusData = await statusRes.json() as Record<string, unknown>;
    const cards = statusData.cardDefinitions as Array<Record<string, unknown>>;
    const cardId = cards[0].id as string;

    // Patch it
    const patchRes = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_data: { testKey: 'testValue' } }),
    });
    expect(patchRes.ok).toBe(true);
    const patchData = await patchRes.json() as Record<string, unknown>;
    expect(patchData).toHaveProperty('ok', true);
  });

  it('POST /api/board/cards/:id/retrigger triggers a forced refresh', async () => {
    const statusRes = await fetch(`${API_BASE}/board-status`);
    const statusData = await statusRes.json() as Record<string, unknown>;
    const cards = statusData.cardDefinitions as Array<Record<string, unknown>>;
    const cardId = cards[0].id as string;

    const res = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/retrigger`, {
      method: 'POST',
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('ok', true);
  });

  it('PATCH /api/board/cards/:id with unchanged content still returns ok', async () => {
    const statusRes = await fetch(`${API_BASE}/board-status`);
    const statusData = await statusRes.json() as Record<string, unknown>;
    const cards = statusData.cardDefinitions as Array<Record<string, unknown>>;
    const cardId = cards[0].id as string;

    // First set a known value
    await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_data: { noChangeKey: 'stable' } }),
    });

    // PATCH again with the exact same value — content unchanged, no restart should fire
    const res = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card_data: { noChangeKey: 'stable' } }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('ok', true);
  });

  it('POST /api/board/cards/:id/retrigger returns 404 for an unknown card', async () => {
    const res = await fetch(`${API_BASE}/cards/no-such-card/retrigger`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('POST /api/board/cards/:id/actions returns an error when chat-send has no handler', async () => {
    const statusRes = await fetch(`${API_BASE}/board-status`);
    const statusData = await statusRes.json() as Record<string, unknown>;
    const cards = statusData.cardDefinitions as Array<Record<string, unknown>>;
    const cardId = cards[0].id as string;

    const res = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actionType: 'chat-send',
        payload: { text: 'hello from integration test', 'turn-id': 'test-turn-no-handler' },
      }),
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: `chat handler is not configured for card: ${cardId}` });

    const chatsRes = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/chats`);
    expect(chatsRes.ok).toBe(true);
    const chatsData = await chatsRes.json() as Record<string, unknown>;
    expect(chatsData).toHaveProperty('ok', true);
    const messages = (chatsData as any).messages as Array<Record<string, unknown>>;
    expect(messages).toEqual([]);
  });

  it('POST /api/board/cards/:id/files uploads a file', async () => {
    const statusRes = await fetch(`${API_BASE}/board-status`);
    const statusData = await statusRes.json() as Record<string, unknown>;
    const cards = statusData.cardDefinitions as Array<Record<string, unknown>>;
    const cardId = cards[0].id as string;

    const res = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'x-file-name': encodeURIComponent('test-upload.txt'),
      },
      body: Buffer.from('hello world', 'utf-8'),
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('ok', true);
    expect(data).toHaveProperty('file');
    const file = data.file as Record<string, unknown>;
    expect(file).toHaveProperty('name', 'test-upload.txt');
    expect(file).toHaveProperty('stored_name');
    expect(file).toHaveProperty('size');

    const cardRes = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}`);
    expect(cardRes.ok).toBe(true);
    const cardData = await cardRes.json() as { card_data?: { files?: Array<Record<string, unknown>> } };
    const uploaded = Array.isArray(cardData.card_data?.files)
      ? cardData.card_data.files.find((entry) => entry?.stored_name === file.stored_name)
      : undefined;
    expect(uploaded).toBeTruthy();
    expect(uploaded?.chat).toBe(false);
  });

  it('GET /api/board/sse returns event-stream', async () => {
    const controller = new AbortController();
    const res = await fetch(`${API_BASE}/sse?clientId=test-sse-1`, { signal: controller.signal });
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    // Read the first SSE message
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    expect(text).toContain('data: ');

    // Parse the SSE data
    const jsonStr = text.split('data: ')[1]?.split('\n')[0];
    const sseData = JSON.parse(jsonStr!);
    expect(sseData).toHaveProperty('cardDefinitions');

    controller.abort();
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${API_BASE}/nonexistent`);
    expect(res.status).toBe(404);
  });

  // ── SSE reconnection / replay ────────────────────────────────────────────

  it('SSE frames include id: field for reconnection', async () => {
    const controller = new AbortController();
    const res = await fetch(`${API_BASE}/sse?clientId=test-sse-2`, { signal: controller.signal });
    expect(res.ok).toBe(true);

    const reader = res.body!.getReader();
    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);

    // Must contain id: <number> before data:
    expect(text).toMatch(/^id: \d+\n/);
    expect(text).toContain('data: ');

    controller.abort();
  });

  it('SSE reconnection with Last-Event-ID receives current snapshot', async () => {
    // First connection to get an event id
    const controller1 = new AbortController();
    const res1 = await fetch(`${API_BASE}/sse?clientId=test-sse-3a`, { signal: controller1.signal });
    const reader1 = res1.body!.getReader();
    const { value: v1 } = await reader1.read();
    const text1 = new TextDecoder().decode(v1);
    const idMatch = text1.match(/^id: (\d+)\n/);
    expect(idMatch).toBeTruthy();
    const firstId = idMatch![1];
    controller1.abort();

    // Simulate reconnection with Last-Event-ID header
    const controller2 = new AbortController();
    const res2 = await fetch(`${API_BASE}/sse?clientId=test-sse-3b`, {
      signal: controller2.signal,
      headers: { 'Last-Event-ID': firstId },
    });
    expect(res2.ok).toBe(true);

    const reader2 = res2.body!.getReader();
    const { value: v2 } = await reader2.read();
    const text2 = new TextDecoder().decode(v2);

    // New connection gets a new (higher) event id and full payload
    const idMatch2 = text2.match(/^id: (\d+)\n/);
    expect(idMatch2).toBeTruthy();
    expect(Number(idMatch2![1])).toBeGreaterThan(Number(firstId));

    const jsonStr = text2.split('data: ')[1]?.split('\n')[0];
    const payload = JSON.parse(jsonStr!);
    expect(payload).toHaveProperty('cardDefinitions');

    controller2.abort();
  });

  it('invokes SSE lifecycle hooks and allows host-written frames', async () => {
    const clientId = 'test-sse-hooks';
    const controller = new AbortController();
    const res = await fetch(`${API_BASE}/sse?clientId=${encodeURIComponent(clientId)}`, { signal: controller.signal });
    expect(res.ok).toBe(true);

    const reader = res.body!.getReader();
    const { value: firstValue } = await reader.read();
    const firstText = new TextDecoder().decode(firstValue);
    expect(firstText).toContain('data: ');

    await waitFor(() => sseConnected.includes(clientId) && sseWriters.has(clientId));
    sseWriters.get(clientId)!({ kind: 'server_notice', message: 'hello from host' });

    const { value: secondValue } = await reader.read();
    const secondText = new TextDecoder().decode(secondValue);
    expect(secondText).toContain('server_notice');

    controller.abort();
    await waitFor(() => sseDisconnected.includes(clientId));
  });

  it('supports board-scoped and card-scoped watch-channel subscribe/unsubscribe hooks', async () => {
    const statusRes = await fetch(`${API_BASE}/board-status`);
    const statusData = await statusRes.json() as Record<string, unknown>;
    const cards = statusData.cardDefinitions as Array<Record<string, unknown>>;
    const cardId = cards[0].id as string;
    const clientId = 'test-watch-channel';
    const controller = new AbortController();
    const res = await fetch(`${API_BASE}/sse?clientId=${encodeURIComponent(clientId)}`, { signal: controller.signal });
    expect(res.ok).toBe(true);
    const reader = res.body!.getReader();
    await reader.read();
    await waitFor(() => sseWriters.has(clientId));

    const subscribedBefore = channelSubscribed.length;
    const unsubscribedBefore = channelUnsubscribed.length;

    const boardSubscribe = await fetch(`${API_BASE}/watch-channel/watchparty/subscribe-sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId }),
    });
    expect(boardSubscribe.ok).toBe(true);
    await expect(boardSubscribe.json()).resolves.toMatchObject({ ok: true, clientId, channelName: 'watchparty', subscribed: true });

    const cardSubscribe = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/watch-channel/watchparty/subscribe-sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId }),
    });
    expect(cardSubscribe.ok).toBe(true);
    await expect(cardSubscribe.json()).resolves.toMatchObject({ ok: true, clientId, cardId, channelName: 'watchparty', subscribed: true });

    expect(channelSubscribed.slice(subscribedBefore)).toEqual([
      { clientId, channelName: 'watchparty', params: {} },
      { clientId, channelName: 'watchparty', params: { cardId } },
    ]);

    const cardUnsubscribe = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/watch-channel/watchparty/unsubscribe-sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId }),
    });
    expect(cardUnsubscribe.ok).toBe(true);
    await expect(cardUnsubscribe.json()).resolves.toMatchObject({ ok: true, clientId, cardId, channelName: 'watchparty', subscribed: false });

    const boardUnsubscribe = await fetch(`${API_BASE}/watch-channel/watchparty/unsubscribe-sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId }),
    });
    expect(boardUnsubscribe.ok).toBe(true);
    await expect(boardUnsubscribe.json()).resolves.toMatchObject({ ok: true, clientId, channelName: 'watchparty', subscribed: false });

    expect(channelUnsubscribed.slice(unsubscribedBefore)).toEqual([
      { clientId, channelName: 'watchparty', params: { cardId } },
      { clientId, channelName: 'watchparty', params: {} },
    ]);

    controller.abort();
    await waitFor(() => sseDisconnected.includes(clientId));
  });

  it('returns 404 for watch-channel subscription when SSE client is not connected', async () => {
    const res = await fetch(`${API_BASE}/watch-channel/watchparty/subscribe-sse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'missing-sse-client' }),
    });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: 'SSE client not connected: missing-sse-client' });
  });

  // ── Chat handler failure / .processing marker cleanup ────────────────────

  it('cleans up processing state when chat-handler dispatch fails', async () => {
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-srt-dispatch-fail-'));
    const isolatedBoardDir = path.join(isolatedRoot, 'runtime');
    const isolatedCardStoreDir = path.join(isolatedRoot, 'card-store');
    const isolatedOutputsDir = path.join(isolatedRoot, 'outputs');
    fs.mkdirSync(isolatedBoardDir, { recursive: true });
    fs.mkdirSync(isolatedCardStoreDir, { recursive: true });
    fs.mkdirSync(isolatedOutputsDir, { recursive: true });

    const isolatedCardsDir = path.join(isolatedRoot, 'cards');
    fs.mkdirSync(isolatedCardsDir, { recursive: true });
    for (const entry of fs.readdirSync(SOURCE_CARDS_DIR, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        fs.copyFileSync(path.join(SOURCE_CARDS_DIR, entry.name), path.join(isolatedCardsDir, entry.name));
      }
    }

    const baseRef = parseRef(serializeRef({ kind: 'fs-path', value: isolatedBoardDir }));
    const boardAdapter = createFsBoardPlatformAdapter(baseRef, repoRoot, { suppressSpawn: true });
    const cardStoreRef = serializeRef({ kind: 'fs-path', value: isolatedCardStoreDir });
    const outputsStoreRef = serializeRef({ kind: 'fs-path', value: isolatedOutputsDir });
    const preloadKv = boardAdapter.kvStorageForRef(cardStoreRef);
    const preloadStore = createCardStorePublic(createCardStore({
      readIndex: () => preloadKv.read('_index'),
      writeIndex: (idx: unknown) => preloadKv.write('_index', idx),
      readCard: (id: string) => preloadKv.read(id),
      writeCard: (id: string, card: unknown) => {
        preloadKv.write(id, card);
        return id;
      },
      removeCard: (id: string) => preloadKv.delete(id),
      cardExists: (id: string) => preloadKv.read(id) !== null,
      defaultCardKey: (id: string) => id,
    } as any));
    const preloadCards = createFsCardSource(isolatedCardsDir).listCards();
    for (const card of preloadCards) {
      const setResult = preloadStore.set({ body: card });
      expect(setResult.status).toBe('success');
    }

    const isolatedChatStorage = createInMemoryChatStorage();
    let flowRuns = 0;
    const runtime = createSingleBoardServerRuntime({
      apiBasePath: '/api/board',
      boardId: 'dispatch-fail-board',
      chatStorage: isolatedChatStorage,
      boards: [{
        label: 'base',
        boardAdapter,
        baseRef,
        cardStoreRef,
        outputsStoreRef,
        chatHandlerFlow: { steps: [{ id: 'append-chat', type: 'noop' }], transitions: [] },
      }],
      chatFlowRunner: {
        async run() {
          flowRuns += 1;
          return { dispatched: false, error: 'test dispatch failure' };
        },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      serverUrl: 'http://127.0.0.1:0',
    });

    const server2 = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const handled = await runtime.handleRuntimeApi(req as unknown as RuntimeRequest, res as unknown as RuntimeResponse, url);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
    const addr = server2.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const cardId = 'card-portfolio';

    const chatRes = await fetch(`http://127.0.0.1:${port}/api/board/cards/${encodeURIComponent(cardId)}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionType: 'chat-send', payload: { text: 'flow should fail dispatch', 'turn-id': 'test-turn-fail-dispatch' } }),
    });
    expect(chatRes.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(flowRuns).toBe(1);
    expect(isolatedChatStorage.isProcessing(cardId)).toBe(false);

    await new Promise<void>((resolve) => server2.close(() => resolve()));
    try { fs.rmSync(isolatedRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('runs chat-handler-flow when a chatFlowRunner is provided', async () => {
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-srt-flow-'));
    const isolatedBoardDir = path.join(isolatedRoot, 'runtime');
    const isolatedCardStoreDir = path.join(isolatedRoot, 'card-store');
    const isolatedOutputsDir = path.join(isolatedRoot, 'outputs');
    fs.mkdirSync(isolatedBoardDir, { recursive: true });
    fs.mkdirSync(isolatedCardStoreDir, { recursive: true });
    fs.mkdirSync(isolatedOutputsDir, { recursive: true });

    const isolatedCardsDir = path.join(isolatedRoot, 'cards');
    fs.mkdirSync(isolatedCardsDir, { recursive: true });
    for (const entry of fs.readdirSync(SOURCE_CARDS_DIR, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        fs.copyFileSync(path.join(SOURCE_CARDS_DIR, entry.name), path.join(isolatedCardsDir, entry.name));
      }
    }

    const baseRef = parseRef(serializeRef({ kind: 'fs-path', value: isolatedBoardDir }));
    const boardAdapter = createFsBoardPlatformAdapter(baseRef, repoRoot, { suppressSpawn: true });
    const cardStoreRef = serializeRef({ kind: 'fs-path', value: isolatedCardStoreDir });
    const outputsStoreRef = serializeRef({ kind: 'fs-path', value: isolatedOutputsDir });
    const preloadKv = boardAdapter.kvStorageForRef(cardStoreRef);
    const preloadStore = createCardStorePublic(createCardStore({
      readIndex: () => preloadKv.read('_index'),
      writeIndex: (idx: unknown) => preloadKv.write('_index', idx),
      readCard: (id: string) => preloadKv.read(id),
      writeCard: (id: string, card: unknown) => {
        preloadKv.write(id, card);
        return id;
      },
      removeCard: (id: string) => preloadKv.delete(id),
      cardExists: (id: string) => preloadKv.read(id) !== null,
      defaultCardKey: (id: string) => id,
    } as any));
    const preloadCards = createFsCardSource(isolatedCardsDir).listCards();
    for (const card of preloadCards) {
      const setResult = preloadStore.set({ body: card });
      expect(setResult.status).toBe('success');
    }

    let flowRuns = 0;
    const runtime = createSingleBoardServerRuntime({
      apiBasePath: '/api/board',
      boardId: 'flow-test-board',
      boards: [{
        label: 'base',
        boardAdapter,
        baseRef,
        cardStoreRef,
        outputsStoreRef,
        chatHandlerFlow: { steps: [{ id: 'append-chat', type: 'noop' }], transitions: [] },
      }],
      chatFlowRunner: {
        async run() {
          flowRuns += 1;
          return { dispatched: false, error: 'test cleanup path' };
        },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      serverUrl: 'http://127.0.0.1:0',
    });

    const server2 = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const handled = await runtime.handleRuntimeApi(req as unknown as RuntimeRequest, res as unknown as RuntimeResponse, url);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
    const addr = server2.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const chatRes = await fetch(`http://127.0.0.1:${port}/api/board/cards/card-portfolio/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actionType: 'chat-send', payload: { text: 'flow preferred', 'turn-id': 'test-turn-flow-preferred' } }),
    });
    expect(chatRes.ok).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(flowRuns).toBe(1);

    await new Promise<void>((resolve) => server2.close(() => resolve()));
    try { fs.rmSync(isolatedRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('keeps upload-route system chat but does not add a second upload system chat on chat-send', async () => {
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-srt-upload-chat-'));
    const isolatedBoardDir = path.join(isolatedRoot, 'runtime');
    const isolatedCardStoreDir = path.join(isolatedRoot, 'card-store');
    const isolatedOutputsDir = path.join(isolatedRoot, 'outputs');
    fs.mkdirSync(isolatedBoardDir, { recursive: true });
    fs.mkdirSync(isolatedCardStoreDir, { recursive: true });
    fs.mkdirSync(isolatedOutputsDir, { recursive: true });

    const isolatedCardsDir = path.join(isolatedRoot, 'cards');
    fs.mkdirSync(isolatedCardsDir, { recursive: true });
    for (const entry of fs.readdirSync(SOURCE_CARDS_DIR, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.json')) {
        fs.copyFileSync(path.join(SOURCE_CARDS_DIR, entry.name), path.join(isolatedCardsDir, entry.name));
      }
    }

    const baseRef = parseRef(serializeRef({ kind: 'fs-path', value: isolatedBoardDir }));
    const boardAdapter = createFsBoardPlatformAdapter(baseRef, repoRoot, { suppressSpawn: true });
    const cardStoreRef = serializeRef({ kind: 'fs-path', value: isolatedCardStoreDir });
    const outputsStoreRef = serializeRef({ kind: 'fs-path', value: isolatedOutputsDir });
    const preloadKv = boardAdapter.kvStorageForRef(cardStoreRef);
    const preloadStore = createCardStorePublic(createCardStore({
      readIndex: () => preloadKv.read('_index'),
      writeIndex: (idx: unknown) => preloadKv.write('_index', idx),
      readCard: (id: string) => preloadKv.read(id),
      writeCard: (id: string, card: unknown) => {
        preloadKv.write(id, card);
        return id;
      },
      removeCard: (id: string) => preloadKv.delete(id),
      cardExists: (id: string) => preloadKv.read(id) !== null,
      defaultCardKey: (id: string) => id,
    } as any));
    const preloadCards = createFsCardSource(isolatedCardsDir).listCards();
    for (const card of preloadCards) {
      const setResult = preloadStore.set({ body: card });
      expect(setResult.status).toBe('success');
    }

    const isolatedChatStorage = createInMemoryChatStorage();
    const runtime = createSingleBoardServerRuntime({
      apiBasePath: '/api/board',
      boardId: 'upload-chat-board',
      chatStorage: isolatedChatStorage,
      boards: [{
        label: 'base',
        boardAdapter,
        baseRef,
        cardStoreRef,
        outputsStoreRef,
        chatHandlerFlow: { steps: [{ id: 'append-chat', type: 'noop' }], transitions: [] },
      }],
      chatFlowRunner: {
        async run(_flow, args) {
          const cardId = String(args.cardId || '');
          isolatedChatStorage.append(cardId, 'system', 'in-progress', []);
          isolatedChatStorage.append(cardId, 'assistant', 'Echo: attached file processed', []);
          isolatedChatStorage.setProcessing(cardId, false);
          return { dispatched: true };
        },
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      serverUrl: 'http://127.0.0.1:0',
    });

    const server2 = http.createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const handled = await runtime.handleRuntimeApi(req as unknown as RuntimeRequest, res as unknown as RuntimeResponse, url);
      if (!handled) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
    const addr = server2.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const cardId = 'card-portfolio';

    const uploadRes = await fetch(`http://127.0.0.1:${port}/api/board/cards/${encodeURIComponent(cardId)}/files?inChat=true&turn-id=test-turn-upload-send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'x-file-name': encodeURIComponent('q1.txt'),
      },
      body: Buffer.from('what is the capital of japan', 'utf-8'),
    });
    expect(uploadRes.ok).toBe(true);
    const uploadData = await uploadRes.json() as { file?: Record<string, unknown> };
    const uploadedFile = uploadData.file;
    expect(uploadedFile).toBeTruthy();

    const afterUploadMessages = isolatedChatStorage.readAll(cardId);
    expect(afterUploadMessages).toHaveLength(1);
    expect(afterUploadMessages[0]?.role).toBe('system');
    expect(afterUploadMessages[0]?.text).toContain('file uploaded: q1.txt as ');
    expect(afterUploadMessages[0]?.text).toMatch(/#0$/);

    const afterUploadCardRes = await fetch(`http://127.0.0.1:${port}/api/board/cards/${encodeURIComponent(cardId)}`);
    expect(afterUploadCardRes.ok).toBe(true);
    const afterUploadCard = await afterUploadCardRes.json() as { card_data?: { files?: Array<Record<string, unknown>> } };
    const storedUpload = Array.isArray(afterUploadCard.card_data?.files)
      ? afterUploadCard.card_data.files.find((entry) => entry?.stored_name === uploadedFile?.stored_name)
      : undefined;
    expect(storedUpload).toBeTruthy();
    expect(storedUpload?.chat).toBe(true);

    const baselineCount = afterUploadMessages.length;
    const sendRes = await fetch(`http://127.0.0.1:${port}/api/board/cards/${encodeURIComponent(cardId)}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actionType: 'chat-send',
        payload: {
          text: 'please use the uploaded file',
          files: [uploadedFile],
          'turn-id': 'test-turn-upload-send',
        },
      }),
    });
    expect(sendRes.ok).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 50));

    const newMessages = isolatedChatStorage.readAll(cardId).slice(baselineCount);
    expect(newMessages.map((message) => message.role)).toEqual(['user', 'system', 'assistant']);
    expect(newMessages[0]?.files).toHaveLength(1);
    expect(newMessages[1]?.text).toBe('in-progress');
    expect(newMessages[2]?.text).toBe('Echo: attached file processed');
    expect(newMessages.some((message) => message.text.includes('File q1.txt uploaded as'))).toBe(false);

    await new Promise<void>((resolve) => server2.close(() => resolve()));
    try { fs.rmSync(isolatedRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
