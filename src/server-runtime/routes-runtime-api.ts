/**
 * server-runtime/routes-runtime-api.ts  (controlface)
 *
 * Control-plane HTTP routes extracted from createSingleBoardServerRuntime.
 * Handles board lifecycle, card CRUD, chats, file upload/download, and
 * the MCP controlplane tool endpoint.
 *
 * The following routes live in sibling modules:
 *   routes-agentface.ts  — POST /mcp, /mcp-raw
 *   routes-webhooks.ts   — POST /callback/board-worker/:token/*
 *   routes-watchers.ts   — GET /sse + subscribe/unsubscribe endpoints
 */

import type { RuntimeRequest, RuntimeResponse } from './types.js';
import { escapeRegExp } from './internal-helpers.js';
import { invokeMcpTool, extractMcpFailureMessage } from './mcp-invoker.js';
import type { ToolRegistry } from './mcp-tool-registries.js';
import type { ChatStorePublic } from '../cli/common/chat-store-lib-public.js';

interface ChatStorageLike {
  append: (cardId: string, role: string, text: string, files: unknown[], turn: string) => string;
  setProcessing: (cardId: string, active: boolean) => void;
}

export interface RoutesRuntimeApiDeps {
  apiBasePath: string;

  json: (res: RuntimeResponse, status: number, payload: unknown) => void;
  readJsonBody: (req: RuntimeRequest) => Promise<Record<string, unknown>>;
  readRawBody: (req: RuntimeRequest) => Promise<Uint8Array>;

  initBoardAndSetup: () => Promise<void>;
  bootstrapBoard: () => Promise<void>;
  buildPublishedRuntimePayload: () => Promise<unknown>;

  createMcpControlplaneToolRegistry: () => ToolRegistry;

  readCardFromStore: (cardId: string) => Promise<Record<string, unknown> | null>;
  patchCard: (cardId: string, patch: Record<string, unknown>) => Promise<void>;
  retriggerCard: (cardId: string) => Promise<void>;
  applyCardAction: (cardId: string, actionType: string, payload: Record<string, unknown> | null) => Promise<void>;
  resolveChatHandlerTarget: (cardId: string) => Promise<unknown>;

  chatStorePublic: ChatStorePublic;
  chatStorage: ChatStorageLike;

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
}

export interface RoutesRuntimeApi {
  handleRuntimeApi: (req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL) => Promise<boolean>;
}

export function createRoutesRuntimeApi(deps: RoutesRuntimeApiDeps): RoutesRuntimeApi {
  const {
    apiBasePath,
    json,
    readJsonBody,
    readRawBody,
    initBoardAndSetup,
    bootstrapBoard,
    buildPublishedRuntimePayload,
    createMcpControlplaneToolRegistry,
    readCardFromStore,
    patchCard,
    retriggerCard,
    applyCardAction,
    resolveChatHandlerTarget,
    chatStorePublic,
    chatStorage,
    uploadCardFile,
    sendCardFileDownloadResponse,
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

      if (method === 'GET' && p === `${apiBasePath}/board-status`) {
        json(res, 200, await buildPublishedRuntimePayload());
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
