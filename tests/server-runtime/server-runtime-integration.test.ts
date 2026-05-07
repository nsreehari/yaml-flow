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
  InvocationAdapter,
} from '../../src/server-runtime/types.js';

// ── Import FS adapters (Node-specific) ─────────────────────────────────────
import { createFsBoardPlatformAdapter } from '../../src/cli/node/fs-board-adapter.js';
import { serializeRef, parseRef } from '../../src/cli/common/storage-interface.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const exampleBoardDir = path.join(repoRoot, 'demo-src', 'example-board');
const SOURCE_CARDS_DIR = path.join(exampleBoardDir, 'cards');

const TEST_PORT = 7900 + Math.floor(Math.random() * 100);
const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-srt-'));
const BOARD_DIR = path.join(TEST_ROOT, 'runtime');
const CARD_STORE_DIR = path.join(TEST_ROOT, 'card-store');
const OUTPUTS_DIR = path.join(TEST_ROOT, 'outputs');
const API_BASE = `http://127.0.0.1:${TEST_PORT}/api/board`;

let server: http.Server | null = null;

// ── CardSourceAdapter from FS ──────────────────────────────────────────────
function createFsCardSource(cardsDir: string): CardSourceAdapter {
  return {
    listCards(): Array<Record<string, unknown>> {
      const files = fs.readdirSync(cardsDir).filter(f => f.endsWith('.json'));
      return files.map(f => {
        const raw = fs.readFileSync(path.join(cardsDir, f), 'utf-8');
        return JSON.parse(raw);
      });
    },
  };
}

// ── Noop InvocationAdapter (no executors in this test) ─────────────────────
const noopInvocation: InvocationAdapter = {
  async invoke() { return { dispatched: false, error: 'noop' }; },
};

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

  const baseRef = parseRef(`::fs-path::${BOARD_DIR}`);
  const boardAdapter = createFsBoardPlatformAdapter(baseRef, repoRoot, { suppressSpawn: true });

  const runtimeOptions: SingleBoardRuntimeOptions = {
    apiBasePath: '/api/board',
    boardId: 'test-board',
    boards: [{
      label: 'base',
      boardAdapter,
      baseRef,
      cardStoreRef: serializeRef({ kind: 'fs-path', value: CARD_STORE_DIR }),
      outputsStoreRef: serializeRef({ kind: 'fs-path', value: OUTPUTS_DIR }),
      cardSource: createFsCardSource(testCardsDir),
    }],
    invocationAdapter: noopInvocation,
    logger: {
      info: () => {},
      warn: () => {},
      error: console.error,
    },
    serverUrl: `http://127.0.0.1:${TEST_PORT}`,
  };

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

  it('GET /api/board/bootstrap-cards returns card definitions', async () => {
    const res = await fetch(`${API_BASE}/bootstrap-cards`);
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

  it('POST /api/board/cards/:id/actions with chat-send', async () => {
    const statusRes = await fetch(`${API_BASE}/board-status`);
    const statusData = await statusRes.json() as Record<string, unknown>;
    const cards = statusData.cardDefinitions as Array<Record<string, unknown>>;
    const cardId = cards[0].id as string;

    const res = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/actions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actionType: 'chat-send',
        payload: { text: 'hello from integration test' },
      }),
    });
    expect(res.ok).toBe(true);

    // Verify chat records
    const chatsRes = await fetch(`${API_BASE}/cards/${encodeURIComponent(cardId)}/chats`);
    expect(chatsRes.ok).toBe(true);
    const chatsData = await chatsRes.json() as Record<string, unknown>;
    expect(chatsData).toHaveProperty('ok', true);
    const messages = (chatsData as any).messages as Array<Record<string, unknown>>;
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some(m => typeof m.text === 'string' && m.text.includes('hello from integration test'))).toBe(true);
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
  });

  it('GET /api/board/sse returns event-stream', async () => {
    const controller = new AbortController();
    const res = await fetch(`${API_BASE}/sse`, { signal: controller.signal });
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
});
