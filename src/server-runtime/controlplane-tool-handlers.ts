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

export interface ControlplaneToolHandlersDeps {
  boardId: string;
  /** Returns the live MCP facade (chat processing getters/setters). */
  getMcpFacade: () => {
    setChatProcessing: (args: { cardId: string; active: boolean }) => unknown;
    getChatProcessing: (args: { cardId: string }) => { active: boolean };
  };
  /** Returns the card-store facade used for meta reads/writes. */
  getMcpCardStoreFacade: () => BoardLiveCardsMcpCardStoreDeps;
}

export interface ControlplaneToolHandlers {
  requireCardArgs: (args: Record<string, unknown>) => { cardId: string };
  setChatProcessing: (
    args: Record<string, unknown>,
    active: boolean,
  ) => { status: 'success'; data: { boardId: string; cardId: string; active: boolean } };
  getChatProcessing: (
    args: Record<string, unknown>,
  ) => { status: 'success'; data: { boardId: string; cardId: string; active: boolean } };
  setCardMeta: (
    args: Record<string, unknown>,
  ) => Promise<{ status: 'success'; data: { boardId: string; cardId: string; key: string } }>;
  getCardMeta: (
    args: Record<string, unknown>,
  ) => Promise<{ status: 'success'; data: { boardId: string; cardId: string; key: string; exists: boolean; value: unknown } }>;
}

export function createControlplaneToolHandlers(deps: ControlplaneToolHandlersDeps): ControlplaneToolHandlers {
  const { boardId, getMcpFacade, getMcpCardStoreFacade } = deps;

  function requireCardArgs(args: Record<string, unknown>): { cardId: string } {
    const requestBoardId = getMcpArgString(args, 'board_id');
    const cardId = getMcpArgString(args, 'card_id');
    if (!requestBoardId) throw Object.assign(new Error('MCP tool requires board_id'), { statusCode: 400 });
    if (!cardId) throw Object.assign(new Error('MCP tool requires card_id'), { statusCode: 400 });
    if (requestBoardId !== boardId) throw Object.assign(new Error(`Unknown board_id: ${requestBoardId}`), { statusCode: 400 });
    return { cardId };
  }

  function setChatProcessing(args: Record<string, unknown>, active: boolean) {
    const { cardId } = requireCardArgs(args);
    getMcpFacade().setChatProcessing({ cardId, active });
    return { status: 'success' as const, data: { boardId, cardId, active } };
  }

  function getChatProcessing(args: Record<string, unknown>) {
    const { cardId } = requireCardArgs(args);
    const data = getMcpFacade().getChatProcessing({ cardId });
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

  return { requireCardArgs, setChatProcessing, getChatProcessing, setCardMeta, getCardMeta };
}
