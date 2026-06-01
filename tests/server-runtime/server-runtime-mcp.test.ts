import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createSingleBoardServerRuntime } from '../../src/server-runtime/index.js';
import type { RuntimeRequest, RuntimeResponse, SingleBoardRuntimeOptions } from '../../src/server-runtime/types.js';
import { createFsBoardNonCorePlatformAdapter, createFsBoardPlatformAdapter } from '../../src/cli/node/fs-board-adapter.js';
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

async function drainQueuedChatRequests(runtime: { handleChatAgentRequest(request: Record<string, unknown>): Promise<void> }, boardAdapter: { chatAgentStore(): { leaseRequests(opts?: { max?: number; visibilityMs?: number }): Array<{ messageId: string; leaseToken: string; request: Record<string, unknown> }>; ackRequest(messageId: string, leaseToken: string): boolean; }; }): Promise<void> {
  const workerStore = boardAdapter.chatAgentStore();
  while (true) {
    const leases = workerStore.leaseRequests({ max: 20, visibilityMs: 60_000 });
    if (!leases.length) break;
    for (const lease of leases) {
      await runtime.handleChatAgentRequest(lease.request);
      workerStore.ackRequest(lease.messageId, lease.leaseToken);
    }
  }
}

describe('server runtime MCP endpoint', () => {
  let testRoot = '';

  afterEach(() => {
    if (testRoot) {
      fs.rmSync(testRoot, { recursive: true, force: true });
      testRoot = '';
    }
  });

  function createRuntime(opts: { withNonCore?: boolean; chatHandlerFlow?: unknown; chatFlowRunner?: SingleBoardRuntimeOptions['chatFlowRunner'] } = {}) {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-mcp-'));
    const boardDir = path.join(testRoot, 'board');
    const cardStoreDir = path.join(testRoot, 'card-store');
    const outputsDir = path.join(testRoot, 'outputs');
    const filesDir = path.join(testRoot, 'files');
    fs.mkdirSync(boardDir, { recursive: true });
    fs.mkdirSync(cardStoreDir, { recursive: true });
    fs.mkdirSync(outputsDir, { recursive: true });
    fs.mkdirSync(filesDir, { recursive: true });

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
    const artifactsAdapter = createFsBoardPlatformAdapter(parseRef(serializeRef({ kind: 'fs-path', value: filesDir })), testRoot, { suppressSpawn: true, onWarn: () => {} });
    const nonCoreAdapter = opts.withNonCore
      ? createFsBoardNonCorePlatformAdapter(baseRef, testRoot, { suppressSpawn: true, onWarn: () => {} })
      : undefined;
    const runtimeOptions: SingleBoardRuntimeOptions = {
      apiBasePath: '/api/board',
      boardId: 'mcp-test-board',
      boards: [{
        label: 'base',
        boardAdapter,
        artifactsAdapter,
        ...(nonCoreAdapter ? { nonCoreAdapter } : {}),
        baseRef,
        cardStoreRef: serializeRef({ kind: 'fs-path', value: cardStoreDir }),
        outputsStoreRef: serializeRef({ kind: 'fs-path', value: outputsDir }),
        artifactsStoreRef: serializeRef({ kind: 'fs-path', value: filesDir }),
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
    fs.mkdirSync(path.join(filesDir, 'card-1'), { recursive: true });
    fs.writeFileSync(path.join(filesDir, 'card-1', 'hello.txt'), 'hello', 'utf8');
    const seedResult = runtime.cardStore.set({
      body: {
        id: 'card-1',
        card_data: {
          title: 'Card One',
          files: [{ name: 'hello.txt', stored_name: 'hello.txt', mime_type: 'text/plain', size: 5, uploaded_at: '2026-05-28T00:00:00.000Z' }],
        },
      },
    });
    expect(seedResult.status).toBe('success');
    return runtime;
  }

  function createRuntimeHarness(opts: { withNonCore?: boolean; chatHandlerFlow?: unknown; chatFlowRunner?: SingleBoardRuntimeOptions['chatFlowRunner'] } = {}) {
    testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yaml-flow-mcp-'));
    const boardDir = path.join(testRoot, 'board');
    const cardStoreDir = path.join(testRoot, 'card-store');
    const outputsDir = path.join(testRoot, 'outputs');
    const filesDir = path.join(testRoot, 'files');
    fs.mkdirSync(boardDir, { recursive: true });
    fs.mkdirSync(cardStoreDir, { recursive: true });
    fs.mkdirSync(outputsDir, { recursive: true });
    fs.mkdirSync(filesDir, { recursive: true });

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
    const artifactsAdapter = createFsBoardPlatformAdapter(parseRef(serializeRef({ kind: 'fs-path', value: filesDir })), testRoot, { suppressSpawn: true, onWarn: () => {} });
    const nonCoreAdapter = opts.withNonCore
      ? createFsBoardNonCorePlatformAdapter(baseRef, testRoot, { suppressSpawn: true, onWarn: () => {} })
      : undefined;
    const runtimeOptions: SingleBoardRuntimeOptions = {
      apiBasePath: '/api/board',
      boardId: 'mcp-test-board',
      boards: [{
        label: 'base',
        boardAdapter,
        artifactsAdapter,
        ...(nonCoreAdapter ? { nonCoreAdapter } : {}),
        baseRef,
        cardStoreRef: serializeRef({ kind: 'fs-path', value: cardStoreDir }),
        outputsStoreRef: serializeRef({ kind: 'fs-path', value: outputsDir }),
        artifactsStoreRef: serializeRef({ kind: 'fs-path', value: filesDir }),
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
    fs.mkdirSync(path.join(filesDir, 'card-1'), { recursive: true });
    fs.writeFileSync(path.join(filesDir, 'card-1', 'hello.txt'), 'hello', 'utf8');
    const seedResult = runtime.cardStore.set({
      body: {
        id: 'card-1',
        card_data: {
          title: 'Card One',
          files: [{ name: 'hello.txt', stored_name: 'hello.txt', mime_type: 'text/plain', size: 5, uploaded_at: '2026-05-28T00:00:00.000Z' }],
        },
      },
    });
    expect(seedResult.status).toBe('success');
    return { runtime, boardAdapter };
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
      tool: 'setstate.card-meta',
      args: { board_id: 'mcp-test-board', card_id: 'card-1', key: 'chat.foundry_thread_id', value: 'thread-123' },
    }), setMetaRes, new URL('http://example.test/api/board/mcp-controlplane'));
    expect(setMetaRes._status).toBe(200);
    expect(parseJsonBody(setMetaRes)).toEqual({
      status: 'success',
      data: { boardId: 'mcp-test-board', cardId: 'card-1', key: 'chat.foundry_thread_id' },
    });

    const getMetaRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'getstate.card-meta',
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
    expect(readCards[0].meta).toBeUndefined();

    const directCardRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('GET', '/api/board/cards/card-1'), directCardRes, new URL('http://example.test/api/board/cards/card-1'));
    expect(directCardRes._status).toBe(200);
    const directCard = parseJsonBody(directCardRes) as Record<string, unknown>;
    expect(directCard.meta).toEqual({ chat: { foundry_thread_id: 'thread-123' } });
  });

  it('strips incoming meta on regular /mcp upsert-card while preserving stored controlplane meta', async () => {
    const runtime = createRuntime({ withNonCore: true });

    const setMetaRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp-controlplane', {
      tool: 'setstate.card-meta',
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
    expect((await runtime.processAccumulatedEvents()).status).toBe('success');

    const directCardRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('GET', '/api/board/cards/card-1'), directCardRes, new URL('http://example.test/api/board/cards/card-1'));
    expect(directCardRes._status).toBe(200);
    const directCard = parseJsonBody(directCardRes) as Record<string, unknown>;
    expect((directCard.card_data as Record<string, unknown>).title).toBe('Updated Card One');
    expect(directCard.meta).toEqual({ chat: { foundry_thread_id: 'thread-original' } });

    const inspectRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/mcp', {
      tool: 'inspect.card-definition-and-runtime',
      args: { card_id: 'card-1' },
    }), inspectRes, new URL('http://example.test/api/board/mcp'));
    expect(inspectRes._status).toBe(200);
    const inspectBody = parseJsonBody(inspectRes) as Record<string, unknown>;
    const inspectData = inspectBody.data as Record<string, unknown>;
    expect((inspectData.card_definition_and_static_data as Record<string, unknown>).meta).toBeUndefined();
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

  it('POST /cards/:id/files uploads bytes, appends metadata, and emits a chat system message with turn when inChat=true', async () => {
    const runtime = createRuntime();
    const req = makeRequest('POST', '/api/board/cards/card-1/files?inChat=true', 'hello upload');
    req.headers['content-type'] = 'text/plain';
    req.headers['x-file-name'] = encodeURIComponent('upload.txt');
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/cards/card-1/files?inChat=true&turn-id=turn-upload'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    expect(parseJsonBody(res)).toEqual(expect.objectContaining({
      ok: true,
      file: expect.objectContaining({ name: 'upload.txt', mime_type: 'text/plain', size: 12 }),
    }));

    const cardReq = makeRequest('GET', '/api/board/cards/card-1');
    const cardRes = makeResponse();
    await runtime.handleRuntimeApi(cardReq, cardRes, new URL('http://example.test/api/board/cards/card-1'));
    const card = parseJsonBody(cardRes) as Record<string, unknown>;
    const files = (card.card_data as Record<string, unknown>).files as Array<Record<string, unknown>>;
    expect(files.length).toBe(2);

    const chatsReq = makeRequest('GET', '/api/board/cards/card-1/chats');
    const chatsRes = makeResponse();
    await runtime.handleRuntimeApi(chatsReq, chatsRes, new URL('http://example.test/api/board/cards/card-1/chats'));
    const chatsBody = parseJsonBody(chatsRes) as Record<string, unknown>;
    const uploadSystemMessage = (chatsBody.messages as Array<Record<string, unknown>>).find((message) => String(message.text || '').includes('file uploaded: upload.txt'));
    expect(uploadSystemMessage).toBeTruthy();
    expect(uploadSystemMessage?.turn).toBe('turn-upload');
  });

  it('POST /cards/:id/actions chat-send propagates turn-id to the user message and flow args', async () => {
    const observed: Array<Record<string, unknown>> = [];
    const { runtime, boardAdapter } = createRuntimeHarness({
      chatHandlerFlow: { id: 'test-flow' },
      chatFlowRunner: {
        async run(_flow, args) {
          observed.push(args);
          return { dispatched: true };
        },
      },
    });

    const req = makeRequest('POST', '/api/board/cards/card-1/actions', {
      actionType: 'chat-send',
      payload: {
        text: 'Hello turn aware world',
        'turn-id': 'turn-chat-send',
      },
    });
    const res = makeResponse();

    const handled = await runtime.handleRuntimeApi(req, res, new URL('http://example.test/api/board/cards/card-1/actions'));
    expect(handled).toBe(true);
    expect(res._status).toBe(200);
    await drainQueuedChatRequests(runtime, boardAdapter);

    const chatsReq = makeRequest('GET', '/api/board/cards/card-1/chats');
    const chatsRes = makeResponse();
    await runtime.handleRuntimeApi(chatsReq, chatsRes, new URL('http://example.test/api/board/cards/card-1/chats?all-turns=true'));
    const chatsBody = parseJsonBody(chatsRes) as Record<string, unknown>;
    const userMessage = (chatsBody.messages as Array<Record<string, unknown>>).find((message) => message.role === 'user' && message.text === 'Hello turn aware world');
    expect(userMessage).toBeTruthy();
    expect(userMessage?.turn).toBe('turn-chat-send');
    expect(observed.length).toBe(1);
    expect(observed[0].turnId).toBe('turn-chat-send');
  });

  it('POST /cards/:id/chats preserves turn on appended assistant messages', async () => {
    const runtime = createRuntime();
    const postReq = makeRequest('POST', '/api/board/cards/card-1/chats', {
      role: 'assistant',
      text: 'Turn aware assistant reply',
      files: [],
      turn: 'turn-post-chat',
      done: true,
    });
    const postRes = makeResponse();

    const handled = await runtime.handleRuntimeApi(postReq, postRes, new URL('http://example.test/api/board/cards/card-1/chats'));
    expect(handled).toBe(true);
    expect(postRes._status).toBe(200);

    const chatsReq = makeRequest('GET', '/api/board/cards/card-1/chats');
    const chatsRes = makeResponse();
    await runtime.handleRuntimeApi(chatsReq, chatsRes, new URL('http://example.test/api/board/cards/card-1/chats?all-turns=true'));
    const chatsBody = parseJsonBody(chatsRes) as Record<string, unknown>;
    const assistantMessage = (chatsBody.messages as Array<Record<string, unknown>>)
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

    const cardReq = makeRequest('GET', '/api/board/cards/card-1');
    const cardRes = makeResponse();
    await runtime.handleRuntimeApi(cardReq, cardRes, new URL('http://example.test/api/board/cards/card-1'));
    const card = parseJsonBody(cardRes) as Record<string, unknown>;
    const files = (card.card_data as Record<string, unknown>).files as Array<Record<string, unknown>>;
    expect(files.length).toBe(2);

    const chatsReq = makeRequest('GET', '/api/board/cards/card-1/chats');
    const chatsRes = makeResponse();
    await runtime.handleRuntimeApi(chatsReq, chatsRes, new URL('http://example.test/api/board/cards/card-1/chats'));
    const chatsBody = parseJsonBody(chatsRes) as Record<string, unknown>;
    expect((chatsBody.messages as Array<Record<string, unknown>>).some((message) => String(message.text || '').includes('file uploaded: tool-upload.txt'))).toBe(false);
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
    await runtime.handleRuntimeApi(makeRequest('GET', '/api/board/init-board'), initStartedRes, new URL('http://example.test/api/board/init-board'));
    expect(initStartedRes._status).toBe(200);
    const initStartedBody = parseJsonBody(initStartedRes) as Record<string, unknown>;
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
    await runtime.handleRuntimeApi(makeRequest('GET', '/api/board/init-board'), initDoneRes, new URL('http://example.test/api/board/init-board'));
    expect(initDoneRes._status).toBe(200);
    const initDoneBody = parseJsonBody(initDoneRes) as Record<string, unknown>;
    const chatsByCardId = (initDoneBody.cardChatsByCardId as Record<string, unknown>) ?? {};
    expect((chatsByCardId['card-1'] as Record<string, unknown> | undefined)?.processing ?? false).toBe(false);
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

    const cardReq = makeRequest('GET', '/api/board/cards/card-1');
    const cardRes = makeResponse();
    await runtime.handleRuntimeApi(cardReq, cardRes, new URL('http://example.test/api/board/cards/card-1'));
    const card = parseJsonBody(cardRes) as Record<string, unknown>;
    const files = (card.card_data as Record<string, unknown>).files as Array<Record<string, unknown>>;
    expect(files.length).toBe(2);

    const chatsReq = makeRequest('GET', '/api/board/cards/card-1/chats');
    const chatsRes = makeResponse();
    await runtime.handleRuntimeApi(chatsReq, chatsRes, new URL('http://example.test/api/board/cards/card-1/chats'));
    const chatsBody = parseJsonBody(chatsRes) as Record<string, unknown>;
    const messages = chatsBody.messages as Array<Record<string, unknown>>;
    const systemMessage = messages.find((message) => message.role === 'system' && /^AI generated: result\.txt as .*result\.txt #\d+$/.test(String(message.text || '')));
    expect(systemMessage).toBeTruthy();
    expect(systemMessage?.turn).toBe('turn-123');
    const assistantMessage = messages.find((message) => message.role === 'assistant' && message.text === 'Here is your answer.');
    expect(assistantMessage).toBeTruthy();
    expect(assistantMessage?.turn).toBe('turn-123');
    expect(Array.isArray(assistantMessage?.files)).toBe(true);
    expect((assistantMessage?.files as Array<Record<string, unknown>>).length).toBe(1);
    expect((assistantMessage?.files as Array<Record<string, unknown>>)[0]).toEqual(expect.objectContaining({ name: 'result.txt', mime_type: 'text/plain' }));
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
    await runtime.handleRuntimeApi(makeRequest('GET', '/api/board/cards/card-1/chats'), chatsRes, new URL('http://example.test/api/board/cards/card-1/chats?turn-id=turn-dup'));
    expect(chatsRes._status).toBe(200);
    const chatsBody = parseJsonBody(chatsRes) as Record<string, unknown>;
    const messages = chatsBody.messages as Array<Record<string, unknown>>;
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(1);
    expect(messages.filter((message) => message.role === 'assistant')[0]?.text).toBe('First answer');
    expect(messages.filter((message) => message.role === 'system')).toHaveLength(1);
    expect(messages.filter((message) => /^AI generated: /.test(String(message.text || '')))).toHaveLength(1);

    const cardRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('GET', '/api/board/cards/card-1'), cardRes, new URL('http://example.test/api/board/cards/card-1'));
    expect(cardRes._status).toBe(200);
    const card = parseJsonBody(cardRes) as Record<string, unknown>;
    const files = ((card.card_data as Record<string, unknown>).files as Array<Record<string, unknown>>)
      .filter((file) => file.name === 'first.txt' || file.name === 'second.txt');
    expect(files).toHaveLength(1);
    expect(files[0]?.name).toBe('first.txt');
  });

  it('filters chats by turn consistently in HTTP and MCP read surfaces', async () => {
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

    const httpRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('GET', '/api/board/cards/card-1/chats'), httpRes, new URL('http://example.test/api/board/cards/card-1/chats?turn-id=turn-a'));
    expect(httpRes._status).toBe(200);
    const httpBody = parseJsonBody(httpRes) as Record<string, unknown>;
    const httpMessages = httpBody.messages as Array<Record<string, unknown>>;
    expect(httpMessages.length).toBe(1);
    expect(httpMessages[0].text).toBe('Message A');
    expect(httpMessages[0].turn).toBe('turn-a');

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
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/cards/card-1/chats', { role: 'user', text: 'Question 1', files: [] }), makeResponse(), new URL('http://example.test/api/board/cards/card-1/chats'));
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/cards/card-1/chats', { role: 'assistant', text: 'Answer 1', files: [] }), makeResponse(), new URL('http://example.test/api/board/cards/card-1/chats'));
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/cards/card-1/chats', { role: 'user', text: 'Question 2', files: [] }), makeResponse(), new URL('http://example.test/api/board/cards/card-1/chats'));
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/cards/card-1/chats', { role: 'assistant', text: 'Answer 2', files: [] }), makeResponse(), new URL('http://example.test/api/board/cards/card-1/chats'));

    const httpRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('GET', '/api/board/cards/card-1/chats'), httpRes, new URL('http://example.test/api/board/cards/card-1/chats'));
    expect(httpRes._status).toBe(200);
    const httpBody = parseJsonBody(httpRes) as Record<string, unknown>;
    const httpMessages = httpBody.messages as Array<Record<string, unknown>>;
    expect(httpMessages.map((m) => m.text)).toEqual(['Question 2', 'Answer 2']);

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
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/cards/card-1/chats', { role: 'user', text: 'Question 1', files: [] }), makeResponse(), new URL('http://example.test/api/board/cards/card-1/chats'));
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/cards/card-1/chats', { role: 'assistant', text: 'Answer 1', files: [] }), makeResponse(), new URL('http://example.test/api/board/cards/card-1/chats'));
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/cards/card-1/chats', { role: 'user', text: 'Question 2', files: [] }), makeResponse(), new URL('http://example.test/api/board/cards/card-1/chats'));
    await runtime.handleRuntimeApi(makeRequest('POST', '/api/board/cards/card-1/chats', { role: 'assistant', text: 'Answer 2', files: [] }), makeResponse(), new URL('http://example.test/api/board/cards/card-1/chats'));

    const httpRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('GET', '/api/board/cards/card-1/chats'), httpRes, new URL('http://example.test/api/board/cards/card-1/chats?all-turns=true'));
    expect(httpRes._status).toBe(200);
    const httpBody = parseJsonBody(httpRes) as Record<string, unknown>;
    const httpMessages = httpBody.messages as Array<Record<string, unknown>>;
    expect(httpMessages.map((m) => m.text)).toEqual(['Question 1', 'Answer 1', 'Question 2', 'Answer 2']);

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

  it('supports tail-turns-before-id in both HTTP and MCP read surfaces', async () => {
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

    const httpRes = makeResponse();
    await runtime.handleRuntimeApi(makeRequest('GET', '/api/board/cards/card-1/chats'), httpRes, new URL('http://example.test/api/board/cards/card-1/chats?tail-turns=1&tail-turns-before-id=turn-c'));
    expect(httpRes._status).toBe(200);
    const httpBody = parseJsonBody(httpRes) as Record<string, unknown>;
    const httpMessages = httpBody.messages as Array<Record<string, unknown>>;
    expect(httpMessages.length).toBe(1);
    expect(httpMessages.map((m) => m.text)).toEqual(['Message B']);

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
    expect((await runtime.processAccumulatedEvents()).status).toBe('success');
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
    await runtime.handleRuntimeApi(makeRequest('GET', '/api/board/cards/card-1'), cardRes, new URL('http://example.test/api/board/cards/card-1'));
    expect(cardRes._status).toBe(404);
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
            layout: { kind: 'stack' },
            features: {},
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
          layout: { kind: 'stack' },
          features: {},
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
    const runtime = createRuntime({ withNonCore: true });

    const seedResult = runtime.cardStore.set({
      body: {
        id: 'card-1',
        card_data: { title: 'Live Source Card' },
        source_defs: [{ bindTo: 'sourceA', kind: 'fake' }],
        view: {
          layout: { kind: 'stack' },
          features: {},
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
          layout: { kind: 'stack' },
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
            meta: expect.objectContaining({ __visible_controlplane_only: true }),
          }),
        ],
      },
    });
  });
});