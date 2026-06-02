/**
 * server-runtime/routes-runtime-api.ts  (controlface)
 *
 * Control-plane HTTP routes extracted from createSingleBoardServerRuntime.
 * Handles board lifecycle, card retrigger/actions, file download, and
 * the MCP controlplane tool endpoint.
 *
 * The following routes live in sibling modules:
 *   routes-agentface.ts  — POST /mcp, /mcp-raw
 *   routes-webhooks.ts   — POST /mcp-webhooks
 *   routes-watchers.ts   — GET /sse + subscribe/unsubscribe endpoints
 */

import type { RuntimeRequest, RuntimeResponse } from './types.js';
import { escapeRegExp } from './internal-helpers.js';
import { invokeMcpTool, extractMcpFailureMessage } from './mcp-invoker.js';
import type { ToolRegistry } from './mcp-tool-registries.js';
export interface RoutesRuntimeApiDeps {
  apiBasePath: string;

  json: (res: RuntimeResponse, status: number, payload: unknown) => void;
  readJsonBody: (req: RuntimeRequest) => Promise<Record<string, unknown>>;

  initBoardAndSetup: () => Promise<void>;
  bootstrapBoard: () => Promise<void>;
  buildPublishedRuntimePayload: () => Promise<unknown>;

  createMcpControlplaneToolRegistry: () => ToolRegistry;

  retriggerCard: (cardId: string) => Promise<void>;
  applyCardAction: (cardId: string, actionType: string, payload: Record<string, unknown> | null) => Promise<void>;
  resolveChatHandlerTarget: (cardId: string) => Promise<unknown>;
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
    initBoardAndSetup,
    bootstrapBoard,
    buildPublishedRuntimePayload,
    createMcpControlplaneToolRegistry,
    retriggerCard,
    applyCardAction,
    resolveChatHandlerTarget,
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
