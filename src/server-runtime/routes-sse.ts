/**
 * server-runtime/routes-sse.ts
 *
 * SSE connection lifecycle handler and channel-subscription endpoint
 * extracted from createSingleBoardServerRuntime. Both functions are
 * stateless wrappers around sseHub + the runtime payload aggregator;
 * factory takes narrow callbacks for everything else.
 */

import type { RuntimeRequest, RuntimeResponse } from './types.js';
import type { SseHub } from './sse-hub.js';

export interface RoutesSseDeps {
  sseHub: SseHub;
  corsHeaders: Record<string, string>;
  json: (res: RuntimeResponse, status: number, payload: unknown) => void;
  buildPublishedRuntimePayload: () => Promise<unknown>;
  onSseClientConnected?: (clientId: string, writeFrame: (payload: unknown) => void) => void;
  onChannelSubscribed?: (clientId: string, channelName: string, params: { cardId?: string }) => void;
  onChannelUnsubscribed?: (clientId: string, channelName: string, params: { cardId?: string }) => void;
}

export interface RoutesSse {
  handleChannelSubscription: (
    res: RuntimeResponse,
    clientId: string,
    channelName: string,
    params: { cardId?: string },
    subscribed: boolean,
  ) => void;
  handleSse: (
    req: RuntimeRequest,
    res: RuntimeResponse,
    clientId?: string,
    opts?: { oneShot?: boolean; bootstrapPayload?: boolean },
  ) => Promise<void>;
}

export function createRoutesSse(deps: RoutesSseDeps): RoutesSse {
  const {
    sseHub,
    corsHeaders,
    json,
    buildPublishedRuntimePayload,
    onSseClientConnected,
    onChannelSubscribed,
    onChannelUnsubscribed,
  } = deps;

  function handleChannelSubscription(
    res: RuntimeResponse,
    clientId: string,
    channelName: string,
    params: { cardId?: string },
    subscribed: boolean,
  ): void {
    if (!sseHub.has(clientId)) {
      json(res, 404, { error: `SSE client not connected: ${clientId}` });
      return;
    }
    if (subscribed) {
      sseHub.subscribeChannel(clientId, channelName, params.cardId);
      onChannelSubscribed?.(clientId, channelName, params);
    } else {
      sseHub.unsubscribeChannel(clientId, channelName, params.cardId);
      onChannelUnsubscribed?.(clientId, channelName, params);
    }
    json(res, 200, {
      ok: true,
      clientId,
      channelName,
      ...(params.cardId ? { cardId: params.cardId } : {}),
      subscribed,
    });
  }

  async function handleSse(
    req: RuntimeRequest,
    res: RuntimeResponse,
    clientId?: string,
    opts?: { oneShot?: boolean; bootstrapPayload?: boolean },
  ): Promise<void> {
    const oneShot = opts?.oneShot === true;
    const bootstrapPayload = opts?.bootstrapPayload !== false;
    const existing = !oneShot && clientId ? sseHub.get(clientId) : null;
    const subscribedChatCardIds = existing ? new Set(existing.subscribedChatCardIds) : new Set<string>();
    const subscribedChannelNames = existing ? new Set(existing.subscribedChannelNames) : new Set<string>();
    const subscribedCardChannels = existing
      ? new Map(Array.from(existing.subscribedCardChannels.entries(), ([cardId, channelSet]) => [cardId, new Set(channelSet)]))
      : new Map<string, Set<string>>();
    res.writeHead(200, {
      ...corsHeaders,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    sseHub.flushTransport(res);

    if (bootstrapPayload) {
      // On reconnect, Last-Event-ID tells us the client's last received id.
      // We always send the current full snapshot (replay = latest state).
      const payload = await buildPublishedRuntimePayload();
      const frame = sseHub.buildFrame(payload);
      res.write(frame);
    }

    if (oneShot) {
      res.end();
      return;
    }

    if (!clientId) {
      throw new Error('clientId is required for streaming SSE');
    }

    sseHub.register(clientId, res, { subscribedChatCardIds, subscribedChannelNames, subscribedCardChannels });
    try { onSseClientConnected?.(clientId, (customPayload: unknown) => { sseHub.writeFrame(clientId, customPayload); }); } catch { /* ignore host hook failures */ }

    const keepAlive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* ignore */ }
    }, 15_000);
    req.on('close', () => {
      clearInterval(keepAlive);
      sseHub.disconnect(clientId, res);
    });
  }

  return { handleChannelSubscription, handleSse };
}
