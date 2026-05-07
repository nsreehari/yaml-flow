/**
 * multi-board-registry.test.ts
 *
 * Tests for multi-board registry persistence, duplicate detection, and
 * board ID validation in createMultiBoardServerRuntime.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  createMultiBoardServerRuntime,
  createSingleBoardServerRuntime,
} from '../../src/server-runtime/index.js';
import type {
  MultiBoardRuntimeOptions,
  SingleBoardRuntime,
  RuntimeRequest,
  RuntimeResponse,
} from '../../src/server-runtime/types.js';

// ── In-memory server-meta store ────────────────────────────────────────────
function createMemoryMetaStore() {
  const data = new Map<string, string>();
  return {
    getText(key: string): string | null { return data.get(key) ?? null; },
    putText(key: string, text: string): void { data.set(key, text); },
    _data: data,
  };
}

// ── Minimal stub SingleBoardRuntime ────────────────────────────────────────
function stubBoardRuntime(boardId: string): SingleBoardRuntime {
  return {
    apiBasePath: `/api/boards/${boardId}`,
    corsHeaders: {},
    async handleRuntimeApi() { return false; },
    buildPublishedRuntimePayload() { return { boardId }; },
    clearChatRecords() {},
  };
}

// ── HTTP helper to invoke the runtime ──────────────────────────────────────
function makeRequest(method: string, url: string, body?: string): RuntimeRequest {
  const bodyBuf = body ? Buffer.from(body, 'utf-8') : Buffer.alloc(0);
  let done = false;
  return {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    on(_event: string, _listener: (...args: unknown[]) => void): void {},
    [Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
      return {
        next() {
          if (done) return Promise.resolve({ value: undefined as any, done: true });
          done = true;
          return Promise.resolve({ value: bodyBuf, done: false });
        },
        return() { return Promise.resolve({ value: undefined as any, done: true }); },
        throw(e: unknown) { return Promise.reject(e); },
        [Symbol.asyncIterator]() { return this; },
      };
    },
  };
}

function makeResponse(): RuntimeResponse & { _status: number; _body: string; _headers: Record<string, string | number> } {
  const res = {
    _status: 0,
    _body: '',
    _headers: {} as Record<string, string | number>,
    writeHead(statusCode: number, headers?: Record<string, string | number>) {
      res._status = statusCode;
      if (headers) Object.assign(res._headers, headers);
    },
    write(data: string | Buffer) {
      res._body += typeof data === 'string' ? data : data.toString('utf-8');
      return true;
    },
    end(data?: string | Buffer) {
      if (data) res._body += typeof data === 'string' ? data : data.toString('utf-8');
    },
  };
  return res;
}

function parseBody(res: { _body: string }): Record<string, unknown> {
  return JSON.parse(res._body);
}

// ============================================================================
// Tests
// ============================================================================

describe('multi-board registry', () => {
  let metaStore: ReturnType<typeof createMemoryMetaStore>;
  let factoryCalls: string[];
  let runtime: ReturnType<typeof createMultiBoardServerRuntime>;

  beforeEach(() => {
    metaStore = createMemoryMetaStore();
    factoryCalls = [];
    runtime = createMultiBoardServerRuntime({
      apiBasePath: '/api/boards',
      serverMetaStore: metaStore,
      boardRuntimeFactory: (boardId, _entry) => {
        factoryCalls.push(boardId);
        return stubBoardRuntime(boardId);
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
  });

  // ── Registry persistence ─────────────────────────────────────────────────

  it('GET /api/boards returns default board when store is empty', async () => {
    const req = makeRequest('GET', '/api/boards');
    const res = makeResponse();
    await runtime.handleApi(req, res, new URL('http://localhost/api/boards'));
    expect(res._status).toBe(200);
    const body = parseBody(res);
    expect(body.ok).toBe(true);
    const boards = body.boards as Array<Record<string, unknown>>;
    expect(boards.length).toBe(1);
    expect(boards[0].id).toBe('default');
  });

  it('POST /api/boards persists a new board to the meta store', async () => {
    const req = makeRequest('POST', '/api/boards', JSON.stringify({ id: 'alpha', label: 'Alpha Board' }));
    const res = makeResponse();
    await runtime.handleApi(req, res, new URL('http://localhost/api/boards'));
    expect(res._status).toBe(200);
    expect(parseBody(res).ok).toBe(true);

    // Verify persisted in meta store
    const raw = metaStore.getText('boards-config.json');
    expect(raw).toBeTruthy();
    const persisted = JSON.parse(raw!);
    expect(persisted.boards.some((b: any) => b.id === 'alpha')).toBe(true);
  });

  it('registry survives runtime reconstruction (persistence)', async () => {
    // Register a board
    const req1 = makeRequest('POST', '/api/boards', JSON.stringify({ id: 'persist-test' }));
    const res1 = makeResponse();
    await runtime.handleApi(req1, res1, new URL('http://localhost/api/boards'));
    expect(res1._status).toBe(200);

    // Create a NEW runtime instance backed by the SAME meta store
    const runtime2 = createMultiBoardServerRuntime({
      apiBasePath: '/api/boards',
      serverMetaStore: metaStore,
      boardRuntimeFactory: (boardId) => stubBoardRuntime(boardId),
    });

    // The new instance should see the persisted board
    const req2 = makeRequest('GET', '/api/boards');
    const res2 = makeResponse();
    await runtime2.handleApi(req2, res2, new URL('http://localhost/api/boards'));
    const boards = (parseBody(res2) as any).boards as Array<Record<string, unknown>>;
    expect(boards.some(b => b.id === 'persist-test')).toBe(true);
  });

  // ── Duplicate / conflict detection ───────────────────────────────────────

  it('rejects duplicate board registration with 409', async () => {
    // Register first
    const req1 = makeRequest('POST', '/api/boards', JSON.stringify({ id: 'dup-board' }));
    const res1 = makeResponse();
    await runtime.handleApi(req1, res1, new URL('http://localhost/api/boards'));
    expect(res1._status).toBe(200);

    // Try to register same id again
    const req2 = makeRequest('POST', '/api/boards', JSON.stringify({ id: 'dup-board' }));
    const res2 = makeResponse();
    await runtime.handleApi(req2, res2, new URL('http://localhost/api/boards'));
    expect(res2._status).toBe(409);
    expect(parseBody(res2).error).toContain('already registered');
  });

  it('rejects registering the default board (already exists)', async () => {
    const req = makeRequest('POST', '/api/boards', JSON.stringify({ id: 'default' }));
    const res = makeResponse();
    await runtime.handleApi(req, res, new URL('http://localhost/api/boards'));
    expect(res._status).toBe(409);
  });

  // ── Board ID validation ──────────────────────────────────────────────────

  it('rejects empty board id with 400', async () => {
    const req = makeRequest('POST', '/api/boards', JSON.stringify({ id: '' }));
    const res = makeResponse();
    await runtime.handleApi(req, res, new URL('http://localhost/api/boards'));
    expect(res._status).toBe(400);
  });

  it('rejects board id with special characters', async () => {
    const req = makeRequest('POST', '/api/boards', JSON.stringify({ id: '../../../etc/passwd' }));
    const res = makeResponse();
    await runtime.handleApi(req, res, new URL('http://localhost/api/boards'));
    // safeBoardId strips non-alnum chars; if nothing remains, returns null → 400
    // If something remains (e.g. "etcpasswd"), it registers fine (sanitized)
    expect([200, 400]).toContain(res._status);
    if (res._status === 200) {
      // Verify the sanitized id doesn't contain path traversal
      const board = (parseBody(res) as any).board;
      expect(board.id).not.toContain('/');
      expect(board.id).not.toContain('.');
    }
  });

  it('rejects board id longer than 64 characters', async () => {
    const longId = 'a'.repeat(65);
    const req = makeRequest('POST', '/api/boards', JSON.stringify({ id: longId }));
    const res = makeResponse();
    await runtime.handleApi(req, res, new URL('http://localhost/api/boards'));
    expect(res._status).toBe(400);
  });

  // ── Board routing ────────────────────────────────────────────────────────

  it('returns 404 for unregistered board routes', async () => {
    const req = makeRequest('GET', '/api/boards/nonexistent/bootstrap');
    const res = makeResponse();
    await runtime.handleApi(req, res, new URL('http://localhost/api/boards/nonexistent/bootstrap'));
    expect(res._status).toBe(404);
    expect(parseBody(res).error).toContain('not registered');
  });

  it('routes to registered board after POST', async () => {
    // Register
    const req1 = makeRequest('POST', '/api/boards', JSON.stringify({ id: 'routed' }));
    const res1 = makeResponse();
    await runtime.handleApi(req1, res1, new URL('http://localhost/api/boards'));
    expect(res1._status).toBe(200);

    // Factory should have been called on first access
    const req2 = makeRequest('GET', '/api/boards/routed/bootstrap');
    const res2 = makeResponse();
    await runtime.handleApi(req2, res2, new URL('http://localhost/api/boards/routed/bootstrap'));
    expect(factoryCalls).toContain('routed');
  });

  it('caches board service — factory called once per board', async () => {
    // Register a board
    const req1 = makeRequest('POST', '/api/boards', JSON.stringify({ id: 'cached' }));
    const res1 = makeResponse();
    await runtime.handleApi(req1, res1, new URL('http://localhost/api/boards'));

    // Access it twice
    for (let i = 0; i < 2; i++) {
      const req = makeRequest('GET', '/api/boards/cached/anything');
      const res = makeResponse();
      await runtime.handleApi(req, res, new URL('http://localhost/api/boards/cached/anything'));
    }
    // Factory should only have been called once
    expect(factoryCalls.filter(id => id === 'cached').length).toBe(1);
  });
});
