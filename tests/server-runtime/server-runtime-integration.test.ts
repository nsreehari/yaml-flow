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
import type { BoardWorkerRequest } from '../../src/cli/common/board-worker-store.js';
import { createBoardWorkerStore } from '../../src/cli/common/board-worker-store.js';
import { createCardStorePublic } from '../../src/cli/common/card-store-lib-public.js';
import { createCardStore } from '../../src/cli/common/board-live-cards-lib.js';

// ── Import FS adapters (Node-specific) ─────────────────────────────────────
import { createFsBoardChatStorage, createFsBoardNonCorePlatformAdapter, createFsBoardPlatformAdapter } from '../../src/cli/node/fs-board-adapter.js';
import { serializeRef, parseRef } from '../../src/cli/common/storage-interface.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_CARDS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cards');

const TEST_PORT = 7900 + Math.floor(Math.random() * 100);
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-srt-'));
const BOARD_DIR = path.join(TEST_ROOT, 'runtime');
const BOARD_RUNTIME_DIR = path.join(TEST_ROOT, '.board-runtime');
const QUEUE_STORE_DIR = path.join(TEST_ROOT, '.board-queue');
const CARD_STORE_DIR = path.join(TEST_ROOT, 'card-store');
const OUTPUTS_DIR = path.join(TEST_ROOT, 'outputs');
const CHAT_STORE_DIR = path.join(TEST_ROOT, 'chat');
const ARTIFACTS_DIR = path.join(TEST_ROOT, 'files');
const FETCHED_SOURCES_DIR = path.join(TEST_ROOT, 'sources');
const SCRATCH_DIR = path.join(TEST_ROOT, 'scratch');
const ARCHIVE_DIR = path.join(TEST_ROOT, 'archive');
const API_BASE = `http://127.0.0.1:${TEST_PORT}/api/board`;

let server: http.Server | null = null;
const testChatStorage = createFsBoardChatStorage(CHAT_STORE_DIR);
const sseConnected: string[] = [];
const sseDisconnected: string[] = [];
const sseWriters = new Map<string, (payload: unknown) => void>();
const channelSubscribed: Array<{ clientId: string; channelName: string; params: { cardId?: string } }> = [];
const channelUnsubscribed: Array<{ clientId: string; channelName: string; params: { cardId?: string } }> = [];

async function fetchOneShotPayload(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  expect(res.ok).toBe(true);
  expect(res.headers.get('content-type')).toBe('text/event-stream');
  const text = await res.text();
  const jsonStr = text.split('data: ')[1]?.split('\n')[0];
  expect(jsonStr).toBeTruthy();
  return JSON.parse(jsonStr!) as Record<string, unknown>;
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function drainQueuedChatRequests(runtime: { handleChatAgentRequest(request: BoardWorkerRequest): Promise<void> | void }, boardAdapter: { queueStorageForRef(ref: string, lane: string): unknown }, queueStoreRef: string): Promise<void> {
  const workerStore = createBoardWorkerStore(boardAdapter.queueStorageForRef(queueStoreRef, 'chat-agent') as never);
  const leases = workerStore.leaseRequests({ max: 20, visibilityMs: 60_000 });
  for (const lease of leases) {
    try {
      await runtime.handleChatAgentRequest(lease.request);
      workerStore.ackRequest(lease.messageId, lease.leaseToken);
    } catch (error) {
      workerStore.nackRequest(lease.messageId, lease.leaseToken, {
        dead: lease.attempt >= 5,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
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
  fs.mkdirSync(BOARD_RUNTIME_DIR, { recursive: true });
  fs.mkdirSync(QUEUE_STORE_DIR, { recursive: true });
  fs.mkdirSync(CARD_STORE_DIR, { recursive: true });
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
  fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

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
  const nonCoreAdapter = createFsBoardNonCorePlatformAdapter(baseRef, repoRoot, { suppressSpawn: true, onWarn: () => {} });
  const executorPath = path.join(TEST_ROOT, 'fake-task-executor.mjs');
  fs.writeFileSync(executorPath, `#!/usr/bin/env node
const subcommand = process.argv[2] || '';
const inputText = await new Promise((resolve) => {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { buf += chunk; });
  process.stdin.on('end', () => resolve(buf.trim()));
  process.stdin.resume();
});
const parsedInput = inputText ? JSON.parse(inputText) : null;
if (subcommand === 'describe-capabilities') {
  console.log(JSON.stringify({ version: '1.0', commonSourceDefFields: { bindTo: { type: 'string' } }, sourceKinds: { fake: { title: 'Fake Source' } } }));
  process.exit(0);
}
if (subcommand === 'validate-card-preflight') {
  console.log(JSON.stringify({ ok: true, errors: [] }));
  process.exit(0);
}
if (subcommand === 'probe-source-preflight') {
  console.log(JSON.stringify({ ok: true, reachable: true, latencyMs: 3 }));
  process.exit(0);
}
if (subcommand === 'run-source-preflight') {
  console.log(JSON.stringify({ ok: true, reachable: true, latencyMs: 4, bindTo: parsedInput?.bindTo || 'source', resultValue: { ok: true } }));
  process.exit(0);
}
if (subcommand === 'run-source-fetch') {
  const outIdx = process.argv.indexOf('--out-ref');
  const outRef = process.argv[outIdx + 1];
  if (!outRef) {
    console.error('missing --out-ref');
    process.exit(1);
  }
  const refValue = JSON.parse(Buffer.from(outRef.slice(4), 'base64url').toString('utf8')).value;
  await import('node:fs/promises').then((nodeFs) => nodeFs.writeFile(refValue, JSON.stringify({ ok: true })));
  process.exit(0);
}
if (subcommand === 'validate-source-def') {
  console.log(JSON.stringify({ ok: true, errors: [] }));
  process.exit(0);
}
console.error('unsupported subcommand: ' + subcommand);
process.exit(1);
`, 'utf-8');

  const runtimeOptions: SingleBoardRuntimeOptions = {
    apiBasePath: '/api/board',
    boardId: 'test-board',
    boards: [{
      label: 'base',
      boardAdapter,
      nonCoreAdapter,
      baseRef,
      boardRuntimeStoreRef: serializeRef({ kind: 'fs-path', value: BOARD_RUNTIME_DIR }),
      queueStoreRef: serializeRef({ kind: 'fs-path', value: QUEUE_STORE_DIR }),
      cardStoreRef: serializeRef({ kind: 'fs-path', value: CARD_STORE_DIR }),
      outputsStoreRef: serializeRef({ kind: 'fs-path', value: OUTPUTS_DIR }),
      chatStoreRef: serializeRef({ kind: 'fs-path', value: CHAT_STORE_DIR }),
      artifactsStoreRef: serializeRef({ kind: 'fs-path', value: ARTIFACTS_DIR }),
      fetchedSourcesStoreRef: serializeRef({ kind: 'fs-path', value: FETCHED_SOURCES_DIR }),
      scratchStoreRef: serializeRef({ kind: 'fs-path', value: SCRATCH_DIR }),
      cardSource: createFsCardSource(testCardsDir),
      taskExecutorRef: {
        howToRun: 'local-node',
        whatToRun: serializeRef({ kind: 'fs-path', value: executorPath }),
      },
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
  it('GET /api/board/sse?one-shot returns runtime payload', async () => {
    const data = await fetchOneShotPayload(`${API_BASE}/sse?one-shot`);
    expect(data).toHaveProperty('cardDefinitions');
    expect(data).toHaveProperty('statusSnapshot');
  });

  it('GET /api/board/sse?one-shot includes card definitions with expected IDs', async () => {
    const data = await fetchOneShotPayload(`${API_BASE}/sse?one-shot`);
    expect(data).toHaveProperty('cardDefinitions');
    const cards = data.cardDefinitions as Array<Record<string, unknown>>;
    expect(cards.length).toBeGreaterThan(0);
    // Verify expected card IDs
    const ids = cards.map(c => c.id);
    expect(ids).toContain('card-portfolio');
    expect(ids).toContain('card-my-identity');
  });

  it('GET /api/board/sse?one-shot includes runtime status snapshot', async () => {
    const data = await fetchOneShotPayload(`${API_BASE}/sse?one-shot`);
    expect(data).toHaveProperty('cardDefinitions');
    expect(data).toHaveProperty('statusSnapshot');
  });

  it('POST /api/board/mcp-webhooks returns a client error for an invalid source token', async () => {
    const ref = serializeRef({ kind: 'fs-path', value: path.join(TEST_ROOT, 'missing-source.json') });
    const res = await fetch(`${API_BASE}/mcp-webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'webhook.source-fetch-done',
        args: { token: 'not-a-valid-token', ref },
      }),
    });
    expect(res.status).toBe(400);
    const data = await res.json() as Record<string, unknown>;
    expect(String(data.error || '')).toContain('Invalid source token');
  });

  it('manage.patch-card updates card data', async () => {
    const cardId = 'patch-test-card';
    // Seed a simple card via /mcp first
    const seedRes = await fetch(`${API_BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'manage.upsert-card', args: { card_id: cardId, candidate_card_content: { id: cardId, card_data: { title: 'Patch Test' }, view: { elements: [{ id: 'title', kind: 'text', data: { bind: 'card_data.title' } }] } } } }),
    });
    expect(seedRes.ok).toBe(true);

    // Patch it via MCP controlplane
    const patchRes = await fetch(`${API_BASE}/mcp-controlplane`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'manage.patch-card', args: { board_id: 'test-board', card_id: cardId, patch: { card_data: { testKey: 'testValue' } } } }),
    });
    expect(patchRes.ok).toBe(true);
    const patchData = await patchRes.json() as Record<string, unknown>;
    expect(patchData).toHaveProperty('status', 'success');
  });

  it('POST /api/board/cards/:id/retrigger triggers a forced refresh', async () => {
    const initData = await fetchOneShotPayload(`${API_BASE}/sse?one-shot`);
    const cards = initData.cardDefinitions as Array<Record<string, unknown>>;
    const cardId = cards[0].id as string;

    const res = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/retrigger`, {
      method: 'POST',
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('ok', true);
  });

  it('manage.patch-card with unchanged content still returns ok', async () => {
    const cardId = 'patch-unchanged-card';
    // Seed a simple card via /mcp first
    const seedRes = await fetch(`${API_BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'manage.upsert-card', args: { card_id: cardId, candidate_card_content: { id: cardId, card_data: { noChangeKey: 'stable' }, view: { elements: [{ id: 'v', kind: 'text', data: { bind: 'card_data.noChangeKey' } }] } } } }),
    });
    if (!seedRes.ok) {
      throw new Error(`Seed upsert failed with status ${seedRes.status}: ${await seedRes.text()}`);
    }

    // First patch to set a known value
    const firstPatchRes = await fetch(`${API_BASE}/mcp-controlplane`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'manage.patch-card', args: { board_id: 'test-board', card_id: cardId, patch: { card_data: { noChangeKey: 'stable' } } } }),
    });
    if (!firstPatchRes.ok) {
      throw new Error(`First unchanged patch failed with status ${firstPatchRes.status}: ${await firstPatchRes.text()}`);
    }

    const firstReadRes = await fetch(`${API_BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'manage.read-card', args: { card_id: cardId } }),
    });
    expect(firstReadRes.ok).toBe(true);
    const firstReadData = await firstReadRes.json() as Record<string, unknown>;
    const firstCard = (firstReadData.data as Array<Record<string, unknown>>)[0];
    expect(firstCard?.card_data).toEqual({ noChangeKey: 'stable' });

    // Patch again with the exact same value — content unchanged, no restart should fire
    const res = await fetch(`${API_BASE}/mcp-controlplane`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'manage.patch-card', args: { board_id: 'test-board', card_id: cardId, patch: { card_data: { noChangeKey: 'stable' } } } }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    expect(data).toHaveProperty('status', 'success');

    const secondReadRes = await fetch(`${API_BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'manage.read-card', args: { card_id: cardId } }),
    });
    expect(secondReadRes.ok).toBe(true);
    const secondReadData = await secondReadRes.json() as Record<string, unknown>;
    const secondCard = (secondReadData.data as Array<Record<string, unknown>>)[0];
    expect(secondCard?.card_data).toEqual(firstCard?.card_data);
  });

  it('POST /api/board/cards/:id/retrigger returns 404 for an unknown card', async () => {
    const res = await fetch(`${API_BASE}/cards/no-such-card/retrigger`, { method: 'POST' });
    expect(res.status).toBe(404);
  });

  it('POST /api/board/mcp-actions returns an error when chat-send has no handler', async () => {
    const initData = await fetchOneShotPayload(`${API_BASE}/sse?one-shot`);
    const cards = initData.cardDefinitions as Array<Record<string, unknown>>;
    const cardId = cards[0].id as string;

    const res = await fetch(`${API_BASE}/mcp-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'chat-send',
        args: {
          card_id: cardId,
          payload: { text: 'hello from integration test', 'turn-id': 'test-turn-no-handler' },
        },
      }),
    });
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: `chat handler is not configured for card: ${cardId}` });

    const chatsRes = await fetch(`${API_BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'inspect.chat-messages-on-cards', args: { card_id: cardId } }),
    });
    expect(chatsRes.ok).toBe(true);
    const chatsData = await chatsRes.json() as { status: string; data: { messages: Array<Record<string, unknown>> } };
    expect(chatsData.status).toBe('success');
    const messages = chatsData.data?.messages;
    expect(messages).toEqual([]);
  });

  it('manage.upload-card-file uploads a non-chat file', async () => {
    const initData = await fetchOneShotPayload(`${API_BASE}/sse?one-shot`);
    const cardDefs = initData.cardDefinitions as Array<Record<string, unknown>>;
    const cardId = cardDefs[0].id as string;

    const res = await fetch(`${API_BASE}/mcp-controlplane`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'manage.upload-card-file',
        args: { board_id: 'test-board', card_id: cardId, file_name: 'test-upload.txt', content_type: 'text/plain', text: 'hello world' },
      }),
    });
    expect(res.ok).toBe(true);
    const resp = await res.json() as { status: string; data: { ok: boolean; file: Record<string, unknown> } };
    expect(resp.status).toBe('success');
    const file = resp.data?.file as Record<string, unknown>;
    expect(file).toHaveProperty('name', 'test-upload.txt');
    expect(file).toHaveProperty('stored_name');
    expect(file).toHaveProperty('size');

    const cardRes = await fetch(`${API_BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'manage.read-card', args: { card_id: cardId } }),
    });
    expect(cardRes.ok).toBe(true);
    const cardResp = await cardRes.json() as { status: string; data: Array<{ card_data?: { files?: Array<Record<string, unknown>> } }> };
    const cardData = cardResp.data?.[0];
    const uploaded = Array.isArray(cardData?.card_data?.files)
      ? cardData.card_data!.files!.find((entry) => entry?.stored_name === file.stored_name)
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

  it('GET /api/board/sse?one-shot returns a single SSE snapshot without requiring clientId', async () => {
    const res = await fetch(`${API_BASE}/sse?one-shot`);
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toBe('text/event-stream');

    const text = await res.text();
    expect(text).toContain('data: ');

    const matches = text.match(/^id: \d+\n/gm) ?? [];
    expect(matches).toHaveLength(1);

    const jsonStr = text.split('data: ')[1]?.split('\n')[0];
    const sseData = JSON.parse(jsonStr!);
    expect(sseData).toHaveProperty('cardDefinitions');
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
    const initData = await fetchOneShotPayload(`${API_BASE}/sse?one-shot`);
    const cards = initData.cardDefinitions as Array<Record<string, unknown>>;
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
    const isolatedArtifactsDir = path.join(isolatedRoot, 'files');
    const isolatedFetchedSourcesDir = path.join(isolatedRoot, 'sources');
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

    const isolatedChatStoreDir = path.join(isolatedRoot, 'chat');
    const isolatedChatStoreRef = serializeRef({ kind: 'fs-path', value: isolatedChatStoreDir });
    const isolatedBoardRuntimeDir = path.join(isolatedRoot, '.board-runtime');
    const isolatedQueueStoreDir = path.join(isolatedRoot, '.board-queue');
    fs.mkdirSync(isolatedBoardRuntimeDir, { recursive: true });
    fs.mkdirSync(isolatedQueueStoreDir, { recursive: true });
    const isolatedChatStorage = boardAdapter.chatStorageForRef(isolatedChatStoreRef);
    let flowRuns = 0;
    const runtime = createSingleBoardServerRuntime({
      apiBasePath: '/api/board',
      boardId: 'dispatch-fail-board',
      boards: [{
        label: 'base',
        boardAdapter,
        baseRef,
        boardRuntimeStoreRef: serializeRef({ kind: 'fs-path', value: isolatedBoardRuntimeDir }),
        queueStoreRef: serializeRef({ kind: 'fs-path', value: isolatedQueueStoreDir }),
        cardStoreRef,
        outputsStoreRef,
        chatStoreRef: isolatedChatStoreRef,
        artifactsStoreRef: serializeRef({ kind: 'fs-path', value: isolatedArtifactsDir }),
        fetchedSourcesStoreRef: serializeRef({ kind: 'fs-path', value: isolatedFetchedSourcesDir }),
        scratchStoreRef: serializeRef({ kind: 'fs-path', value: path.join(isolatedRoot, 'scratch') }),
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

    const chatRes = await fetch(`http://127.0.0.1:${port}/api/board/mcp-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'chat-send',
        args: {
          card_id: cardId,
          payload: { text: 'flow should fail dispatch', 'turn-id': 'test-turn-fail-dispatch' },
        },
      }),
    });
    expect(chatRes.ok).toBe(true);
    expect(flowRuns).toBe(0);

    await drainQueuedChatRequests(runtime, boardAdapter, serializeRef({ kind: 'fs-path', value: isolatedQueueStoreDir }));
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
    const isolatedArtifactsDir = path.join(isolatedRoot, 'files');
    const isolatedFetchedSourcesDir = path.join(isolatedRoot, 'sources');
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

    const isolatedChatStoreRef = serializeRef({ kind: 'fs-path', value: path.join(isolatedRoot, 'chat') });
    const isolatedBoardRuntimeDir = path.join(isolatedRoot, '.board-runtime');
    const isolatedQueueStoreDir = path.join(isolatedRoot, '.board-queue');
    fs.mkdirSync(isolatedBoardRuntimeDir, { recursive: true });
    fs.mkdirSync(isolatedQueueStoreDir, { recursive: true });
    let flowRuns = 0;
    const runtime = createSingleBoardServerRuntime({
      apiBasePath: '/api/board',
      boardId: 'flow-test-board',
      boards: [{
        label: 'base',
        boardAdapter,
        baseRef,
        boardRuntimeStoreRef: serializeRef({ kind: 'fs-path', value: isolatedBoardRuntimeDir }),
        queueStoreRef: serializeRef({ kind: 'fs-path', value: isolatedQueueStoreDir }),
        cardStoreRef,
        outputsStoreRef,
        chatStoreRef: isolatedChatStoreRef,
        artifactsStoreRef: serializeRef({ kind: 'fs-path', value: isolatedArtifactsDir }),
        fetchedSourcesStoreRef: serializeRef({ kind: 'fs-path', value: isolatedFetchedSourcesDir }),
        scratchStoreRef: serializeRef({ kind: 'fs-path', value: path.join(isolatedRoot, 'scratch') }),
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

    const chatRes = await fetch(`http://127.0.0.1:${port}/api/board/mcp-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'chat-send',
        args: {
          card_id: 'card-portfolio',
          payload: { text: 'flow preferred', 'turn-id': 'test-turn-flow-preferred' },
        },
      }),
    });
    expect(chatRes.ok).toBe(true);
    expect(flowRuns).toBe(0);
    await drainQueuedChatRequests(runtime, boardAdapter, serializeRef({ kind: 'fs-path', value: isolatedQueueStoreDir }));
    expect(flowRuns).toBe(1);

    await new Promise<void>((resolve) => server2.close(() => resolve()));
    try { fs.rmSync(isolatedRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('keeps upload-route system chat but does not add a second upload system chat on chat-send', async () => {
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-srt-upload-chat-'));
    const isolatedBoardDir = path.join(isolatedRoot, 'runtime');
    const isolatedCardStoreDir = path.join(isolatedRoot, 'card-store');
    const isolatedOutputsDir = path.join(isolatedRoot, 'outputs');
    const isolatedArtifactsDir = path.join(isolatedRoot, 'files');
    const isolatedFetchedSourcesDir = path.join(isolatedRoot, 'sources');
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

    const isolatedChatStoreDir = path.join(isolatedRoot, 'chat');
    const isolatedChatStoreRef = serializeRef({ kind: 'fs-path', value: isolatedChatStoreDir });
    const isolatedBoardRuntimeDir = path.join(isolatedRoot, '.board-runtime');
    const isolatedQueueStoreDir = path.join(isolatedRoot, '.board-queue');
    fs.mkdirSync(isolatedBoardRuntimeDir, { recursive: true });
    fs.mkdirSync(isolatedQueueStoreDir, { recursive: true });
    const isolatedChatStorage = boardAdapter.chatStorageForRef(isolatedChatStoreRef);
    const runtime = createSingleBoardServerRuntime({
      apiBasePath: '/api/board',
      boardId: 'upload-chat-board',
      boards: [{
        label: 'base',
        boardAdapter,
        baseRef,
        boardRuntimeStoreRef: serializeRef({ kind: 'fs-path', value: isolatedBoardRuntimeDir }),
        queueStoreRef: serializeRef({ kind: 'fs-path', value: isolatedQueueStoreDir }),
        cardStoreRef,
        outputsStoreRef,
        chatStoreRef: isolatedChatStoreRef,
        artifactsStoreRef: serializeRef({ kind: 'fs-path', value: isolatedArtifactsDir }),
        fetchedSourcesStoreRef: serializeRef({ kind: 'fs-path', value: isolatedFetchedSourcesDir }),
        scratchStoreRef: serializeRef({ kind: 'fs-path', value: path.join(isolatedRoot, 'scratch') }),
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

    const uploadRes = await fetch(`http://127.0.0.1:${port}/api/board/mcp-controlplane`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'manage.add-chat-attachment',
        args: {
          board_id: 'upload-chat-board',
          card_id: cardId,
          turn_id: 'test-turn-upload-send',
          file_name: 'q1.txt',
          content_type: 'text/plain',
          text: 'what is the capital of japan',
        },
      }),
    });
    expect(uploadRes.ok).toBe(true);
    const uploadData = await uploadRes.json() as { status: string; data: { files: Array<Record<string, unknown>> } };
    expect(uploadData.status).toBe('success');
    const uploadedFile = uploadData.data?.files?.[0];
    expect(uploadedFile).toBeTruthy();

    const afterUploadMessages = isolatedChatStorage.readAll(cardId);
    expect(afterUploadMessages).toHaveLength(1);
    expect(afterUploadMessages.map((message) => message.role)).toEqual(['system']);
    expect(afterUploadMessages[0]?.text).toContain('file uploaded: q1.txt as ');
    expect(afterUploadMessages[0]?.text).toMatch(/#0$/);
    expect(afterUploadMessages[0]?.turn).toBe('test-turn-upload-send');

    const afterUploadCardRes = await fetch(`http://127.0.0.1:${port}/api/board/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'manage.read-card', args: { card_id: cardId } }),
    });
    expect(afterUploadCardRes.ok).toBe(true);
    const afterUploadCardResp = await afterUploadCardRes.json() as { status: string; data: Array<{ card_data?: { files?: Array<Record<string, unknown>> } }> };
    const afterUploadCard = afterUploadCardResp.data?.[0];
    const storedUpload = Array.isArray(afterUploadCard?.card_data?.files)
      ? afterUploadCard.card_data!.files!.find((entry) => entry?.stored_name === uploadedFile?.stored_name)
      : undefined;
    expect(storedUpload).toBeTruthy();
    expect(storedUpload?.chat).toBe(true);

    const baselineCount = afterUploadMessages.length;
    const sendRes = await fetch(`http://127.0.0.1:${port}/api/board/mcp-actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tool: 'chat-send',
        args: {
          card_id: cardId,
          payload: {
            text: 'please use the uploaded file',
            'turn-id': 'test-turn-upload-send',
          },
        },
      }),
    });
    expect(sendRes.ok).toBe(true);

    const beforeDrainMessages = isolatedChatStorage.readAll(cardId).slice(baselineCount);
    expect(beforeDrainMessages.map((message) => message.role)).toEqual(['user']);

    await drainQueuedChatRequests(runtime, boardAdapter, serializeRef({ kind: 'fs-path', value: isolatedQueueStoreDir }));

    const newMessages = isolatedChatStorage.readAll(cardId).slice(baselineCount);
    expect(newMessages.map((message) => message.role)).toEqual(['user', 'system', 'assistant']);
    expect(newMessages[0]?.files).toEqual([]);
    expect(newMessages[1]?.text).toBe('in-progress');
    expect(newMessages[2]?.text).toBe('Echo: attached file processed');
    expect(newMessages.some((message) => message.text.includes('File q1.txt uploaded as'))).toBe(false);
    expect(newMessages.some((message) => message.text.includes('file uploaded: q1.txt as '))).toBe(false);

    await new Promise<void>((resolve) => server2.close(() => resolve()));
    try { fs.rmSync(isolatedRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});
