/**
 * server-runtime/routes-watchers.ts
 *
 * All SSE connection and subscription management routes.
 * This is the sole owner of sseHub from a routing perspective.
 *
 *   GET  /sse                                             — open SSE stream
 *   POST /cards/:id/chats/(un)subscribe-sse               — chat subscription
 *   POST /watch-channel/:name/(un)subscribe-sse           — board channel
 *   POST /cards/:id/watch-channel/:name/(un)subscribe-sse — card channel
 *
 * Composes createRoutesSse for the SSE connection primitives and adds
 * the HTTP subscription management endpoints on top.
 */

import type { RuntimeRequest, RuntimeResponse } from './types.js';
import type { SseHub } from './sse-hub.js';
import { escapeRegExp } from './internal-helpers.js';
import { createRoutesSse } from './routes-sse.js';
import type { RoutesSseDeps } from './routes-sse.js';

export interface RoutesWatchersDeps extends RoutesSseDeps {
  apiBasePath: string;
  readJsonBody: (req: RuntimeRequest) => Promise<Record<string, unknown>>;
  initBoardAndSetup: () => Promise<void>;
  bootstrapBoard: () => Promise<void>;
  boardContexts: ReadonlyArray<unknown>;
  publishPersistedStateSnapshot: (ctx: unknown) => Promise<void>;
  upsertCardsFromSource: (ctx: unknown, ctxIndex: number) => Promise<void>;
}

export interface RoutesWatchers {
  /** Dispatch SSE + subscription routes. Returns true if the request was handled. */
  handleWatchersRoutes: (req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL) => Promise<boolean>;
  /** Open an SSE stream for a client (also used by the legacy handleRuntimeApi delegate). */
  handleSse: (req: RuntimeRequest, res: RuntimeResponse, clientId: string) => Promise<void>;
  /** Subscribe or unsubscribe a client from a named channel. */
  handleChannelSubscription: (
    res: RuntimeResponse,
    clientId: string,
    channelName: string,
    params: { cardId?: string },
    subscribed: boolean,
  ) => void;
}

export function createRoutesWatchers(deps: RoutesWatchersDeps): RoutesWatchers {
  const {
    apiBasePath,
    json,
    readJsonBody,
    initBoardAndSetup,
    bootstrapBoard,
    boardContexts,
    publishPersistedStateSnapshot,
    upsertCardsFromSource,
    sseHub,
  } = deps;

  const { handleSse, handleChannelSubscription } = createRoutesSse(deps);

  async function handleWatchersRoutes(req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL): Promise<boolean> {
    const method = req.method || 'GET';
    const url = parsedUrl;
    const p = url.pathname;

    try {
      // ── GET /sse ────────────────────────────────────────────────────────
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

      // ── POST /cards/:id/chats/(un)subscribe-sse ─────────────────────────
      const cardChatsSubscribeMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/cards/([^/]+)/chats/subscribe-sse$`));
      if (method === 'POST' && cardChatsSubscribeMatch) {
        await bootstrapBoard();
        const cardId = decodeURIComponent(cardChatsSubscribeMatch[1]);
        const body = await readJsonBody(req);
        const clientId = typeof body?.clientId === 'string' ? body.clientId.trim() : '';
        if (!clientId) { json(res, 400, { error: 'clientId is required' }); return true; }
        if (!(sseHub as SseHub).subscribeChat(clientId, cardId)) {
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
        if (!(sseHub as SseHub).unsubscribeChat(clientId, cardId)) {
          json(res, 404, { error: `SSE client not connected: ${clientId}` });
          return true;
        }
        json(res, 200, { ok: true, clientId, cardId, subscribed: false });
        return true;
      }

      // ── POST /watch-channel/:name/(un)subscribe-sse ─────────────────────
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

      // ── POST /cards/:id/watch-channel/:name/(un)subscribe-sse ────────────
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

      return false;
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number })?.statusCode || 500;
      json(res, statusCode, { error: String((err as Error)?.message || err) });
      return true;
    }
  }

  return { handleWatchersRoutes, handleSse, handleChannelSubscription };
}
