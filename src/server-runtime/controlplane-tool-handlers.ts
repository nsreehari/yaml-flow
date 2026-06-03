/**
 * server-runtime/controlplane-tool-handlers.ts
 *
 * Handlers for the small "controlplane" MCP tools that read/write chat
 * processing state and per-card meta. Each handler validates `board_id`
 * against the runtime's own boardId, requires `card_id`, then delegates to
 * the MCP facade or card-store facade supplied by the host runtime.
 *
 * The handlers are factored out of createSingleBoardServerRuntime so that
 * createMcpControlplaneToolRegistry in index.ts can simply wire them up,
 * keeping the closure free of repetitive arg-validation noise.
 */

import { getMcpArgString } from './mcp-args.js';
import {
  expectControlplaneSuccess,
  expectControlplaneSuccessAsync,
  getCardMetaKey,
  readCardMetaValue,
} from './controlplane-helpers.js';
import type { BoardLiveCardsMcpCardStoreDeps } from '../cli/common/board-live-cards-mcp.js';
import type { SseHub } from './sse-hub.js';

export interface ControlplaneToolHandlersDeps {
  boardId: string;
  bootstrapBoard: () => Promise<void>;
  sseHub: Pick<SseHub, 'has' | 'subscribeChat' | 'unsubscribeChat'>;
  onChannelSubscribed?: (clientId: string, channelName: string, params: { cardId?: string }) => void;
  onChannelUnsubscribed?: (clientId: string, channelName: string, params: { cardId?: string }) => void;
  /** Returns the live MCP facade (chat processing getters/setters). */
  getMcpFacade: () => {
    setChatProcessing: (args: { cardId: string; active: boolean }) => Promise<{ active: boolean }>;
    getChatProcessing: (args: { cardId: string }) => Promise<{ active: boolean }>;
  };
  /** Returns the card-store facade used for meta reads/writes. */
  getMcpCardStoreFacade: () => BoardLiveCardsMcpCardStoreDeps;
}

export interface ControlplaneToolHandlers {
  requireCardArgs: (args: Record<string, unknown>) => { cardId: string };
  subscribeChat: (
    args: Record<string, unknown>,
  ) => Promise<{ status: 'success'; data: { boardId: string; cardId: string; clientId: string; subscribed: boolean } }>;
  unsubscribeChat: (
    args: Record<string, unknown>,
  ) => Promise<{ status: 'success'; data: { boardId: string; cardId: string; clientId: string; subscribed: boolean } }>;
  watchChannel: (
    args: Record<string, unknown>,
    subscribed: boolean,
  ) => Promise<{ status: 'success'; data: { boardId: string; clientId: string; channelName: string; subscribed: boolean; cardId?: string } }>;
  setChatProcessing: (
    args: Record<string, unknown>,
    active: boolean,
  ) => Promise<{ status: 'success'; data: { boardId: string; cardId: string; active: boolean } }>;
  getChatProcessing: (
    args: Record<string, unknown>,
  ) => Promise<{ status: 'success'; data: { boardId: string; cardId: string; active: boolean } }>;
  setCardMeta: (
    args: Record<string, unknown>,
  ) => Promise<{ status: 'success'; data: { boardId: string; cardId: string; key: string } }>;
  getCardMeta: (
    args: Record<string, unknown>,
  ) => Promise<{ status: 'success'; data: { boardId: string; cardId: string; key: string; exists: boolean; value: unknown } }>;
}

export function createControlplaneToolHandlers(deps: ControlplaneToolHandlersDeps): ControlplaneToolHandlers {
  const {
    boardId,
    bootstrapBoard,
    sseHub,
    onChannelSubscribed,
    onChannelUnsubscribed,
    getMcpFacade,
    getMcpCardStoreFacade,
  } = deps;

  function requireBoardId(args: Record<string, unknown>): void {
    const requestBoardId = getMcpArgString(args, 'board_id');
    if (!requestBoardId) throw Object.assign(new Error('MCP tool requires board_id'), { statusCode: 400 });
    if (requestBoardId !== boardId) throw Object.assign(new Error(`Unknown board_id: ${requestBoardId}`), { statusCode: 400 });
  }

  function requireClientId(args: Record<string, unknown>): string {
    const clientId = getMcpArgString(args, 'client_id');
    if (!clientId) throw Object.assign(new Error('MCP tool requires client_id'), { statusCode: 400 });
    return clientId;
  }

  function requireChannelArgs(args: Record<string, unknown>): { clientId: string; channelName: string; cardId?: string } {
    requireBoardId(args);
    const clientId = requireClientId(args);
    const channelName = getMcpArgString(args, 'channel_name');
    const cardId = getMcpArgString(args, 'card_id') || undefined;
    if (!channelName) throw Object.assign(new Error('MCP tool requires channel_name'), { statusCode: 400 });
    return { clientId, channelName, ...(cardId ? { cardId } : {}) };
  }

  function requireCardArgs(args: Record<string, unknown>): { cardId: string } {
    requireBoardId(args);
    const cardId = getMcpArgString(args, 'card_id');
    if (!cardId) throw Object.assign(new Error('MCP tool requires card_id'), { statusCode: 400 });
    return { cardId };
  }

  async function subscribeChat(args: Record<string, unknown>) {
    await bootstrapBoard();
    const { cardId } = requireCardArgs(args);
    const clientId = requireClientId(args);
    if (!await sseHub.subscribeChat(clientId, cardId)) {
      throw Object.assign(new Error(`SSE client not connected: ${clientId}`), { statusCode: 404 });
    }
    return { status: 'success' as const, data: { boardId, cardId, clientId, subscribed: true } };
  }

  async function unsubscribeChat(args: Record<string, unknown>) {
    await bootstrapBoard();
    const { cardId } = requireCardArgs(args);
    const clientId = requireClientId(args);
    if (!sseHub.unsubscribeChat(clientId, cardId)) {
      throw Object.assign(new Error(`SSE client not connected: ${clientId}`), { statusCode: 404 });
    }
    return { status: 'success' as const, data: { boardId, cardId, clientId, subscribed: false } };
  }

  async function watchChannel(args: Record<string, unknown>, subscribed: boolean) {
    await bootstrapBoard();
    const { clientId, channelName, cardId } = requireChannelArgs(args);
    if (!sseHub.has(clientId)) {
      throw Object.assign(new Error(`SSE client not connected: ${clientId}`), { statusCode: 404 });
    }
    if (subscribed) {
      onChannelSubscribed?.(clientId, channelName, cardId ? { cardId } : {});
    } else {
      onChannelUnsubscribed?.(clientId, channelName, cardId ? { cardId } : {});
    }
    return {
      status: 'success' as const,
      data: {
        boardId,
        clientId,
        channelName,
        subscribed,
        ...(cardId ? { cardId } : {}),
      },
    };
  }

  async function setChatProcessing(args: Record<string, unknown>, active: boolean) {
    const { cardId } = requireCardArgs(args);
    await getMcpFacade().setChatProcessing({ cardId, active });
    return { status: 'success' as const, data: { boardId, cardId, active } };
  }

  async function getChatProcessing(args: Record<string, unknown>) {
    const { cardId } = requireCardArgs(args);
    const data = await getMcpFacade().getChatProcessing({ cardId });
    return { status: 'success' as const, data: { boardId, cardId, active: data.active } };
  }

  async function setCardMeta(args: Record<string, unknown>) {
    const { cardId } = requireCardArgs(args);
    const key = getCardMetaKey(args);
    if (!Object.prototype.hasOwnProperty.call(args, 'value')) throw Object.assign(new Error('MCP tool requires value'), { statusCode: 400 });
    if (key.split('.').includes('visible_controlplane_only')) {
      // Allow the key through only if the value matches the card's current visible_controlplane_only flag
      // (idempotent round-trip: client read the full private state, re-submits values, flag value unchanged).
      const existing = await expectControlplaneSuccessAsync<{ cards?: unknown[] }>(
        getMcpCardStoreFacade().get({ params: { id: cardId } }),
        'cardStore.get',
      );
      const card = Array.isArray(existing.cards) && existing.cards.length > 0 && typeof existing.cards[0] === 'object' && !Array.isArray(existing.cards[0])
        ? existing.cards[0] as Record<string, unknown>
        : null;
      const currentFlag = card ? readCardMetaValue(card, 'visible_controlplane_only').value : undefined;
      if (args.value !== currentFlag) {
        throw Object.assign(new Error('MCP tool cannot change the reserved private flag visible_controlplane_only'), { statusCode: 403 });
      }
      return { status: 'success' as const, data: { boardId, cardId, key } };
    }
    expectControlplaneSuccess(await getMcpCardStoreFacade().patch({
      params: { id: cardId, path: `__private.${key}` },
      body: { value: args.value },
    }), 'cardStore.patch');
    return { status: 'success' as const, data: { boardId, cardId, key } };
  }

  async function getCardMeta(args: Record<string, unknown>) {
    const { cardId } = requireCardArgs(args);
    const key = getCardMetaKey(args);
    const result = await expectControlplaneSuccessAsync<{ cards?: unknown[] }>(
      getMcpCardStoreFacade().get({ params: { id: cardId } }),
      'cardStore.get',
    );
    const card = Array.isArray(result.cards) && result.cards.length > 0 && result.cards[0] && typeof result.cards[0] === 'object' && !Array.isArray(result.cards[0])
      ? result.cards[0] as Record<string, unknown>
      : null;
    if (!card) throw Object.assign(new Error(`Card "${cardId}" not found`), { statusCode: 404 });
    const metaValue = readCardMetaValue(card, key);
    return { status: 'success' as const, data: { boardId, cardId, key, exists: metaValue.exists, value: metaValue.value } };
  }

  return { requireCardArgs, subscribeChat, unsubscribeChat, watchChannel, setChatProcessing, getChatProcessing, setCardMeta, getCardMeta };
}
