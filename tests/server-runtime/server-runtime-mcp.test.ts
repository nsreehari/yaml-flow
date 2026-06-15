import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createSingleBoardServerRuntime } from '../../src/server-runtime/index.js';
import type { RuntimeRequest, RuntimeResponse, SingleBoardRuntime, SingleBoardRuntimeOptions } from '../../src/server-runtime/types.js';
import type { BoardWorkerRequest } from '../../src/cli/common/board-worker-store.js';
import { createBoardWorkerStore } from '../../src/cli/common/board-worker-store.js';
import { createFsBoardNonCorePlatformAdapter, createFsBoardPlatformAdapter } from '../../src/cli/node/fs-board-adapter.js';
import { createCardStorePublic } from '../../src/cli/common/card-store-lib-public.js';
import { createCardStore } from '../../src/cli/common/board-live-cards-lib.js';
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
  const toText = (data: string | Buffer) => {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf-8');
    return new TextDecoder().decode(data as unknown as Uint8Array);
  };
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

function parseSsePayload(res: { _body: string }): Record<string, unknown> {
  const jsonStr = res._body.split('data: ')[1]?.split('\n')[0];
  if (!jsonStr) throw new Error(`Missing SSE data frame: ${res._body}`);
  return JSON.parse(jsonStr) as Record<string, unknown>;
}

async function drainQueuedChatRequests(runtime: { handleChatAgentRequest(request: BoardWorkerRequest): Promise<void> | void }, boardAdapter: { queueStorageForRef(ref: string, lane: string): unknown }, queueStoreRef: string): Promise<void> {
  const workerStore = createBoardWorkerStore(boardAdapter.queueStorageForRef(queueStoreRef, 'chat-agent') as never);
  while (true) {
    const leases = workerStore.leaseRequests({ max: 20, visibilityMs: 60_000 });
    if (!leases.length) break;
    for (const lease of leases) {
      await runtime.handleChatAgentRequest(lease.request);
      workerStore.ackRequest(lease.messageId, lease.leaseToken);
    }
  }
}

function preloadCard(boardAdapter: ReturnType<typeof createFsBoardPlatformAdapter>, cardStoreRef: string, filesDir: string): void {
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

  fs.mkdirSync(path.join(filesDir, 'card-1'), { recursive: true });
  fs.writeFileSync(path.join(filesDir, 'card-1', 'hello.txt'), 'hello', 'utf8');
  const seedResult = preloadStore.set({
    body: {
      id: 'card-1',
      card_data: {
        title: 'Card One',
        files: [{ name: 'hello.txt', stored_name: 'hello.txt', mime_type: 'text/plain', size: 5, uploaded_at: '2026-05-28T00:00:00.000Z' }],
      },
    },
  });
  expect(seedResult.status).toBe('success');
}

async function drainProcessAccumulated(runtime: SingleBoardRuntime): Promise<{ status: string }> {
  return (runtime as SingleBoardRuntime & { __drainProcessAccumulatedLane(): Promise<{ status: string }> }).__drainProcessAccumulatedLane();
}

describe('server runtime MCP endpoint', () => {
  let testRoot = '';

  afterEach(() => {
    if (testRoot) {
      fs.rmSync(testRoot, { recursive: true, force: true });
      testRoot = '';
    }
  });

  function createRuntime(opts: {
    withNonCore?: boolean;
    chatHandlerFlow?: unknown;
    chatFlowRunner?: SingleBoardRuntimeOptions['chatFlowRunner'];
    onChannelSubscribed?: SingleBoardRuntimeOptions['onChannelSubscribed'];
    onChannelUnsubscribed?: SingleBoardRuntimeOptions['onChannelUnsubscribed'];
  } = {}) {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-mcp-'));
    const boardDir = path.join(testRoot, 'board');
    const boardRuntimeDir = path.join(testRoot, '.board-runtime');
    const queueStoreDir = path.join(testRoot, '.board-queue');
    const cardStoreDir = path.join(testRoot, 'card-store');
    const outputsDir = path.join(testRoot, 'outputs');
    const filesDir = path.join(testRoot, 'files');
    const chatDir = path.join(testRoot, 'chat');
    const scratchDir = path.join(testRoot, 'scratch');
    const archiveDir = path.join(testRoot, 'archive');
    const sourcesDir = path.join(testRoot, 'sources');
    fs.mkdirSync(boardDir, { recursive: true });
    fs.mkdirSync(boardRuntimeDir, { recursive: true });
    fs.mkdirSync(queueStoreDir, { recursive: true });
    fs.mkdirSync(cardStoreDir, { recursive: true });
    fs.mkdirSync(outputsDir, { recursive: true });
    fs.mkdirSync(filesDir, { recursive: true });
    fs.mkdirSync(chatDir, { recursive: true });
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(sourcesDir, { recursive: true });

    let executorPath = '';
    if (opts.withNonCore) {
      executorPath = path.join(testRoot, 'fake-task-executor.mjs');
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
  await import('node:fs/promises').then((fs) => fs.writeFile(refValue, JSON.stringify({ ok: true })));
  process.exit(0);
}
if (subcommand === 'validate-source-def') {
  console.log(JSON.stringify({ ok: true, errors: [] }));
  process.exit(0);
}
console.error('unsupported subcommand: ' + subcommand);
process.exit(1);
`, 'utf-8');
    }

    const baseRef = parseRef(serializeRef({ kind: 'fs-path', value: boardDir }));
    const boardAdapter = createFsBoardPlatformAdapter(baseRef, testRoot, { suppressSpawn: true, onWarn: () => {} });
    const nonCoreAdapter = opts.withNonCore
      ? createFsBoardNonCorePlatformAdapter(baseRef, testRoot, { onWarn: () => {} })
      : undefined;
    const cardStoreRef = serializeRef({ kind: 'fs-path', value: cardStoreDir });
    const runtimeOptions: SingleBoardRuntimeOptions = {
      apiBasePath: '/api/board',
      boardId: 'mcp-test-board',
      boards: [{
        label: 'base',
        boardAdapter,
        ...(nonCoreAdapter ? { nonCoreAdapter } : {}),
        baseRef,
        boardRuntimeStoreRef: serializeRef({ kind: 'fs-path', value: boardRuntimeDir }),
        queueStoreRef: serializeRef({ kind: 'fs-path', value: queueStoreDir }),
        cardStoreRef,
        outputsStoreRef: serializeRef({ kind: 'fs-path', value: outputsDir }),
        chatStoreRef: serializeRef({ kind: 'fs-path', value: chatDir }),
        artifactsStoreRef: serializeRef({ kind: 'fs-path', value: filesDir }),
        fetchedSourcesStoreRef: serializeRef({ kind: 'fs-path', value: sourcesDir }),
        scratchStoreRef: serializeRef({ kind: 'fs-path', value: scratchDir }),
        ...(opts.chatHandlerFlow !== undefined ? { chatHandlerFlow: opts.chatHandlerFlow } : {}),
        ...(executorPath ? {
          taskExecutorRef: {
            howToRun: 'local-node',
            whatToRun: serializeRef({ kind: 'fs-path', value: executorPath }),
          },
        } : {}),
      }],
      invocationAdapter: {
        async invoke() { return { dispatched: true }; },
        async describe() { return null; },
      },
      ...(opts.chatFlowRunner ? { chatFlowRunner: opts.chatFlowRunner } : {}),
      ...(opts.onChannelSubscribed ? { onChannelSubscribed: opts.onChannelSubscribed } : {}),
      ...(opts.onChannelUnsubscribed ? { onChannelUnsubscribed: opts.onChannelUnsubscribed } : {}),
      logger: { info() {}, warn() {}, error() {} },
      serverUrl: 'http://example.test',
    };

    const runtime = createSingleBoardServerRuntime(runtimeOptions);
    preloadCard(boardAdapter, cardStoreRef, filesDir);
    return runtime;
  }

  function createRuntimeHarness(opts: { withNonCore?: boolean; chatHandlerFlow?: unknown; chatFlowRunner?: SingleBoardRuntimeOptions['chatFlowRunner'] } = {}) {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-mcp-'));
    const boardDir = path.join(testRoot, 'board');
    const boardRuntimeDir = path.join(testRoot, '.board-runtime');
    const queueStoreDir = path.join(testRoot, '.board-queue');
    const cardStoreDir = path.join(testRoot, 'card-store');
    const outputsDir = path.join(testRoot, 'outputs');
    const filesDir = path.join(testRoot, 'files');
    const chatDir = path.join(testRoot, 'chat');
    const scratchDir = path.join(testRoot, 'scratch');
    const archiveDir = path.join(testRoot, 'archive');
    const sourcesDir = path.join(testRoot, 'sources');
    fs.mkdirSync(boardDir, { recursive: true });
    fs.mkdirSync(boardRuntimeDir, { recursive: true });
    fs.mkdirSync(queueStoreDir, { recursive: true });
    fs.mkdirSync(cardStoreDir, { recursive: true });
    fs.mkdirSync(outputsDir, { recursive: true });
    fs.mkdirSync(filesDir, { recursive: true });
    fs.mkdirSync(chatDir, { recursive: true });
    fs.mkdirSync(scratchDir, { recursive: true });
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.mkdirSync(sourcesDir, { recursive: true });

    let executorPath = '';
    if (opts.withNonCore) {
      executorPath = path.join(testRoot, 'fake-task-executor.mjs');
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
  await import('node:fs/promises').then((fs) => fs.writeFile(refValue, JSON.stringify({ ok: true })));
  process.exit(0);
}
if (subcommand === 'validate-source-def') {
  console.log(JSON.stringify({ ok: true, errors: [] }));
  process.exit(0);
}
console.error('unsupported subcommand: ' + subcommand);
process.exit(1);
`, 'utf-8');
    }

    const baseRef = parseRef(serializeRef({ kind: 'fs-path', value: boardDir }));
    const boardAdapter = createFsBoardPlatformAdapter(baseRef, testRoot, { suppressSpawn: true, onWarn: () => {} });
    const nonCoreAdapter = opts.withNonCore
      ? createFsBoardNonCorePlatformAdapter(baseRef, testRoot, { onWarn: () => {} })
      : undefined;
    const cardStoreRef = serializeRef({ kind: 'fs-path', value: cardStoreDir });
    const runtimeOptions: SingleBoardRuntimeOptions = {
      apiBasePath: '/api/board',
      boardId: 'mcp-test-board',
      boards: [{
        label: 'base',
        boardAdapter,
        ...(nonCoreAdapter ? { nonCoreAdapter } : {}),
        baseRef,
        boardRuntimeStoreRef: serializeRef({ kind: 'fs-path', value: boardRuntimeDir }),
        queueStoreRef: serializeRef({ kind: 'fs-path', value: queueStoreDir }),
        cardStoreRef,
        outputsStoreRef: serializeRef({ kind: 'fs-path', value: outputsDir }),
        chatStoreRef: serializeRef({ kind: 'fs-path', value: chatDir }),
        artifactsStoreRef: serializeRef({ kind: 'fs-path', value: filesDir }),
        fetchedSourcesStoreRef: serializeRef({ kind: 'fs-path', value: sourcesDir }),
        scratchStoreRef: serializeRef({ kind: 'fs-path', value: scratchDir }),
        ...(opts.chatHandlerFlow !== undefined ? { chatHandlerFlow: opts.chatHandlerFlow } : {}),
        ...(executorPath ? {
          taskExecutorRef: {
            howToRun: 'local-node',
            whatToRun: serializeRef({ kind: 'fs-path', value: executorPath }),
          },
        } : {}),
      }],
      invocationAdapter: {
        async invoke() { return { dispatched: true }; },
        async describe() { return null; },
      },
      ...(opts.chatFlowRunner ? { chatFlowRunner: opts.chatFlowRunner } : {}),
      logger: { info() {}, warn() {}, error() {} },
      serverUrl: 'http://example.test',
    };

    const runtime = createSingleBoardServerRuntime(runtimeOptions);
    preloadCard(boardAdapter, cardStoreRef, filesDir);
    return { runtime, boardAdapter, queueStoreRef: serializeRef({ kind: 'fs-path', value: queueStoreDir }), cardStoreRef, filesDir };
  }

  it('routes manage.read-card through /mcp and returns the wrapper array shape', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp', { tool: 'manage.read-card', args: { card_id: 'card-1' } });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: [
        expect.objectContaining({ id: 'card-1', card_data: expect.objectContaining({ title: 'Card One' }) }),
      ],
    });
  });

  it('keeps card meta behind /mcp-controlplane and redacts it from regular /mcp card reads', async () => {
    const runtime = createRuntime();

    const setMetaRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'setstate.card-private',
      args: { board_id: 'mcp-test-board', card_id: 'card-1', key: 'chat.foundry_thread_id', value: 'thread-123' },
    }), setMetaRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(setMetaRes._status).toBe(200);
    expect(parseJsonBody(setMetaRes)).toEqual({
      status: 'success',
      data: { boardId: 'mcp-test-board', cardId: 'card-1', key: 'chat.foundry_thread_id' },
    });

    const getMetaRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'getstate.card-private',
      args: { board_id: 'mcp-test-board', card_id: 'card-1', key: 'chat.foundry_thread_id' },
    }), getMetaRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(getMetaRes._status).toBe(200);
    expect(parseJsonBody(getMetaRes)).toEqual({
      status: 'success',
      data: { boardId: 'mcp-test-board', cardId: 'card-1', key: 'chat.foundry_thread_id', exists: true, value: 'thread-123' },
    });

    const readRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'manage.read-card',
      args: { card_id: 'card-1' },
    }), readRes, new URL('http://example.test/api/board/mcp'));
    expect(readRes._status).toBe(200);
    const readBody = parseJsonBody(readRes) as Record<string, unknown>;
    const readCards = readBody.data as Array<Record<string, unknown>>;
    expect(readCards[0].__private).toBeUndefined();

    const directCardRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.admin-read-card',
      args: { board_id: 'mcp-test-board', card_id: 'card-1' },
    }), directCardRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(directCardRes._status).toBe(200);
    const directCardBody = parseJsonBody(directCardRes) as Record<string, unknown>;
    const directCard = ((directCardBody.data as Record<string, unknown>)?.cards as Array<Record<string, unknown>>)?.[0];
    expect(directCard?.__private).toEqual({ chat: { foundry_thread_id: 'thread-123' } });
  });

  it('preserves __private on regular /mcp upsert-card and passes meta through unchanged', async () => {
    const runtime = createRuntime({ withNonCore: true });

    const setMetaRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'setstate.card-private',
      args: { board_id: 'mcp-test-board', card_id: 'card-1', key: 'chat.foundry_thread_id', value: 'thread-original' },
    }), setMetaRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(setMetaRes._status).toBe(200);

    const upsertRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'manage.upsert-card',
      args: {
        card_id: 'card-1',
        candidate_card_content: {
          id: 'card-1',
          meta: { chat: { foundry_thread_id: 'thread-from-caller' }, title: 'caller title' },
          card_data: { title: 'Updated Card One' },
          view: { elements: [{ id: 'title', kind: 'text', data: { bind: 'card_data.title' } }] },
        },
      },
    }), upsertRes, new URL('http://example.test/api/board/mcp'));
    expect(upsertRes._status).toBe(200);
    expect((parseJsonBody(upsertRes) as Record<string, unknown>).status).toBe('success');
    expect((await drainProcessAccumulated(runtime)).status).toBe('success');

    const directCardRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.admin-read-card',
      args: { board_id: 'mcp-test-board', card_id: 'card-1' },
    }), directCardRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(directCardRes._status).toBe(200);
    const directCardBody = parseJsonBody(directCardRes) as Record<string, unknown>;
    const directCard = ((directCardBody.data as Record<string, unknown>)?.cards as Array<Record<string, unknown>>)?.[0];
    expect((directCard?.card_data as Record<string, unknown>).title).toBe('Updated Card One');
    expect(directCard?.__private).toEqual({ chat: { foundry_thread_id: 'thread-original' } });
    expect(directCard?.meta).toEqual({ chat: { foundry_thread_id: 'thread-from-caller' }, title: 'caller title' });

    const inspectRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'inspect.card-definition-and-runtime',
      args: { card_id: 'card-1' },
    }), inspectRes, new URL('http://example.test/api/board/mcp'));
    expect(inspectRes._status).toBe(200);
    const inspectBody = parseJsonBody(inspectRes) as Record<string, unknown>;
    const inspectData = inspectBody.data as Record<string, unknown>;
    expect((inspectData.card_definition_and_static_data as Record<string, unknown>).__private).toBeUndefined();
  });

  it('rejects manage.upsert-card validation failures on /mcp with a 400 error payload', async () => {
    const runtime = createRuntime({ withNonCore: true });
    const req = makeRequest('POST', '/api/board/mcp', {
      tool: 'manage.upsert-card',
      args: {
        card_id: 'card-1',
        candidate_card_content: { id: 'card-1', card_data: {}, view: { elements: [{ id: 'broken' }] } },
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp'));
    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(parseJsonBody(res)).toEqual({ error: "Validation failed: /view/elements/0: must have required property 'kind'" });
  });

  it('routes manage.add-chat-attachment through /mcp-controlplane, appends metadata, and emits a chat system message with turn', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.add-chat-attachment',
      args: {
        board_id: 'mcp-test-board',
        card_id: 'card-1',
        turn_id: 'turn-upload',
        file_name: 'upload.txt',
        content_type: 'text/plain',
        text: 'hello upload',
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: expect.objectContaining({
        cardId: 'card-1',
        turn: 'turn-upload',
        files: [expect.objectContaining({ name: 'upload.txt', mime_type: 'text/plain', size: 12, chat: true })],
      }),
    });

    const cardRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'manage.read-card',
      args: { card_id: 'card-1' },
    }), cardRes, new URL('http://example.test/api/board/mcp'));
    expect(cardRes._status).toBe(200);
    const cardBody = parseJsonBody(cardRes) as Record<string, unknown>;
    const card = (cardBody.data as Array<Record<string, unknown>>)[0];
    const files = (card.card_data as Record<string, unknown>).files as Array<Record<string, unknown>>;
    expect(files.length).toBe(2);

    const chatsRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'inspect.chat-messages-on-cards',
      args: { card_id: 'card-1', turn_id: 'turn-upload' },
    }), chatsRes, new URL('http://example.test/api/board/mcp'));
    expect(chatsRes._status).toBe(200);
    const chatsBody = parseJsonBody(chatsRes) as Record<string, unknown>;
    const uploadSystemMessage = (((chatsBody.data as Record<string, unknown>).messages) as Array<Record<string, unknown>>)
      .find((message) => String(message.text || '').includes('file uploaded: upload.txt'));
    expect(uploadSystemMessage).toBeTruthy();
    expect(uploadSystemMessage?.turn).toBe('turn-upload');
  });

  it('chat-send propagates turn-id to the user message and flow args', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const { runtime, boardAdapter, queueStoreRef } = createRuntimeHarness({
      chatHandlerFlow: { id: 'test-flow' },
      chatFlowRunner: {
        async run(_flow, args) {
          observed.push(args);
          return { dispatched: true };
        },
      },
    });

    const req = makeRequest('POST', '/api/board/mcp-actions', {
      tool: 'chat-send',
      args: {
        card_id: 'card-1',
        payload: {
          text: 'Hello turn aware world',
          'turn-id': 'turn-chat-send',
        },
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-actions'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    await drainQueuedChatRequests(runtime, boardAdapter, queueStoreRef);

    const chatsRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'inspect.chat-messages-on-cards',
      args: { card_id: 'card-1', all_turns: true },
    }), chatsRes, new URL('http://example.test/api/board/mcp'));
    expect(chatsRes._status).toBe(200);
    const chatsBody = parseJsonBody(chatsRes) as Record<string, unknown>;
    const userMessage = (((chatsBody.data as Record<string, unknown>).messages) as Array<Record<string, unknown>>)
      .find((message) => message.role === 'user' && message.text === 'Hello turn aware world');
    expect(userMessage).toBeTruthy();
    expect(userMessage?.turn).toBe('turn-chat-send');
    expect(observed.length).toBe(1);
    expect(observed[0].turnId).toBe('turn-chat-send');
    expect(observed[0].probe).toBeUndefined();
  });

    it('chat-send stamps probe in flow args when probe markers wrap the user text', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const { runtime, boardAdapter, queueStoreRef } = createRuntimeHarness({
      chatHandlerFlow: { id: 'test-flow' },
      chatFlowRunner: {
        async run(_flow, args) {
          observed.push(args);
          return { dispatched: true };
        },
      },
    });

    const req = makeRequest('POST', '/api/board/mcp-actions', {
      tool: 'chat-send',
      args: {
        card_id: 'card-1',
        payload: {
          text: '__probe__echo__probe__hello probe__probe__echo__probe__',
          'turn-id': 'turn-chat-probe',
        },
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-actions'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    await drainQueuedChatRequests(runtime, boardAdapter, queueStoreRef);

    expect(observed.length).toBe(1);
    expect(observed[0].turnId).toBe('turn-chat-probe');
    expect(observed[0].probe).toBe('echo');
  });

  it('chat-send stamps echoattach probe in flow args when echoattach probe markers wrap the user text', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const { runtime, boardAdapter, queueStoreRef } = createRuntimeHarness({
      chatHandlerFlow: { id: 'test-flow' },
      chatFlowRunner: {
        async run(_flow, args) {
          observed.push(args);
          return { dispatched: true };
        },
      },
    });

    const req = makeRequest('POST', '/api/board/mcp-actions', {
      tool: 'chat-send',
      args: {
        card_id: 'card-1',
        payload: {
          text: '__probe__echo__probe__echoattach__ hello attachment probe__probe__echo__probe__',
          'turn-id': 'turn-chat-echoattach-probe',
        },
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-actions'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    await drainQueuedChatRequests(runtime, boardAdapter, queueStoreRef);

    expect(observed.length).toBe(1);
    expect(observed[0].turnId).toBe('turn-chat-echoattach-probe');
    expect(observed[0].probe).toBe('echoattach');
  });

  it('POST /mcp-actions chat-send propagates turn-id to the user message and flow args', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const { runtime, boardAdapter, queueStoreRef } = createRuntimeHarness({
      chatHandlerFlow: { id: 'test-flow' },
      chatFlowRunner: {
        async run(_flow, args) {
          observed.push(args);
          return { dispatched: true };
        },
      },
    });

    const req = makeRequest('POST', '/api/board/mcp-actions', {
      tool: 'chat-send',
      args: {
        card_id: 'card-1',
        payload: {
          text: 'Hello mcp-actions world',
          'turn-id': 'turn-mcp-actions',
        },
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-actions'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: expect.objectContaining({ ok: true, cardId: 'card-1', actionType: 'chat-send', responseStatus: 200 }),
    });
    await drainQueuedChatRequests(runtime, boardAdapter, queueStoreRef);

    const chatsRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'inspect.chat-messages-on-cards',
      args: { card_id: 'card-1', all_turns: true },
    }), chatsRes, new URL('http://example.test/api/board/mcp'));
    expect(chatsRes._status).toBe(200);
    const chatsBody = parseJsonBody(chatsRes) as Record<string, unknown>;
    const userMessage = (((chatsBody.data as Record<string, unknown>).messages) as Array<Record<string, unknown>>)
      .find((message) => message.role === 'user' && message.text === 'Hello mcp-actions world');
    expect(userMessage).toBeTruthy();
    expect(userMessage?.turn).toBe('turn-mcp-actions');
    expect(observed.length).toBe(1);
    expect(observed[0].turnId).toBe('turn-mcp-actions');
  });

  it('POST /mcp-actions retrigger-card retriggers a card', async () => {
    const runtime = createRuntime();

    const req = makeRequest('POST', '/api/board/mcp-actions', {
      tool: 'retrigger-card',
      args: { card_id: 'card-1' },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-actions'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: expect.objectContaining({ ok: true, cardId: 'card-1', actionType: 'retrigger-card', responseStatus: 200 }),
    });
  });

  it('routes manage.add-chat-entry-and-any-attachments through /mcp-controlplane for assistant chat messages', async () => {
    const runtime = createRuntime();
    const postReq = makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.add-chat-entry-and-any-attachments',
      args: {
        board_id: 'mcp-test-board',
        card_id: 'card-1',
        role: 'assistant',
        turn_id: 'turn-post-chat',
        text: 'Turn aware assistant reply',
      },
    });
    const postRes = makeResponse();

    const handled = await runtime.handleRuntimeApi(postReq, postRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(handled).toBe(true);
    expect(postRes._status).toBe(200);

    const chatsRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'inspect.chat-messages-on-cards',
      args: { card_id: 'card-1', all_turns: true },
    }), chatsRes, new URL('http://example.test/api/board/mcp'));
    expect(chatsRes._status).toBe(200);
    const chatsBody = parseJsonBody(chatsRes) as Record<string, unknown>;
    const assistantMessage = (((chatsBody.data as Record<string, unknown>).messages) as Array<Record<string, unknown>>)
      .find((message) => message.role === 'assistant' && message.text === 'Turn aware assistant reply');
    expect(assistantMessage).toBeTruthy();
    expect(assistantMessage?.turn).toBe('turn-post-chat');
  });

  it('routes manage.upload-card-file through /mcp-controlplane and reuses upload behavior', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.upload-card-file',
      args: {
        board_id: 'mcp-test-board',
        card_id: 'card-1',
        file_name: 'tool-upload.txt',
        content_type: 'text/plain',
        text: 'hello from tool',
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: expect.objectContaining({
        ok: true,
        file: expect.objectContaining({ name: 'tool-upload.txt', mime_type: 'text/plain', size: 15 }),
      }),
    });

    const cardRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'manage.read-card',
      args: { card_id: 'card-1' },
    }), cardRes, new URL('http://example.test/api/board/mcp'));
    expect(cardRes._status).toBe(200);
    const cardBody = parseJsonBody(cardRes) as Record<string, unknown>;
    const card = (cardBody.data as Array<Record<string, unknown>>)[0];
    const files = (card.card_data as Record<string, unknown>).files as Array<Record<string, unknown>>;
    expect(files.length).toBe(2);

    const chatsRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'inspect.chat-messages-on-cards',
      args: { card_id: 'card-1', all_turns: true },
    }), chatsRes, new URL('http://example.test/api/board/mcp'));
    expect(chatsRes._status).toBe(200);
    const chatsBody = parseJsonBody(chatsRes) as Record<string, unknown>;
    expect((((chatsBody.data as Record<string, unknown>).messages) as Array<Record<string, unknown>>).some((message) => String(message.text || '').includes('file uploaded: tool-upload.txt'))).toBe(false);
  });

  it('routes manage.add-chat-attachment through /mcp-controlplane and appends only the chat attachment system message', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.add-chat-attachment',
      args: {
        board_id: 'mcp-test-board',
        card_id: 'card-1',
        turn_id: 'turn-chat-file',
        file_name: 'chat-upload.txt',
        content_type: 'text/plain',
        text: 'hello from chat tool',
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: expect.objectContaining({
        cardId: 'card-1',
        turn: 'turn-chat-file',
        files: [
          expect.objectContaining({ name: 'chat-upload.txt', mime_type: 'text/plain', size: 20, chat: true }),
        ],
      }),
    });

    const chatsRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'inspect.chat-messages-on-cards',
      args: { card_id: 'card-1', turn_id: 'turn-chat-file' },
    }), chatsRes, new URL('http://example.test/api/board/mcp'));
    expect(chatsRes._status).toBe(200);
    const chatsBody = parseJsonBody(chatsRes) as Record<string, unknown>;
    const messages = ((chatsBody.data as Record<string, unknown>).messages) as Array<Record<string, unknown>>;
    expect(messages.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(messages.filter((message) => message.role === 'user' || message.role === 'assistant')).toHaveLength(0);
    expect(messages[0]?.turn).toBe('turn-chat-file');
    expect(String(messages[0]?.text || '')).toContain('file uploaded: chat-upload.txt');
  });

  it('keeps the misspelled add-chat-attachement tool name as a compatibility alias', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.add-chat-attachement',
      args: {
        board_id: 'mcp-test-board',
        card_id: 'card-1',
        turn_id: 'turn-chat-file-compat',
        file_name: 'chat-upload-compat.txt',
        content_type: 'text/plain',
        text: 'hello from chat tool compat',
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect((parseJsonBody(res) as Record<string, unknown>).status).toBe('success');
  });

  it('rejects manage.upload-card-file on /mcp after it moves to /mcp-controlplane', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp', {
      tool: 'manage.upload-card-file',
      args: {
        board_id: 'mcp-test-board',
        card_id: 'card-1',
        file_name: 'tool-upload.txt',
        content_type: 'text/plain',
        text: 'hello from tool',
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp'));
    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(parseJsonBody(res)).toEqual({ error: 'Unknown MCP tool: manage.upload-card-file' });
  });

  it('routes setstate.chat-processing-started and done through /mcp-controlplane', async () => {
    const runtime = createRuntime();

    const startedRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'setstate.chat-processing-started',
      args: { board_id: 'mcp-test-board', card_id: 'card-1' },
    }), startedRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(startedRes._status).toBe(200);
    expect(parseJsonBody(startedRes)).toEqual({
      status: 'success',
      data: { boardId: 'mcp-test-board', cardId: 'card-1', active: true },
    });

    const getStartedRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'getstate.is-chat-processing',
      args: { board_id: 'mcp-test-board', card_id: 'card-1' },
    }), getStartedRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(getStartedRes._status).toBe(200);
    expect(parseJsonBody(getStartedRes)).toEqual({
      status: 'success',
      data: { boardId: 'mcp-test-board', cardId: 'card-1', active: true },
    });

    const initStartedRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('GET', '/api/board/sse?one-shot'), initStartedRes, new URL('http://example.test/api/board/sse?one-shot'));
    expect(initStartedRes._status).toBe(200);
    const initStartedBody = parseSsePayload(initStartedRes);
    expect(((initStartedBody.cardChatsByCardId as Record<string, unknown>)['card-1'] as Record<string, unknown>).processing).toBe(true);

    const doneRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'setstate.chat-processing-done',
      args: { board_id: 'mcp-test-board', card_id: 'card-1' },
    }), doneRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(doneRes._status).toBe(200);
    expect(parseJsonBody(doneRes)).toEqual({
      status: 'success',
      data: { boardId: 'mcp-test-board', cardId: 'card-1', active: false },
    });

    const getDoneRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'getstate.is-chat-processing',
      args: { board_id: 'mcp-test-board', card_id: 'card-1' },
    }), getDoneRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(getDoneRes._status).toBe(200);
    expect(parseJsonBody(getDoneRes)).toEqual({
      status: 'success',
      data: { boardId: 'mcp-test-board', cardId: 'card-1', active: false },
    });

    const initDoneRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('GET', '/api/board/sse?one-shot'), initDoneRes, new URL('http://example.test/api/board/sse?one-shot'));
    expect(initDoneRes._status).toBe(200);
    const initDoneBody = parseSsePayload(initDoneRes);
    const chatsByCardId = (initDoneBody.cardChatsByCardId as Record<string, unknown>) ?? {};
    expect((chatsByCardId['card-1'] as Record<string, unknown> | undefined)?.processing ?? false).toBe(false);
  });

  it('boots SSE chat state from the latest turn and preserves turn ids', async () => {
    const runtime = createRuntime();

    const addFirstRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.add-chat-entry-and-any-attachments',
      args: {
        board_id: 'mcp-test-board',
        card_id: 'card-1',
        role: 'user',
        text: 'first turn',
        turn_id: 'turn-1',
      },
    }), addFirstRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(addFirstRes._status).toBe(200);

    const addSecondRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.add-chat-entry-and-any-attachments',
      args: {
        board_id: 'mcp-test-board',
        card_id: 'card-1',
        role: 'user',
        text: 'second turn',
        turn_id: 'turn-2',
      },
    }), addSecondRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(addSecondRes._status).toBe(200);

    const inspectRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'inspect.chat-messages-on-cards',
      args: { card_id: 'card-1', all_turns: true },
    }), inspectRes, new URL('http://example.test/api/board/mcp'));
    expect(inspectRes._status).toBe(200);
    const inspectBody = parseJsonBody(inspectRes) as Record<string, unknown>;
    const inspectMessages = (((inspectBody.data as Record<string, unknown>).messages) as Array<Record<string, unknown>>);
    expect(inspectMessages.map((message) => message.turn)).toEqual(['turn-1', 'turn-2']);

    const initRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('GET', '/api/board/sse?one-shot'), initRes, new URL('http://example.test/api/board/sse?one-shot'));
    expect(initRes._status).toBe(200);
    const initBody = parseSsePayload(initRes);
    const messages = ((((initBody.cardChatsByCardId as Record<string, unknown>)['card-1'] as Record<string, unknown>).messages) as Array<Record<string, unknown>>);
    expect(messages).toEqual([
      expect.objectContaining({ role: 'user', text: 'second turn', turn: 'turn-2' }),
    ]);
  });

  it('reconnect SSE bootstrap keeps the latest turn only and preserves turn ids', async () => {
    const runtime = createRuntime();
    const clientId = 'mcp-sse-reconnect-client';

    const firstSseRes = makeResponse();
    const firstHandled = await runtime.handleRuntimeApi(
      makeRequest('GET', `/api/board/sse?clientId=${encodeURIComponent(clientId)}`),
      firstSseRes,
      new URL(`http://example.test/api/board/sse?clientId=${encodeURIComponent(clientId)}`),
    );
    expect(firstHandled).toBe(true);
    expect(firstSseRes._status).toBe(200);
    expect(parseSsePayload(firstSseRes)).toHaveProperty('cardDefinitions');

    const addFirstRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.add-chat-entry-and-any-attachments',
      args: {
        board_id: 'mcp-test-board',
        card_id: 'card-1',
        role: 'user',
        text: 'first reconnect turn',
        turn_id: 'turn-r1',
      },
    }), addFirstRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(addFirstRes._status).toBe(200);

    const addSecondRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.add-chat-entry-and-any-attachments',
      args: {
        board_id: 'mcp-test-board',
        card_id: 'card-1',
        role: 'user',
        text: 'second reconnect turn',
        turn_id: 'turn-r2',
      },
    }), addSecondRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(addSecondRes._status).toBe(200);

    const reconnectRes = makeResponse();
    const reconnectHandled = await runtime.handleRuntimeApi(
      makeRequest('GET', `/api/board/sse?clientId=${encodeURIComponent(clientId)}`),
      reconnectRes,
      new URL(`http://example.test/api/board/sse?clientId=${encodeURIComponent(clientId)}`),
    );
    expect(reconnectHandled).toBe(true);
    expect(reconnectRes._status).toBe(200);
    const reconnectBody = parseSsePayload(reconnectRes);
    const messages = ((((reconnectBody.cardChatsByCardId as Record<string, unknown>)['card-1'] as Record<string, unknown>).messages) as Array<Record<string, unknown>>);
    expect(messages).toEqual([
      expect.objectContaining({ role: 'user', text: 'second reconnect turn', turn: 'turn-r2' }),
    ]);
  });

  it('routes sse.subscribe-chat and sse.unsubscribe-chat through /mcp-controlplane', async () => {
    const runtime = createRuntime();
    const clientId = 'mcp-sse-chat-client';

    const sseRes = makeResponse();
    const sseHandled = await runtime.handleRuntimeApi(
      makeRequest('GET', `/api/board/sse?clientId=${encodeURIComponent(clientId)}`),
      sseRes,
      new URL(`http://example.test/api/board/sse?clientId=${encodeURIComponent(clientId)}`),
    );
    expect(sseHandled).toBe(true);
    expect(sseRes._status).toBe(200);
    expect(parseSsePayload(sseRes)).toHaveProperty('cardDefinitions');

    const subscribeRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'sse.subscribe-chat',
      args: { board_id: 'mcp-test-board', client_id: clientId, card_id: 'card-1' },
    }), subscribeRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(subscribeRes._status).toBe(200);
    expect(parseJsonBody(subscribeRes)).toEqual({
      status: 'success',
      data: { boardId: 'mcp-test-board', cardId: 'card-1', clientId, subscribed: true },
    });

    const unsubscribeRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'sse.unsubscribe-chat',
      args: { board_id: 'mcp-test-board', client_id: clientId, card_id: 'card-1' },
    }), unsubscribeRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(unsubscribeRes._status).toBe(200);
    expect(parseJsonBody(unsubscribeRes)).toEqual({
      status: 'success',
      data: { boardId: 'mcp-test-board', cardId: 'card-1', clientId, subscribed: false },
    });
  });

  it('routes sse.watch-channel and sse.unwatch-channel through /mcp-controlplane', async () => {
    const subscribed: Array<{ clientId: string; channelName: string; params: { cardId?: string } }> = [];
    const unsubscribed: Array<{ clientId: string; channelName: string; params: { cardId?: string } }> = [];
    const runtime = createRuntime({
      onChannelSubscribed(clientId, channelName, params) {
        subscribed.push({ clientId, channelName, params });
      },
      onChannelUnsubscribed(clientId, channelName, params) {
        unsubscribed.push({ clientId, channelName, params });
      },
    });
    const clientId = 'mcp-sse-watch-client';

    await runtime.handleRuntimeApi(
      makeRequest('GET', `/api/board/sse?clientId=${encodeURIComponent(clientId)}`),
      makeResponse(),
      new URL(`http://example.test/api/board/sse?clientId=${encodeURIComponent(clientId)}`),
    );

    const boardWatchRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'sse.watch-channel',
      args: { board_id: 'mcp-test-board', client_id: clientId, channel_name: 'watchparty' },
    }), boardWatchRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(boardWatchRes._status).toBe(200);
    expect(parseJsonBody(boardWatchRes)).toEqual({
      status: 'success',
      data: { boardId: 'mcp-test-board', clientId, channelName: 'watchparty', subscribed: true },
    });

    const cardWatchRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'sse.watch-channel',
      args: { board_id: 'mcp-test-board', client_id: clientId, channel_name: 'watchparty', card_id: 'card-1' },
    }), cardWatchRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(cardWatchRes._status).toBe(200);
    expect(parseJsonBody(cardWatchRes)).toEqual({
      status: 'success',
      data: { boardId: 'mcp-test-board', clientId, channelName: 'watchparty', cardId: 'card-1', subscribed: true },
    });

    const cardUnwatchRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'sse.unwatch-channel',
      args: { board_id: 'mcp-test-board', client_id: clientId, channel_name: 'watchparty', card_id: 'card-1' },
    }), cardUnwatchRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(cardUnwatchRes._status).toBe(200);
    expect(parseJsonBody(cardUnwatchRes)).toEqual({
      status: 'success',
      data: { boardId: 'mcp-test-board', clientId, channelName: 'watchparty', cardId: 'card-1', subscribed: false },
    });

    const boardUnwatchRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'sse.unwatch-channel',
      args: { board_id: 'mcp-test-board', client_id: clientId, channel_name: 'watchparty' },
    }), boardUnwatchRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(boardUnwatchRes._status).toBe(200);
    expect(parseJsonBody(boardUnwatchRes)).toEqual({
      status: 'success',
      data: { boardId: 'mcp-test-board', clientId, channelName: 'watchparty', subscribed: false },
    });

    expect(subscribed).toEqual([
      { clientId, channelName: 'watchparty', params: {} },
      { clientId, channelName: 'watchparty', params: { cardId: 'card-1' } },
    ]);
    expect(unsubscribed).toEqual([
      { clientId, channelName: 'watchparty', params: { cardId: 'card-1' } },
      { clientId, channelName: 'watchparty', params: {} },
    ]);
  });

  it('routes stage-ai-response-and-any-attachments through /mcp and appends an assistant chat entry with uploaded file metadata', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp', {
      tool: 'stage-ai-response-and-any-attachments',
      args: {
        card_id: 'card-1',
        turn_id: 'turn-123',
        text: 'Here is your answer.',
        files: [{ file_name: 'result.txt', content_type: 'text/plain', text: 'file content here' }],
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: {
        cardId: 'card-1',
        id: expect.any(String),
        role: 'assistant',
        turn: 'turn-123',
        files: [expect.objectContaining({ name: 'result.txt', mime_type: 'text/plain', size: 17 })],
      },
    });

    const cardRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'manage.read-card',
      args: { card_id: 'card-1' },
    }), cardRes, new URL('http://example.test/api/board/mcp'));
    expect(cardRes._status).toBe(200);
    const cardBody = parseJsonBody(cardRes) as Record<string, unknown>;
    const card = (cardBody.data as Array<Record<string, unknown>>)[0];
    const files = (card.card_data as Record<string, unknown>).files as Array<Record<string, unknown>>;
    expect(files.length).toBe(2);

    const chatsRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'inspect.chat-messages-on-cards',
      args: { card_id: 'card-1', all_turns: true },
    }), chatsRes, new URL('http://example.test/api/board/mcp'));
    expect(chatsRes._status).toBe(200);
    const chatsBody = parseJsonBody(chatsRes) as Record<string, unknown>;
    const messages = ((chatsBody.data as Record<string, unknown>).messages) as Array<Record<string, unknown>>;
    const systemMessage = messages.find((message) => message.role === 'system' && /^AI generated: result\.txt as .*result\.txt #\d+$/.test(String(message.text || '')));
    expect(systemMessage).toBeTruthy();
    expect(messages.filter((message) => /^AI generated: result\.txt as .*result\.txt #\d+$/.test(String(message.text || '')))).toHaveLength(1);
    expect(systemMessage?.turn).toBe('turn-123');
    const assistantMessage = messages.find((message) => message.role === 'assistant' && message.text === 'Here is your answer.');
    expect(assistantMessage).toBeTruthy();
    expect(assistantMessage?.turn).toBe('turn-123');
    expect(Array.isArray(assistantMessage?.files)).toBe(true);
    expect((assistantMessage?.files as Array<Record<string, unknown>>).length).toBe(1);
    expect((assistantMessage?.files as Array<Record<string, unknown>>)[0]).toEqual(expect.objectContaining({ name: 'result.txt', mime_type: 'text/plain' }));
  });

  it('routes stage-ai-failure-message through /mcp and appends a system chat entry for the turn', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp', {
      tool: 'stage-ai-failure-message',
      args: {
        card_id: 'card-1',
        turn_id: 'turn-failure-123',
        failure: 'Model invocation failed: timeout talking to provider',
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: {
        cardId: 'card-1',
        id: expect.any(String),
        role: 'system',
        turn: 'turn-failure-123',
        files: [],
      },
    });

    const chatsRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'inspect.chat-messages-on-cards',
      args: { card_id: 'card-1', turn_id: 'turn-failure-123' },
    }), chatsRes, new URL('http://example.test/api/board/mcp'));
    expect(chatsRes._status).toBe(200);
    const chatsBody = parseJsonBody(chatsRes) as Record<string, unknown>;
    const messages = ((chatsBody.data as Record<string, unknown>).messages) as Array<Record<string, unknown>>;
    expect(messages).toEqual([
      expect.objectContaining({
        role: 'system',
        text: 'Model invocation failed: timeout talking to provider',
        turn: 'turn-failure-123',
        files: [],
      }),
    ]);
  });

  it('routes manage.add-chat-entry-and-any-attachments through /mcp-controlplane for user chat messages', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.add-chat-entry-and-any-attachments',
      args: {
        board_id: 'mcp-test-board',
        card_id: 'card-1',
        role: 'user',
        turn_id: 'turn-user-chat',
        text: 'User prompt with attachment',
        files: [{ file_name: 'user-note.txt', content_type: 'text/plain', text: 'user supplied attachment' }],
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: {
        cardId: 'card-1',
        id: expect.any(String),
        role: 'user',
        turn: 'turn-user-chat',
        files: [expect.objectContaining({ name: 'user-note.txt', mime_type: 'text/plain' })],
      },
    });

    const chatsRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'inspect.chat-messages-on-cards',
      args: { card_id: 'card-1', turn_id: 'turn-user-chat' },
    }), chatsRes, new URL('http://example.test/api/board/mcp'));
    expect(chatsRes._status).toBe(200);
    const chatsBody = parseJsonBody(chatsRes) as Record<string, unknown>;
    const messages = ((chatsBody.data as Record<string, unknown>).messages) as Array<Record<string, unknown>>;
    const systemMessage = messages.find((message) => message.role === 'system');
    const userMessage = messages.find((message) => message.role === 'user');
    expect(systemMessage).toBeTruthy();
    expect(String(systemMessage?.text || '')).toContain('file uploaded: user-note.txt');
    expect(userMessage).toBeTruthy();
    expect(userMessage?.text).toBe('User prompt with attachment');
    expect(userMessage?.turn).toBe('turn-user-chat');
    expect(Array.isArray(userMessage?.files)).toBe(true);
    expect((userMessage?.files as Array<Record<string, unknown>>)[0]).toEqual(expect.objectContaining({ name: 'user-note.txt', mime_type: 'text/plain' }));
  });

  it('routes manage.patch-card through /mcp-controlplane using the MCP manage read-patch-upsert path', async () => {
    const runtime = createRuntime({ withNonCore: true });

    const seedValidCardRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'manage.upsert-card',
      args: {
        card_id: 'card-1',
        candidate_card_content: {
          id: 'card-1',
          card_data: { title: 'Card One' },
          view: { elements: [{ id: 'title', kind: 'text', data: { bind: 'card_data.title' } }] },
        },
      },
    }), seedValidCardRes, new URL('http://example.test/api/board/mcp'));
    expect(seedValidCardRes._status).toBe(200);

    const req = makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.patch-card',
      args: {
        board_id: 'mcp-test-board',
        card_id: 'card-1',
        patch: {
          fieldValues: { title: 'Patched Through MCP' },
        },
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect((parseJsonBody(res) as Record<string, unknown>).status).toBe('success');

    const cardRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'manage.read-card',
      args: { card_id: 'card-1' },
    }), cardRes, new URL('http://example.test/api/board/mcp'));
    expect(cardRes._status).toBe(200);
    const cardBody = parseJsonBody(cardRes) as Record<string, unknown>;
    const card = (cardBody.data as Array<Record<string, unknown>>)[0];
    expect((card.card_data as Record<string, unknown>).title).toBe('Patched Through MCP');
  });

  it('silently ignores a second staged AI response for the same turn-id', async () => {
    const runtime = createRuntime();

    const firstRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'stage-ai-response-and-any-attachments',
      args: {
        card_id: 'card-1',
        turn_id: 'turn-dup',
        text: 'First answer',
        files: [{ file_name: 'first.txt', content_type: 'text/plain', text: 'first file' }],
      },
    }), firstRes, new URL('http://example.test/api/board/mcp'));
    expect(firstRes._status).toBe(200);

    const secondRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'stage-ai-response-and-any-attachments',
      args: {
        card_id: 'card-1',
        turn_id: 'turn-dup',
        text: 'Second answer should be ignored',
        files: [{ file_name: 'second.txt', content_type: 'text/plain', text: 'second file' }],
      },
    }), secondRes, new URL('http://example.test/api/board/mcp'));
    expect(secondRes._status).toBe(200);

    const firstBody = parseJsonBody(firstRes) as Record<string, unknown>;
    const secondBody = parseJsonBody(secondRes) as Record<string, unknown>;
    expect(((secondBody.data as Record<string, unknown>).id)).toBe(((firstBody.data as Record<string, unknown>).id));

    const chatsRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'inspect.chat-messages-on-cards',
      args: { card_id: 'card-1', turn_id: 'turn-dup' },
    }), chatsRes, new URL('http://example.test/api/board/mcp'));
    expect(chatsRes._status).toBe(200);
    const chatsBody = parseJsonBody(chatsRes) as Record<string, unknown>;
    const messages = ((chatsBody.data as Record<string, unknown>).messages) as Array<Record<string, unknown>>;
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(messages.filter((message) => message.role === 'assistant')[0]?.text).toBe('First answer');
    expect(messages.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(messages.filter((message) => /^AI generated: /.test(String(message.text || '')))).toHaveLength(1);

    const cardRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'manage.read-card',
      args: { card_id: 'card-1' },
    }), cardRes, new URL('http://example.test/api/board/mcp'));
    expect(cardRes._status).toBe(200);
    const cardBody = parseJsonBody(cardRes) as Record<string, unknown>;
    const card = (cardBody.data as Array<Record<string, unknown>>)[0];
    const files = ((card.card_data as Record<string, unknown>).files as Array<Record<string, unknown>>)
      .filter((file) => file.name === 'first.txt' || file.name === 'second.txt');
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe('first.txt');
  });

  it('filters chats by turn in the MCP read surface', async () => {
    const runtime = createRuntime();
    const addARes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'stage-ai-response-and-any-attachments',
      args: { card_id: 'card-1', turn_id: 'turn-a', text: 'Message A' },
    }), addARes, new URL('http://example.test/api/board/mcp'));
    const addBRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'stage-ai-response-and-any-attachments',
      args: { card_id: 'card-1', turn_id: 'turn-b', text: 'Message B' },
    }), addBRes, new URL('http://example.test/api/board/mcp'));

    const mcpRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'inspect.chat-messages-on-cards',
      args: { card_id: 'card-1', turn_id: 'turn-a' },
    }), mcpRes, new URL('http://example.test/api/board/mcp'));
    expect(mcpRes._status).toBe(200);
    const mcpBody = parseJsonBody(mcpRes) as Record<string, unknown>;
    const mcpMessages = ((mcpBody.data as Record<string, unknown>).messages) as Array<Record<string, unknown>>;
    expect(mcpMessages.length).toBe(1);
    expect(mcpMessages[0].text).toBe('Message A');
    expect(mcpMessages[0].turn).toBe('turn-a');
  });

  it('defaults chat reads to the last 1 user turn when neither turn-id nor lastUserTurns is provided', async () => {
    const runtime = createRuntime();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.add-chat-entry-and-any-attachments',
      args: { board_id: 'mcp-test-board', card_id: 'card-1', role: 'user', turn_id: 'turn-1', text: 'Question 1' },
    }), makeResponse(), new URL('http://example.test/api/board/mcp-controlplane'));
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.add-chat-entry-and-any-attachments',
      args: { board_id: 'mcp-test-board', card_id: 'card-1', role: 'assistant', turn_id: 'turn-1', text: 'Answer 1' },
    }), makeResponse(), new URL('http://example.test/api/board/mcp-controlplane'));
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.add-chat-entry-and-any-attachments',
      args: { board_id: 'mcp-test-board', card_id: 'card-1', role: 'user', turn_id: 'turn-2', text: 'Question 2' },
    }), makeResponse(), new URL('http://example.test/api/board/mcp-controlplane'));
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.add-chat-entry-and-any-attachments',
      args: { board_id: 'mcp-test-board', card_id: 'card-1', role: 'assistant', turn_id: 'turn-2', text: 'Answer 2' },
    }), makeResponse(), new URL('http://example.test/api/board/mcp-controlplane'));

    const mcpRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'inspect.chat-messages-on-cards',
      args: { card_id: 'card-1' },
    }), mcpRes, new URL('http://example.test/api/board/mcp'));
    expect(mcpRes._status).toBe(200);
    const mcpBody = parseJsonBody(mcpRes) as Record<string, unknown>;
    const mcpMessages = ((mcpBody.data as Record<string, unknown>).messages) as Array<Record<string, unknown>>;
    expect(mcpMessages.map((m) => m.text)).toEqual(['Question 2', 'Answer 2']);
  });

  it('returns the full chat when all-turns=true', async () => {
    const runtime = createRuntime();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.add-chat-entry-and-any-attachments',
      args: { board_id: 'mcp-test-board', card_id: 'card-1', role: 'user', turn_id: 'turn-1', text: 'Question 1' },
    }), makeResponse(), new URL('http://example.test/api/board/mcp-controlplane'));
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.add-chat-entry-and-any-attachments',
      args: { board_id: 'mcp-test-board', card_id: 'card-1', role: 'assistant', turn_id: 'turn-1', text: 'Answer 1' },
    }), makeResponse(), new URL('http://example.test/api/board/mcp-controlplane'));
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.add-chat-entry-and-any-attachments',
      args: { board_id: 'mcp-test-board', card_id: 'card-1', role: 'user', turn_id: 'turn-2', text: 'Question 2' },
    }), makeResponse(), new URL('http://example.test/api/board/mcp-controlplane'));
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.add-chat-entry-and-any-attachments',
      args: { board_id: 'mcp-test-board', card_id: 'card-1', role: 'assistant', turn_id: 'turn-2', text: 'Answer 2' },
    }), makeResponse(), new URL('http://example.test/api/board/mcp-controlplane'));

    const mcpRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'inspect.chat-messages-on-cards',
      args: { card_id: 'card-1', all_turns: true },
    }), mcpRes, new URL('http://example.test/api/board/mcp'));
    expect(mcpRes._status).toBe(200);
    const mcpBody = parseJsonBody(mcpRes) as Record<string, unknown>;
    const mcpMessages = ((mcpBody.data as Record<string, unknown>).messages) as Array<Record<string, unknown>>;
    expect(mcpMessages.map((m) => m.text)).toEqual(['Question 1', 'Answer 1', 'Question 2', 'Answer 2']);
  });

  it('supports tail-turns-before-id in the MCP read surface', async () => {
    const runtime = createRuntime();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'stage-ai-response-and-any-attachments',
      args: { card_id: 'card-1', turn_id: 'turn-a', text: 'Message A' },
    }), makeResponse(), new URL('http://example.test/api/board/mcp'));
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'stage-ai-response-and-any-attachments',
      args: { card_id: 'card-1', turn_id: 'turn-b', text: 'Message B' },
    }), makeResponse(), new URL('http://example.test/api/board/mcp'));
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'stage-ai-response-and-any-attachments',
      args: { card_id: 'card-1', turn_id: 'turn-c', text: 'Message C' },
    }), makeResponse(), new URL('http://example.test/api/board/mcp'));

    const mcpRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'inspect.chat-messages-on-cards',
      args: { card_id: 'card-1', tail_turns: 1, tail_turns_before_id: 'turn-c' },
    }), mcpRes, new URL('http://example.test/api/board/mcp'));
    expect(mcpRes._status).toBe(200);
    const mcpBody = parseJsonBody(mcpRes) as Record<string, unknown>;
    const mcpMessages = ((mcpBody.data as Record<string, unknown>).messages) as Array<Record<string, unknown>>;
    expect(mcpMessages.length).toBe(1);
    expect(mcpMessages.map((m) => m.text)).toEqual(['Message B']);
  });

  it('rejects inspect.file-contents on /mcp', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp', { tool: 'inspect.file-contents', args: { card_id: 'card-1', file_idx: 0 } });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp'));
    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(parseJsonBody(res)).toEqual({ error: 'inspect.file-contents is only available on /mcp-raw' });
  });

  it('routes inspect.file-contents through /mcp-raw and returns raw bytes', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp-raw', { tool: 'inspect.file-contents', args: { card_id: 'card-1', file_idx: 0 } });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-raw'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('text/plain');
    expect(res._headers['Content-Disposition']).toBe('attachment; filename="hello.txt"');
    expect(res._body).toBe('hello');
  });

  it('supports head-lines on /mcp-raw for text files', async () => {
    const runtime = createRuntime();
    fs.writeFileSync(path.join(testRoot, 'files', 'card-1', 'hello.txt'), 'one\ntwo\nthree\n', 'utf8');
    const req = makeRequest('POST', '/api/board/mcp-raw', { tool: 'inspect.file-contents', args: { card_id: 'card-1', file_idx: 0, 'head-lines': 2 } });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-raw'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(res._body).toBe('one\ntwo');
  });

  it('supports tail-bytes on /mcp-raw', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp-raw', { tool: 'inspect.file-contents', args: { card_id: 'card-1', file_idx: 0, 'tail-bytes': 2 } });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-raw'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(res._body).toBe('lo');
  });

  it('rejects unsupported tools on /mcp-raw', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp-raw', { tool: 'manage.read-card', args: { card_id: 'card-1' } });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-raw'));
    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(parseJsonBody(res)).toEqual({ error: 'Tool does not support raw response: manage.read-card' });
  });

  it('wraps the file body as JSON { bodyBase64, mimeType, filename, byteLength } when resp=json-b64', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp-raw', { tool: 'inspect.file-contents', args: { card_id: 'card-1', file_idx: 0 } });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-raw?resp=json-b64'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(res._headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(parseJsonBody(res)).toEqual({
      bodyBase64: Buffer.from('hello').toString('base64'),
      mimeType: 'text/plain',
      filename: 'hello.txt',
      byteLength: 5,
    });
  });

  it('rejects unknown resp modes on /mcp-raw', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp-raw', { tool: 'inspect.file-contents', args: { card_id: 'card-1', file_idx: 0 } });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-raw?resp=hex'));
    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(parseJsonBody(res)).toEqual({ error: 'unsupported resp mode: hex' });
  });

  it('routes discover.source-kinds through /mcp using a supplied nonCoreAdapter', async () => {
    const runtime = createRuntime({ withNonCore: true });
    const req = makeRequest('POST', '/api/board/mcp', { tool: 'discover.source-kinds', args: {} });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: {
        version: '1.0',
        commonSourceFields: { bindTo: { type: 'string' } },
        sourceKinds: { fake: { title: 'Fake Source' } },
      },
    });
  });

  it('routes inspect.board-runtime-status through /mcp', async () => {
    const runtime = createRuntime();
    const warmReq = makeRequest('POST', '/api/board/mcp', { tool: 'manage.read-card', args: { card_id: 'card-1' } });
    const warmRes = makeResponse();
    await runtime.handleRuntimeApi(warmReq, warmRes, new URL('http://example.test/api/board/mcp'));
    expect(warmRes._status).toBe(200);
    expect((await drainProcessAccumulated(runtime)).status).toBe('success');
    const req = makeRequest('POST', '/api/board/mcp', { tool: 'inspect.board-runtime-status', args: {} });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: expect.objectContaining({
        meta: expect.any(Object),
        summary: expect.objectContaining({ card_count: expect.any(Number) }),
        cards: expect.arrayContaining([
          expect.objectContaining({ 'card-id': 'card-1' }),
        ]),
      }),
    });
  });

  it('routes webhook.process-accumulated through /mcp-webhooks', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp-webhooks', {
      tool: 'webhook.process-accumulated',
      args: {},
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-webhooks'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: {
        runtime_result: null,
      },
    });
  });

  it('routes webhook.source-fetch-done through /mcp-webhooks and returns a client error for an invalid token', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp-webhooks', {
      tool: 'webhook.source-fetch-done',
      args: {
        token: 'not-a-valid-token',
        ref: serializeRef({ kind: 'fs-path', value: path.join(os.tmpdir(), 'missing-source.json') }),
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp-webhooks'));
    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(parseJsonBody(res)).toEqual({
      error: expect.stringContaining('Invalid source token'),
    });
  });

  it('routes manage.remove-card through /mcp and removes the card from both board and store', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/mcp', { tool: 'manage.remove-card', args: { card_id: 'card-1' } });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: expect.objectContaining({
        board_result: expect.objectContaining({ status: 'success' }),
        store_result: expect.objectContaining({ status: 'success' }),
      }),
    });

    const cardRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'manage.read-card',
      args: { card_id: 'card-1' },
    }), cardRes, new URL('http://example.test/api/board/mcp'));
    expect(cardRes._status).toBe(200);
    expect(parseJsonBody(cardRes)).toEqual({
      status: 'success',
      data: [],
    });
  });

  it('routes preflight.validate-candidate-card-definition through /mcp using a supplied nonCoreAdapter', async () => {
    const runtime = createRuntime({ withNonCore: true });
    const req = makeRequest('POST', '/api/board/mcp', {
      tool: 'preflight.validate-candidate-card-definition',
      args: { candidate_card_content: { id: 'tmp-card', card_data: { x: 1 } } },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: { cardId: 'tmp-card', isValid: true, issues: [] },
    });
  });

  it('routes preflight.probe-single-source-in-candidate-card through /mcp using a supplied nonCoreAdapter', async () => {
    const runtime = createRuntime({ withNonCore: true });
    const req = makeRequest('POST', '/api/board/mcp', {
      tool: 'preflight.probe-single-source-in-candidate-card',
      args: {
        source_idx: 0,
        candidate_card_content: {
          id: 'tmp-card',
          card_data: {},
          source_defs: [{ bindTo: 'sourceA', kind: 'fake' }],
        },
        mock_projections: {},
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: { bindTo: 'sourceA', reachable: true, latencyMs: 3, note: undefined },
    });
  });

  it('routes preflight.materialize-candidate-card through /mcp using a supplied nonCoreAdapter', async () => {
    const runtime = createRuntime({ withNonCore: true });
    const req = makeRequest('POST', '/api/board/mcp', {
      tool: 'preflight.materialize-candidate-card',
      args: {
        candidate_card_content: {
          id: 'compute-card',
          card_data: { title: 'Compute Card' },
          compute: [{ bindTo: 'total', expr: '1 + 2 + 3' }],
          provides: [{ bindTo: 'summaryTotal', ref: 'computed_values.total' }],
          view: {
            elements: [{ id: 'summary', kind: 'text', label: 'Summary', data: { bind: 'computed_values.total' } }],
          },
        },
        mock_requires: {},
        mock_fetched_sources: {},
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: {
        cardId: 'compute-card',
        ok: true,
        computed_values: { total: 6 },
        errors: [],
        provides_outputs: { summaryTotal: 6 },
        rendered_view: {
          elements: [{ id: 'summary', kind: 'text', label: 'Summary', visible: true, resolved: 6 }],
        },
      },
    });
  });

  it('rejects preflight.materialize-candidate-card when mock_requires or mock_fetched_sources are omitted', async () => {
    const runtime = createRuntime({ withNonCore: true });
    const req = makeRequest('POST', '/api/board/mcp', {
      tool: 'preflight.materialize-candidate-card',
      args: {
        candidate_card_content: {
          id: 'compute-card',
          card_data: {},
          compute: [{ bindTo: 'total', expr: '1 + 2 + 3' }],
        },
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp'));
    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(parseJsonBody(res)).toEqual({ error: 'MCP tool requires mock_requires' });
  });

  it('rejects preflight.probe-single-source-in-candidate-card fail results on /mcp with a 400 error payload', async () => {
    const runtime = createRuntime({ withNonCore: true });
    const req = makeRequest('POST', '/api/board/mcp', {
      tool: 'preflight.probe-single-source-in-candidate-card',
      args: {
        source_idx: 3,
        candidate_card_content: {
          id: 'tmp-card',
          card_data: {},
          source_defs: [{ bindTo: 'sourceA', kind: 'fake' }],
        },
        mock_projections: {},
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp'));
    expect(handled).toBe(true);
    expect(res._status).toBe(400);
    expect(parseJsonBody(res)).toEqual({ error: 'sourceIdx 3 out of range (card has 1 source(s))' });
  });

  it('routes preflight.run-single-source-in-candidate-card through /mcp using a supplied nonCoreAdapter', async () => {
    const runtime = createRuntime({ withNonCore: true });
    const req = makeRequest('POST', '/api/board/mcp', {
      tool: 'preflight.run-single-source-in-candidate-card',
      args: {
        source_idx: 0,
        candidate_card_content: {
          id: 'tmp-card',
          card_data: {},
          source_defs: [{ bindTo: 'sourceA', kind: 'fake' }],
        },
        mock_projections: {},
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: {
        bindTo: 'sourceA',
        ok: true,
        result: { ok: true },
        issues: [],
      },
    });
  });

  it('routes preflight.run-single-source-in-live-card through /mcp using a supplied nonCoreAdapter', async () => {
    const { runtime, boardAdapter, cardStoreRef, filesDir } = createRuntimeHarness({ withNonCore: true });
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
    fs.mkdirSync(path.join(filesDir, 'card-1'), { recursive: true });
    const seedResult = preloadStore.set({
      body: {
        id: 'card-1',
        card_data: { title: 'Live Source Card' },
        source_defs: [{ bindTo: 'sourceA', kind: 'fake' }],
        view: {
          elements: [{ id: 'summary', kind: 'text', data: { bind: 'card_data.title' } }],
        },
      },
    });
    expect(seedResult.status).toBe('success');

    const req = makeRequest('POST', '/api/board/mcp', {
      tool: 'preflight.run-single-source-in-live-card',
      args: {
        card_id: 'card-1',
        source_idx: 0,
        mock_requires: {},
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: {
        bindTo: 'sourceA',
        ok: true,
        result: { ok: true },
        issues: [],
      },
    });
  });

  it('routes preflight.run-one-cycle-with-candidate-card through /mcp using a supplied nonCoreAdapter', async () => {
    const runtime = createRuntime({ withNonCore: true });
    const req = makeRequest('POST', '/api/board/mcp', {
      tool: 'preflight.run-one-cycle-with-candidate-card',
      args: {
        candidate_card_content: {
          id: 'cycle-card',
          card_data: { title: 'Cycle Card' },
          provides: [{ bindTo: 'cycle-card-summary', ref: 'card_data.title' }],
          source_defs: [{ bindTo: 'sourceA', outputFile: 'sourceA.json', kind: 'fake' }],
          compute: [{ bindTo: 'total', expr: '1 + 2' }],
          view: {
            layout: { kind: 'stack' },
            elements: [{ id: 'summary', kind: 'text', label: 'Summary', data: { bind: 'card_data.title' } }],
          },
        },
        mock_requires: {},
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/mcp'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual({
      status: 'success',
      data: {
        cardId: 'cycle-card',
        ok: true,
        issues: [],
        provides_outputs: { 'cycle-card-summary': 'Cycle Card' },
        rendered_view: {
          elements: [{ id: 'summary', kind: 'text', label: 'Summary', visible: true, resolved: 'Cycle Card' }],
        },
      },
    });
  });

  it('routes manage.admin-upsert-card and manage.admin-read-card through /mcp-controlplane', async () => {
    const runtime = createRuntime({ withNonCore: true });

    const upsertRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.admin-upsert-card',
      args: {
        board_id: 'mcp-test-board',
        card_id: 'card-1',
        candidate_card_content: {
          id: 'card-1',
          meta: { title: 'admin-only' },
          card_data: { title: 'Admin Card One' },
          view: { elements: [{ id: 'title', kind: 'text', data: { bind: 'card_data.title' } }] },
        },
      },
    }), upsertRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(upsertRes._status).toBe(200);
    expect((parseJsonBody(upsertRes) as Record<string, unknown>).status).toBe('success');

    const readRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'manage.admin-read-card',
      args: { board_id: 'mcp-test-board', card_id: 'card-1' },
    }), readRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(readRes._status).toBe(200);
    expect(parseJsonBody(readRes)).toEqual({
      status: 'success',
      data: {
        cards: [
          expect.objectContaining({
            id: 'card-1',
            card_data: expect.objectContaining({ title: 'Admin Card One' }),
            __private: expect.objectContaining({ visible_controlplane_only: true }),
          }),
        ],
      },
    });
  });
});