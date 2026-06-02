import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  createMultiBoardServerRuntime as createMcpOnlyMultiBoardRuntime,
  createSingleBoardServerRuntime as createMcpOnlySingleBoardRuntime,
} from '../../src/server-runtime-controlface/index.js';
import {
  createSingleBoardServerRuntime as createBrowserSingleBoardRuntime,
} from '../../src/server-runtime-controlface/browser.js';
import type { RuntimeRequest, RuntimeResponse, SingleBoardRuntimeOptions } from '../../src/server-runtime/types.js';
import { createFsBoardPlatformAdapter } from '../../src/cli/node/fs-board-adapter.js';
import { parseRef, serializeRef } from '../../src/cli/common/storage-interface.js';

function makeRequest(method: string, url: string, body?: unknown): RuntimeRequest {
  const bodyBuf = body === undefined
    ? Buffer.alloc(0)
    : typeof body === 'string'
      ? Buffer.from(body, 'utf-8')
      : Buffer.isBuffer(body)
        ? body
        : body instanceof Uint8Array
          ? Buffer.from(body)
          : Buffer.from(JSON.stringify(body), 'utf-8');
  let done = false;
  return {
    method,
    url,
    headers: { 'content-type': 'application/json' },
    on(_event: string, _listener: (...args: unknown[]) => void): void {},
    [Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
      return {
        next() {
          if (done) return Promise.resolve({ value: undefined as never, done: true });
          done = true;
          return Promise.resolve({ value: bodyBuf, done: false });
        },
        return() { return Promise.resolve({ value: undefined as never, done: true }); },
        throw(error: unknown) { return Promise.reject(error); },
        [Symbol.asyncIterator]() { return this; },
      };
    },
  };
}

function makeResponse(): RuntimeResponse & { _status: number; _body: string; _headers: Record<string, string | number> } {
  const toText = (data: string | Buffer) => typeof data === 'string' ? data : data.toString('utf-8');
  const res = {
    _status: 0,
    _body: '',
    _headers: {} as Record<string, string | number>,
    writeHead(statusCode: number, headers?: Record<string, string | number>) {
      res._status = statusCode;
      if (headers) Object.assign(res._headers, headers);
    },
    write(data: string | Buffer) {
      res._body += toText(data);
      return true;
    },
    end(data?: string | Buffer) {
      if (data) res._body += toText(data);
    },
  };
  return res;
}

function parseJsonBody(res: { _body: string }): unknown {
  return JSON.parse(res._body);
}

describe('server-runtime-controlface surface split', () => {
  let testRoot = '';

  afterEach(() => {
    if (testRoot) {
      fs.rmSync(testRoot, { recursive: true, force: true });
      testRoot = '';
    }
  });

  function createRuntimeOptions(overrides: Partial<SingleBoardRuntimeOptions> = {}): SingleBoardRuntimeOptions {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-controlface-surface-'));
    const boardDir = path.join(testRoot, 'board');
    const cardStoreDir = path.join(testRoot, 'card-store');
    const outputsDir = path.join(testRoot, 'outputs');
    const filesDir = path.join(testRoot, 'files');
    fs.mkdirSync(boardDir, { recursive: true });
    fs.mkdirSync(cardStoreDir, { recursive: true });
    fs.mkdirSync(outputsDir, { recursive: true });
    fs.mkdirSync(filesDir, { recursive: true });

    const baseRef = parseRef(serializeRef({ kind: 'fs-path', value: boardDir }));
    const boardAdapter = createFsBoardPlatformAdapter(baseRef, testRoot, { suppressSpawn: true, onWarn: () => {} } as any);
    const artifactsAdapter = createFsBoardPlatformAdapter(parseRef(serializeRef({ kind: 'fs-path', value: filesDir })), testRoot, { suppressSpawn: true, onWarn: () => {} } as any);

    return {
      apiBasePath: '/api/board',
      boardId: 'mcp-test-board',
      boards: [{
        label: 'base',
        boardAdapter,
        artifactsAdapter,
        baseRef,
        cardStoreRef: serializeRef({ kind: 'fs-path', value: cardStoreDir }),
        outputsStoreRef: serializeRef({ kind: 'fs-path', value: outputsDir }),
        artifactsStoreRef: serializeRef({ kind: 'fs-path', value: filesDir }),
      }],
      invocationAdapter: {
        async invoke() { return { dispatched: true }; },
        async describe() { return null; },
      },
      logger: { info() {}, warn() {}, error() {} },
      serverUrl: 'http://example.test',
      ...overrides,
    };
  }

  function seedCard(runtime: { cardStore: { set(input: { body: unknown }): unknown } }, id = 'card-1') {
    const seedResult = runtime.cardStore.set({
      body: {
        id,
        card_data: { title: 'Card One' },
        view: { elements: [{ id: 'title', kind: 'text', data: { bind: 'card_data.title' } }] },
      },
    }) as { status?: string };
    expect(seedResult.status).toBe('success');
  }

  it('package controlface runtime handles only /mcp* routes', async () => {
    const runtime = createMcpOnlySingleBoardRuntime(createRuntimeOptions());
    seedCard(runtime);

    const boardStatusRes = makeResponse();
    const boardStatusHandled = await runtime.handleRuntimeApi(
      makeRequest('GET', '/api/board/board-status'),
      boardStatusRes,
      new URL('http://example.test/api/board/board-status'),
    );
    expect(boardStatusHandled).toBe(false);

    const sseRes = makeResponse();
    const sseHandled = await runtime.handleRuntimeApi(
      makeRequest('GET', '/api/board/sse?clientId=test-client'),
      sseRes,
      new URL('http://example.test/api/board/sse?clientId=test-client'),
    );
    expect(sseHandled).toBe(false);

    const controlplaneRes = makeResponse();
    const controlplaneHandled = await runtime.handleRuntimeApi(
      makeRequest('POST', '/api/board/mcp-controlplane', { tool: 'list-runtime-cards', args: { board_id: 'mcp-test-board' } }),
      controlplaneRes,
      new URL('http://example.test/api/board/mcp-controlplane'),
    );
    expect(controlplaneHandled).toBe(true);
    expect(controlplaneRes._status).toBe(200);
    expect(JSON.stringify(parseJsonBody(controlplaneRes))).toContain('card-1');
  });

  it('package controlface multi-board runtime handles only board-scoped /mcp* routes', async () => {
    const runtime = createMcpOnlyMultiBoardRuntime({
      apiBasePath: '/api/boards',
      serverMetaStore: {
        getText() { return null; },
        putText() {},
      },
      boardRuntimeFactory() {
        const single = createMcpOnlySingleBoardRuntime(createRuntimeOptions({
          apiBasePath: '/api/boards/default',
          boardId: 'default',
        }));
        seedCard(single, 'card-multi');
        return single;
      },
    });

    const registryRes = makeResponse();
    const registryHandled = await runtime.handleApi(
      makeRequest('GET', '/api/boards'),
      registryRes,
      new URL('http://example.test/api/boards'),
    );
    expect(registryHandled).toBe(false);

    const controlplaneRes = makeResponse();
    const controlplaneHandled = await runtime.handleApi(
      makeRequest('POST', '/api/boards/default/mcp-controlplane', { tool: 'list-runtime-cards', args: { board_id: 'default' } }),
      controlplaneRes,
      new URL('http://example.test/api/boards/default/mcp-controlplane'),
    );
    expect(controlplaneHandled).toBe(true);
    expect(controlplaneRes._status).toBe(200);
    expect(JSON.stringify(parseJsonBody(controlplaneRes))).toContain('card-multi');
  });

  it('browser controlface runtime keeps the full dispatcher including board-status and sse', async () => {
    const runtime = createBrowserSingleBoardRuntime(createRuntimeOptions());
    seedCard(runtime, 'card-browser');

    const boardStatusRes = makeResponse();
    const boardStatusHandled = await runtime.handleRuntimeApi(
      makeRequest('GET', '/api/board/board-status'),
      boardStatusRes,
      new URL('http://example.test/api/board/board-status'),
    );
    expect(boardStatusHandled).toBe(true);
    expect(boardStatusRes._status).toBe(200);
    expect(JSON.stringify(parseJsonBody(boardStatusRes))).toContain('card-browser');

    const sseRes = makeResponse();
    const sseHandled = await runtime.handleRuntimeApi(
      makeRequest('GET', '/api/board/sse?clientId=browser-client'),
      sseRes,
      new URL('http://example.test/api/board/sse?clientId=browser-client'),
    );
    expect(sseHandled).toBe(true);
    expect(sseRes._status).toBe(200);
    expect(String(sseRes._headers['Content-Type'] || '')).toContain('text/event-stream');
  });
});