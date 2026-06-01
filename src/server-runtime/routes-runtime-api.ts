/**
 * server-runtime/routes-runtime-api.ts
 *
 * The single-board HTTP route table extracted from
 * createSingleBoardServerRuntime. The body is the original
 * `handleRuntimeApi` verbatim; everything it touches in the runtime
 * closure (board lifecycle, MCP, chat, file ops, etc.) is passed in as
 * a narrow callback in `RoutesRuntimeApiDeps`.
 */

import type { RuntimeRequest, RuntimeResponse } from './types.js';
import type { SseHub } from './sse-hub.js';
import { escapeRegExp } from './internal-helpers.js';
import { getMcpArgString, getMcpArgNumber } from './mcp-args.js';
import { invokeMcpTool, extractMcpFailureMessage } from './mcp-invoker.js';
import type { ToolRegistry } from './mcp-tool-registries.js';
import type { ChatStorePublic } from '../cli/common/chat-store-lib-public.js';

interface ChatStorageLike {
  append: (cardId: string, role: string, text: string, files: unknown[], turn: string) => string;
  setProcessing: (cardId: string, active: boolean) => void;
}

interface McpFacadeLike {
  inspectFileContents: (args: { cardId: string; fileIdx: number }) => unknown;
}

interface CardFileRecord {
  name?: unknown;
  stored_name?: unknown;
  mime_type?: unknown;
}

export interface RoutesRuntimeApiDeps {
  apiBasePath: string;
  boardContexts: ReadonlyArray<unknown>;

  json: (res: RuntimeResponse, status: number, payload: unknown) => void;
  readJsonBody: (req: RuntimeRequest) => Promise<Record<string, unknown>>;
  readRawBody: (req: RuntimeRequest) => Promise<Uint8Array>;

  initBoardAndSetup: () => Promise<void>;
  bootstrapBoard: () => Promise<void>;
  buildPublishedRuntimePayload: () => Promise<unknown>;
  publishPersistedStateSnapshot: (ctx: unknown) => Promise<void>;
  upsertCardsFromSource: (ctx: unknown, ctxIndex: number) => Promise<void>;
  applyBoardWorkerCallback: (
    token: string,
    outcome: 'success' | 'failure',
    body: Record<string, unknown>,
  ) => Promise<{ statusCode: number; body: unknown }>;

  handleSse: (req: RuntimeRequest, res: RuntimeResponse, clientId: string) => Promise<void>;
  handleChannelSubscription: (
    res: RuntimeResponse,
    clientId: string,
    channelName: string,
    params: { cardId?: string },
    subscribed: boolean,
  ) => void;

  createMcpFacade: () => McpFacadeLike;
  createMcpToolRegistry: (mcp: McpFacadeLike) => ToolRegistry;
  createMcpControlplaneToolRegistry: () => ToolRegistry;

  readCardFromStore: (cardId: string) => Promise<Record<string, unknown> | null>;
  patchCard: (cardId: string, patch: Record<string, unknown>) => Promise<void>;
  retriggerCard: (cardId: string) => Promise<void>;
  applyCardAction: (cardId: string, actionType: string, payload: Record<string, unknown> | null) => Promise<void>;
  resolveChatHandlerTarget: (cardId: string) => Promise<unknown>;

  chatStorePublic: ChatStorePublic;
  chatStorage: ChatStorageLike;
  sseHub: SseHub;

  uploadCardFile: (
    cardId: string,
    fileName: string,
    contentType: string,
    bytes: Uint8Array,
    opts?: { inChat?: boolean; turnId?: string },
  ) => Promise<unknown>;
  sendCardFileDownloadResponse: (
    res: RuntimeResponse,
    cardId: string,
    idx: number,
    expectedStoredName: string | null,
  ) => Promise<void>;
  resolveCardFileDownloadPayload: (
    cardId: string,
    idx: number,
    expectedStoredName: string | null,
  ) => Promise<{ fileRecord: CardFileRecord; bytes: Uint8Array }>;
  isLikelyTextMimeType: (mimeType: string) => boolean;
  sliceTextByLines: (text: string, mode: 'head' | 'tail', count: number) => string;
}

export interface RoutesRuntimeApi {
  handleRuntimeApi: (req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL) => Promise<boolean>;
}

export function createRoutesRuntimeApi(deps: RoutesRuntimeApiDeps): RoutesRuntimeApi {
  const {
    apiBasePath,
    boardContexts,
    json,
    readJsonBody,
    readRawBody,
    initBoardAndSetup,
    bootstrapBoard,
    buildPublishedRuntimePayload,
    publishPersistedStateSnapshot,
    upsertCardsFromSource,
    applyBoardWorkerCallback,
    handleSse,
    handleChannelSubscription,
    createMcpFacade,
    createMcpToolRegistry,
    createMcpControlplaneToolRegistry,
    readCardFromStore,
    patchCard,
    retriggerCard,
    applyCardAction,
    resolveChatHandlerTarget,
    chatStorePublic,
    chatStorage,
    sseHub,
    uploadCardFile,
    sendCardFileDownloadResponse,
    resolveCardFileDownloadPayload,
    isLikelyTextMimeType,
    sliceTextByLines,
  } = deps;

  async function handleRuntimeApi(req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL): Promise<boolean> {
    const method = req.method || 'GET';
    const url = parsedUrl;
    const p = url.pathname;

    try {
      if (method === 'GET' && p === `${apiBasePath}/init-board`) {
        await initBoardAndSetup();
        json(res, 200, await buildPublishedRuntimePayload());
        return true;
      }

      if (method === 'GET' && p === `${apiBasePath}/sse`) {
        await initBoardAndSetup();
        const clientId = String(url.searchParams.get('clientId') || '').trim();
        if (!clientId) {
          json(res, 400, { error: 'clientId query param is required for SSE' });
          return true;
        }
        await handleSse(req, res, clientId);
        for (let i = 0; i < boardContexts.length; i++) {
          await publishPersistedStateSnapshot(boardContexts[i]);
          await upsertCardsFromSource(boardContexts[i], i);
          await publishPersistedStateSnapshot(boardContexts[i]);
        }
        return true;
      }

      if (method === 'GET' && p === `${apiBasePath}/board-status`) {
        json(res, 200, await buildPublishedRuntimePayload());
        return true;
      }

      const boardWorkerCallbackMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/callback/board-worker/([^/]+)/(success|failure)$`));
      if (method === 'POST' && boardWorkerCallbackMatch) {
        await initBoardAndSetup();
        const token = decodeURIComponent(boardWorkerCallbackMatch[1]);
        const outcome = boardWorkerCallbackMatch[2] as 'success' | 'failure';
        const body = await readJsonBody(req);
        const callbackResult = await applyBoardWorkerCallback(token, outcome, body);
        json(res, callbackResult.statusCode, callbackResult.body);
        return true;
      }

      if (method === 'POST' && p === `${apiBasePath}/mcp`) {
        await bootstrapBoard();
        const body = await readJsonBody(req);
        const tool = typeof body.tool === 'string' ? body.tool.trim() : '';
        const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
          ? body.args as Record<string, unknown>
          : {};
        if (!tool) {
          json(res, 400, { error: 'tool is required' });
          return true;
        }
        if (tool === 'inspect.file-contents') {
          json(res, 400, { error: 'inspect.file-contents is only available on /mcp-raw' });
          return true;
        }
        try {
          const result = await invokeMcpTool(tool, args, createMcpToolRegistry(createMcpFacade()));
          if (result && typeof result === 'object' && !Array.isArray(result)) {
            const record = result as Record<string, unknown>;
            if (record.status === 'fail') {
              json(res, 400, { error: extractMcpFailureMessage(result, 'Request failed') });
              return true;
            }
            if (record.status === 'error') {
              json(res, 500, { error: extractMcpFailureMessage(result, 'Internal error') });
              return true;
            }
          }
          json(res, 200, result);
        } catch (error) {
          const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
            ? Number((error as { statusCode: number }).statusCode)
            : 500;
          const message = error instanceof Error ? error.message : String(error);
          json(res, statusCode, { error: message });
        }
        return true;
      }

      if (method === 'POST' && p === `${apiBasePath}/mcp-controlplane`) {
        await bootstrapBoard();
        const body = await readJsonBody(req);
        const tool = typeof body.tool === 'string' ? body.tool.trim() : '';
        const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
          ? body.args as Record<string, unknown>
          : {};
        if (!tool) {
          json(res, 400, { error: 'tool is required' });
          return true;
        }
        try {
          const result = await invokeMcpTool(tool, args, createMcpControlplaneToolRegistry());
          if (result && typeof result === 'object' && !Array.isArray(result)) {
            const record = result as Record<string, unknown>;
            if (record.status === 'fail') {
              json(res, 400, { error: extractMcpFailureMessage(result, 'Request failed') });
              return true;
            }
            if (record.status === 'error') {
              json(res, 500, { error: extractMcpFailureMessage(result, 'Internal error') });
              return true;
            }
          }
          json(res, 200, result);
        } catch (error) {
          const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
            ? Number((error as { statusCode: number }).statusCode)
            : 500;
          const message = error instanceof Error ? error.message : String(error);
          json(res, statusCode, { error: message });
        }
        return true;
      }

      if (method === 'POST' && p === `${apiBasePath}/mcp-raw`) {
        await bootstrapBoard();
        const body = await readJsonBody(req);
        const tool = typeof body.tool === 'string' ? body.tool.trim() : '';
        const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
          ? body.args as Record<string, unknown>
          : {};
        if (!tool) {
          json(res, 400, { error: 'tool is required' });
          return true;
        }
        if (tool !== 'inspect.file-contents') {
          json(res, 400, { error: `Tool does not support raw response: ${tool}` });
          return true;
        }
        const cardId = getMcpArgString(args, 'card_id', 'cardId');
        const fileIdx = getMcpArgNumber(args, 'file_idx', 'fileIdx');
        const headLines = getMcpArgNumber(args, 'head-lines', 'headLines');
        const tailLines = getMcpArgNumber(args, 'tail-lines', 'tailLines');
        const headBytes = getMcpArgNumber(args, 'head-bytes', 'headBytes');
        const tailBytes = getMcpArgNumber(args, 'tail-bytes', 'tailBytes');
        if (!cardId) {
          json(res, 400, { error: 'inspect.file-contents requires card_id' });
          return true;
        }
        if (fileIdx === undefined || !Number.isInteger(fileIdx) || fileIdx < 0) {
          json(res, 400, { error: 'inspect.file-contents requires file_idx to be a non-negative integer' });
          return true;
        }
        const rawModes = [headLines, tailLines, headBytes, tailBytes].filter((value) => value !== undefined);
        if (rawModes.length > 1) {
          json(res, 400, { error: 'inspect.file-contents accepts at most one of head-lines, tail-lines, head-bytes, tail-bytes' });
          return true;
        }
        for (const [name, value] of [['head-lines', headLines], ['tail-lines', tailLines], ['head-bytes', headBytes], ['tail-bytes', tailBytes]] as const) {
          if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
            json(res, 400, { error: `inspect.file-contents requires ${name} to be a non-negative integer` });
            return true;
          }
        }
        const descriptor = await createMcpFacade().inspectFileContents({ cardId, fileIdx }) as { stored_name?: unknown; mime_type?: unknown; name?: unknown };
        const expectedStoredName = typeof descriptor?.stored_name === 'string' ? descriptor.stored_name : null;
        const { fileRecord, bytes } = await resolveCardFileDownloadPayload(cardId, fileIdx, expectedStoredName);
        const filename = String(fileRecord.name || fileRecord.stored_name || 'download.bin');
        const mimeType = String(fileRecord.mime_type || 'application/octet-stream');
        const respMode = (url.searchParams.get('resp') || '').trim().toLowerCase();
        if (respMode && respMode !== 'json-b64') {
          json(res, 400, { error: `unsupported resp mode: ${respMode}` });
          return true;
        }
        const wantBase64 = respMode === 'json-b64';
        let outBytes: Uint8Array;
        if (headLines !== undefined || tailLines !== undefined) {
          if (!isLikelyTextMimeType(mimeType)) {
            json(res, 400, { error: 'head-lines/tail-lines are only supported for text-like files; use head-bytes/tail-bytes for binary content' });
            return true;
          }
          const text = new TextDecoder().decode(bytes);
          const slicedText = headLines !== undefined
            ? sliceTextByLines(text, 'head', headLines)
            : sliceTextByLines(text, 'tail', tailLines as number);
          outBytes = typeof Buffer !== 'undefined' ? Buffer.from(slicedText, 'utf8') : new TextEncoder().encode(slicedText);
        } else if (headBytes !== undefined || tailBytes !== undefined) {
          const count = (headBytes ?? tailBytes) as number;
          outBytes = headBytes !== undefined ? bytes.slice(0, count) : bytes.slice(Math.max(0, bytes.length - count));
        } else {
          outBytes = bytes;
        }
        if (wantBase64) {
          const bodyBase64 = typeof Buffer !== 'undefined'
            ? Buffer.from(outBytes).toString('base64')
            : btoa(String.fromCharCode(...outBytes));
          json(res, 200, { bodyBase64, mimeType, filename, byteLength: outBytes.length });
          return true;
        }
        res.writeHead(200, {
          'Content-Type': mimeType,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': outBytes.length,
        });
        res.end(outBytes as unknown as Buffer);
        return true;
      }

      const cardMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)$`));
      if (method === 'GET' && cardMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardMatch[1]);
        const card = await readCardFromStore(cardId);
        if (!card) { json(res, 404, { error: `card not found: ${cardId}` }); return true; }
        json(res, 200, card);
        return true;
      }

      if (method === 'PATCH' && cardMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardMatch[1]);
        const body = await readJsonBody(req);
        await patchCard(cardId, body);
        json(res, 200, { ok: true });
        return true;
      }

      const cardRetriggerMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/retrigger$`));
      if (method === 'POST' && cardRetriggerMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardRetriggerMatch[1]);
        await retriggerCard(cardId);
        json(res, 200, { ok: true });
        return true;
      }

      const cardActionMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/actions$`));
      if (method === 'POST' && cardActionMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardActionMatch[1]);
        const requestReceivedAtMs = Date.now();
        const requestReceivedAt = new Date(requestReceivedAtMs).toISOString();
        const body = await readJsonBody(req);
        const actionType = body?.actionType as string;
        if (actionType === 'chat-send' && !await resolveChatHandlerTarget(cardId)) {
          const responseSentAtMs = Date.now();
          json(res, 409, {
            error: `chat handler is not configured for card: ${cardId}`,
            requestReceivedAt,
            requestReceivedAtMs,
            responseSentAt: new Date(responseSentAtMs).toISOString(),
            responseSentAtMs,
            responseStatus: 409,
          });
          return true;
        }
        if (actionType === 'chat-send') {
          const pl = (body?.payload ?? {}) as Record<string, unknown>;
          const rawTurnId = typeof pl['turn-id'] === 'string'
            ? pl['turn-id']
            : typeof pl.turnId === 'string'
              ? pl.turnId
              : typeof pl.turn === 'string'
                ? pl.turn
                : '';
          if (!rawTurnId || !String(rawTurnId).trim()) {
            const responseSentAtMs = Date.now();
            json(res, 400, {
              error: `chat-send requires a non-empty 'turn-id' (or 'turnId'/'turn') in payload for card: ${cardId}`,
              requestReceivedAt,
              requestReceivedAtMs,
              responseSentAt: new Date(responseSentAtMs).toISOString(),
              responseSentAtMs,
              responseStatus: 400,
            });
            return true;
          }
        }
        await applyCardAction(cardId, actionType, body?.payload as Record<string, unknown> | null);
        const responseSentAtMs = Date.now();
        json(res, 200, {
          ok: true,
          requestReceivedAt,
          requestReceivedAtMs,
          responseSentAt: new Date(responseSentAtMs).toISOString(),
          responseSentAtMs,
          responseStatus: 200,
        });
        return true;
      }

      const cardChatsMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/chats$`));
      if (method === 'GET' && cardChatsMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardChatsMatch[1]);
        const turnId = String(url.searchParams.get('turn-id') || '');
        const allTurns = String(url.searchParams.get('all-turns') || '').toLowerCase() === 'true';
        const tailTurnsBeforeId = String(url.searchParams.get('tail-turns-before-id') || '');
        const lastUserTurnsRaw = url.searchParams.get('tail-turns');
        const lastUserTurns = lastUserTurnsRaw == null || lastUserTurnsRaw === ''
          ? (allTurns ? undefined : (turnId ? undefined : 1))
          : Number.parseInt(lastUserTurnsRaw, 10);
        const readResult = chatStorePublic.readAll({
          params: { cardId },
          body: {
            ...(lastUserTurns === undefined ? {} : { tailTurns: lastUserTurns }),
            ...(turnId ? { turnId } : {}),
            ...(allTurns ? { allTurns: true } : {}),
            ...(tailTurnsBeforeId ? { tailTurnsBeforeId } : {}),
          },
        });
        if (readResult.status !== 'success') {
          json(res, 400, { error: readResult.error || 'Failed to read chats' });
          return true;
        }
        const messages = readResult.data.records as unknown as Array<Record<string, unknown>>;
        json(res, 200, { ok: true, messages });
        return true;
      }

      if (method === 'POST' && cardChatsMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardChatsMatch[1]);
        const body = await readJsonBody(req);
        const role = typeof body?.role === 'string' ? body.role : 'assistant';
        const text = typeof body?.text === 'string' ? body.text : '';
        const files = Array.isArray(body?.files) ? body.files : [];
        const turn = typeof body?.turn === 'string'
          ? body.turn
          : typeof body?.['turn-id'] === 'string'
            ? body['turn-id']
            : typeof body?.turnId === 'string'
              ? body.turnId
              : '';
        const done = body?.done === true;
        const entryId = chatStorage.append(cardId, role, text, files, turn);
        if (done) chatStorage.setProcessing(cardId, false);
        json(res, 200, { ok: true, id: entryId });
        return true;
      }

      const cardChatsSubscribeMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/chats/subscribe-sse$`));
      if (method === 'POST' && cardChatsSubscribeMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardChatsSubscribeMatch[1]);
        const body = await readJsonBody(req);
        const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
        if (!clientId) { json(res, 400, { error: 'clientId is required' }); return true; }
        if (!sseHub.subscribeChat(clientId, cardId)) {
          json(res, 404, { error: `SSE client not connected: ${clientId}` });
          return true;
        }
        json(res, 200, { ok: true, clientId, cardId, subscribed: true });
        return true;
      }

      const cardChatsUnsubscribeMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/chats/unsubscribe-sse$`));
      if (method === 'POST' && cardChatsUnsubscribeMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardChatsUnsubscribeMatch[1]);
        const body = await readJsonBody(req);
        const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
        if (!clientId) { json(res, 400, { error: 'clientId is required' }); return true; }
        if (!sseHub.unsubscribeChat(clientId, cardId)) {
          json(res, 404, { error: `SSE client not connected: ${clientId}` });
          return true;
        }
        json(res, 200, { ok: true, clientId, cardId, subscribed: false });
        return true;
      }

      const boardWatchChannelMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/watch-channel/([^/]+)/(subscribe|unsubscribe)-sse$`));
      if (method === 'POST' && boardWatchChannelMatch) {
        await bootstrapBoard();
        const channelName = decodeURIComponent(boardWatchChannelMatch[1]);
        const subscribed = boardWatchChannelMatch[2] === 'subscribe';
        const body = await readJsonBody(req);
        const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
        if (!clientId) { json(res, 400, { error: 'clientId is required' }); return true; }
        handleChannelSubscription(res, clientId, channelName, {}, subscribed);
        return true;
      }

      const cardWatchChannelMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/watch-channel/([^/]+)/(subscribe|unsubscribe)-sse$`));
      if (method === 'POST' && cardWatchChannelMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardWatchChannelMatch[1]);
        const channelName = decodeURIComponent(cardWatchChannelMatch[2]);
        const subscribed = cardWatchChannelMatch[3] === 'subscribe';
        const body = await readJsonBody(req);
        const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
        if (!clientId) { json(res, 400, { error: 'clientId is required' }); return true; }
        handleChannelSubscription(res, clientId, channelName, { cardId }, subscribed);
        return true;
      }

      const cardFileMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/files$`));
      if (method === 'POST' && cardFileMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardFileMatch[1]);
        const inChat = String(url.searchParams.get('inChat') || '').toLowerCase() === 'true';
        const turnId = String(url.searchParams.get('turn-id') || '').trim();
        if (inChat && !turnId) {
          json(res, 400, {
            error: `file upload with inChat=true requires a non-empty 'turn-id' query parameter for card: ${cardId}`,
          });
          return true;
        }
        const encodedName = req.headers['x-file-name'];
        const contentType = String(req.headers['content-type'] || 'application/octet-stream');
        const rawName = Array.isArray(encodedName) ? encodedName[0] : encodedName;
        const requestedName = rawName ? decodeURIComponent(String(rawName)) : 'upload.bin';
        const body = await readRawBody(req);
        json(res, 200, await uploadCardFile(cardId, requestedName, contentType, body, { inChat, turnId }));
        return true;
      }

      const cardFileDownloadMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/files/(\\d+)$`));
      if (method === 'GET' && cardFileDownloadMatch) {
        const cardId = decodeURIComponent(cardFileDownloadMatch[1]);
        const idx = parseInt(cardFileDownloadMatch[2], 10);
        const expectedStoredName = url.searchParams.get('sn');
        await sendCardFileDownloadResponse(res, cardId, idx, expectedStoredName);
        return true;
      }

      return false;
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number })?.statusCode || 500;
      json(res, statusCode, { error: String((err as Error)?.message || err) });
      return true;
    }
  }

  return { handleRuntimeApi };
}
