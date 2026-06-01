/**
 * server-runtime/mcp-facade.ts
 *
 * MCP facade wiring extracted from createSingleBoardServerRuntime.
 * Builds the four facade pieces used by the per-board MCP entry point:
 * - mcpBoardFacade        (board command surface used by MCP)
 * - mcpNonCoreFacade      (preflight / discovery surface)
 * - mcpCardStoreFacade    (card-store CRUD surface)
 * - createMcpFacade       (composes the above into BoardLiveCardsMcp)
 *
 * The facade reaches into many runtime closures (status snapshots,
 * data-object reads, card-store reads, lane drains, etc.). Those are
 * passed in as narrow callbacks so this module stays portable.
 */

import { createBoardLiveCardsMcp } from '../cli/common/board-live-cards-mcp.js';
import type {
  BoardLiveCardsMcp,
  BoardLiveCardsMcpBoardDeps,
  BoardLiveCardsMcpNonCoreDeps,
  BoardLiveCardsMcpCardStoreDeps,
} from '../cli/common/board-live-cards-mcp.js';
import type { LiveCard } from '../cli/common/board-live-cards-lib.js';
import { isAsyncBoardPlatformAdapter } from './internal-helpers.js';
import { parseRef } from '../cli/common/storage-interface.js';
import type { CommandResult } from '../cli/common/board-live-cards-public.js';

/** Subset of BoardContext consumed by the facade. */
export interface McpFacadeBoardContextLike {
  boardAdapter: unknown;
  boardOps: {
    getOutputsFetchedSources: (input: { params: { key: string } }) => Promise<CommandResult>;
    removeCard: (input: { params: { id: string } }) => Promise<CommandResult>;
    cardRefreshedNotify: (input: { params: { cardId: string } }) => Promise<CommandResult>;
    upsertCard: (input: { params: { cardId: string; restart: boolean } }) => Promise<CommandResult>;
  };
  cardStoreOps: {
    set: (input: { body: unknown }) => Promise<CommandResult>;
    del: (input: { params: { id: string } }) => Promise<CommandResult>;
    patch: (input: { params?: { id?: string; path?: string }; body?: unknown }) => Promise<CommandResult>;
    appendFiles: (input: { params?: { id?: string }; body?: unknown }) => Promise<CommandResult>;
  };
  nonCore: {
    describeTaskExecutorCapabilities: (input: unknown) => unknown;
    validateCardPreflight: (input: unknown) => unknown;
    evalCardCompute: (input: unknown) => unknown;
    probeSourcePreflight: (input: unknown) => unknown;
    runSourcePreflight: (input: unknown) => unknown;
    simulateCardCycle: (input: unknown) => unknown;
  } | null;
}

export interface McpFacadeDeps {
  boardContexts: ReadonlyArray<McpFacadeBoardContextLike>;
  cardOwnerIndex: Map<string, number>;
  cardContextForCard: (cardId: string) => McpFacadeBoardContextLike | null;
  readStatusSnapshot: () => Promise<unknown>;
  readDataObjectsByToken: () => Promise<Record<string, unknown>>;
  readCardRuntimeArtifacts: () => Promise<Record<string, unknown>>;
  readCardFromStore: (cardId: string) => Promise<Record<string, unknown> | null>;
  readCardDefinitions: () => Promise<unknown[]>;
  processAccumulatedLaneInternal: (skipInit?: boolean) => Promise<CommandResult>;
  uploadCardFile: (
    cardId: string,
    fileName: string,
    contentType: string,
    bytes: Uint8Array,
    opts?: { inChat?: boolean },
  ) => unknown | Promise<unknown>;
  chatStorePublic: Parameters<typeof createBoardLiveCardsMcp>[0]['chatStore'];
  serverUrl: string | null;
  apiBasePath: string;
}

export interface McpFacadeModule {
  mcpBoardFacade: () => BoardLiveCardsMcpBoardDeps;
  mcpNonCoreFacade: () => BoardLiveCardsMcpNonCoreDeps;
  mcpCardStoreFacade: () => BoardLiveCardsMcpCardStoreDeps;
  createMcpFacade: () => BoardLiveCardsMcp;
}

export function createMcpFacadeModule(deps: McpFacadeDeps): McpFacadeModule {
  const {
    boardContexts,
    cardOwnerIndex,
    cardContextForCard,
    readStatusSnapshot,
    readDataObjectsByToken,
    readCardRuntimeArtifacts,
    readCardFromStore,
    readCardDefinitions,
    processAccumulatedLaneInternal,
    uploadCardFile,
    chatStorePublic,
    serverUrl,
    apiBasePath,
  } = deps;

  function primaryContext(): McpFacadeBoardContextLike | null {
    return boardContexts[0] ?? null;
  }

  function mcpBoardFacade(): BoardLiveCardsMcpBoardDeps {
    return {
      async status() {
        const status = await readStatusSnapshot();
        return status == null
          ? { status: 'fail', error: 'Board status is unavailable' }
          : { status: 'success', data: status };
      },
      async getOutputsDataObject(input) {
        const key = input?.params?.key;
        if (!key) return { status: 'fail', error: 'getOutputsDataObject requires params.key' };
        const dataObjects = await readDataObjectsByToken();
        return { status: 'success', data: dataObjects[key] };
      },
      async getOutputsComputedValues(input) {
        const key = input?.params?.key;
        if (!key) return { status: 'fail', error: 'getOutputsComputedValues requires params.key' };
        const artifacts = await readCardRuntimeArtifacts();
        const entry = artifacts[key] as Record<string, unknown> | undefined;
        return { status: 'success', data: entry?.computed_values };
      },
      async getOutputsFetchedSources(input) {
        const key = input?.params?.key;
        if (!key) return { status: 'fail', error: 'getOutputsFetchedSources requires params.key' };
        const ctx = cardContextForCard(key) ?? primaryContext();
        if (!ctx) return { status: 'fail', error: 'Board context is unavailable' };
        return ctx.boardOps.getOutputsFetchedSources({ params: { key } });
      },
      async removeCard(input) {
        const id = input?.params?.id;
        if (!id) return { status: 'fail', error: 'removeCard requires params.id' };
        const ctx = cardContextForCard(id) ?? primaryContext();
        if (!ctx) return { status: 'fail', error: 'Board context is unavailable' };
        return ctx.boardOps.removeCard({ params: { id } });
      },
      async cardRefreshedNotify(input) {
        const cardId = input?.params?.cardId;
        if (!cardId) return { status: 'fail', error: 'cardRefreshedNotify requires params.cardId' };
        const ctx = cardContextForCard(cardId) ?? primaryContext();
        if (!ctx) return { status: 'fail', error: 'Board context is unavailable' };
        return ctx.boardOps.cardRefreshedNotify({ params: { cardId } });
      },
      async upsertCard(input) {
        const cardId = input?.params?.cardId;
        if (!cardId) return { status: 'fail', error: 'upsertCard requires params.cardId' };
        const ctx = cardContextForCard(cardId) ?? primaryContext();
        if (!ctx) return { status: 'fail', error: 'Board context is unavailable' };
        const result = await ctx.boardOps.upsertCard({ params: { cardId, restart: input.params.restart === true } });
        if (result.status !== 'success') return result;
        if (isAsyncBoardPlatformAdapter(ctx.boardAdapter as never)) {
          const drainResult = await processAccumulatedLaneInternal(true);
          if (drainResult.status !== 'success') return drainResult;
        }
        return result;
      },
    } as BoardLiveCardsMcpBoardDeps;
  }

  function mcpNonCoreFacade(): BoardLiveCardsMcpNonCoreDeps {
    const getNonCore = () => {
      const ctx = primaryContext();
      if (!ctx?.nonCore) throw new Error('Board non-core adapter is not configured for MCP preflight/discovery tools');
      return ctx.nonCore;
    };
    return {
      describeTaskExecutorCapabilities(input) { return getNonCore().describeTaskExecutorCapabilities(input); },
      validateCardPreflight(input) { return getNonCore().validateCardPreflight(input); },
      evalCardCompute(input) { return getNonCore().evalCardCompute(input); },
      probeSourcePreflight(input) { return getNonCore().probeSourcePreflight(input); },
      runSourcePreflight(input) { return getNonCore().runSourcePreflight(input); },
      simulateCardCycle(input) { return getNonCore().simulateCardCycle(input); },
    } as BoardLiveCardsMcpNonCoreDeps;
  }

  function mcpCardStoreFacade(): BoardLiveCardsMcpCardStoreDeps {
    return {
      async get(input) {
        const id = typeof input.params?.id === 'string' ? input.params.id : undefined;
        if (id) {
          const card = await readCardFromStore(id);
          if (!card) return { status: 'success', data: { cards: [] } };
          return { status: 'success', data: { cards: [card as LiveCard] } };
        }
        return { status: 'success', data: { cards: await readCardDefinitions() as LiveCard[] } };
      },
      async set(input) {
        const body = input.body;
        if (body == null) return { status: 'fail', error: 'set requires a body (card object or array of cards)' };
        const cards = Array.isArray(body) ? body : [body];
        for (const rawCard of cards) {
          const card = rawCard as Record<string, unknown>;
          const cardId = typeof card.id === 'string' ? card.id : '';
          if (!cardId) return { status: 'fail', error: 'each card must have a string `id` field' };
          const ctxIndex = cardOwnerIndex.get(cardId) ?? 0;
          const ctx = boardContexts[ctxIndex] ?? primaryContext();
          if (!ctx) return { status: 'fail', error: 'Board context is unavailable' };
          const setResult = await ctx.cardStoreOps.set({ body: card });
          if (setResult.status !== 'success') return setResult;
          cardOwnerIndex.set(cardId, ctxIndex);
        }
        return { status: 'success', data: { count: cards.length } };
      },
      async del(input) {
        const ids = [input.params?.id, ...(((input.body as { ids?: string[] } | undefined)?.ids) ?? [])].filter((id): id is string => typeof id === 'string' && !!id);
        if (ids.length === 0) return { status: 'fail', error: 'del requires body.ids (string[]) or params.id' };
        for (const id of ids) {
          const ctx = cardContextForCard(id) ?? primaryContext();
          if (!ctx) return { status: 'fail', error: 'Board context is unavailable' };
          const delResult = await ctx.cardStoreOps.del({ params: { id } });
          if (delResult.status !== 'success') return delResult;
          cardOwnerIndex.delete(id);
        }
        return { status: 'success', data: { count: ids.length } };
      },
      async patch(input) {
        const id = typeof input.params?.id === 'string' ? input.params.id : undefined;
        const path = typeof input.params?.path === 'string' ? input.params.path : undefined;
        if (!id || !path) return { status: 'fail', error: 'patch requires params.id and params.path' };
        const ctx = cardContextForCard(id) ?? primaryContext();
        if (!ctx) return { status: 'fail', error: 'Board context is unavailable' };
        return ctx.cardStoreOps.patch(input);
      },
      async appendFiles(input) {
        const id = typeof input.params?.id === 'string' ? input.params.id : undefined;
        if (!id) return { status: 'fail', error: 'appendFiles requires params.id' };
        const ctx = cardContextForCard(id) ?? primaryContext();
        if (!ctx) return { status: 'fail', error: 'Board context is unavailable' };
        return ctx.cardStoreOps.appendFiles(input);
      },
    } as BoardLiveCardsMcpCardStoreDeps;
  }

  function createMcpFacade(): BoardLiveCardsMcp {
    return createBoardLiveCardsMcp({
      board: mcpBoardFacade(),
      nonCore: mcpNonCoreFacade(),
      cardStore: mcpCardStoreFacade(),
      chatStore: chatStorePublic,
      uploadCardFile({ cardId, fileName, contentType, bytes }) {
          return uploadCardFile(cardId, fileName, contentType, bytes, { inChat: true }) as ReturnType<NonNullable<Parameters<typeof createBoardLiveCardsMcp>[0]['uploadCardFile']>>;
      },
      buildFileDownloadUrl({ cardId, fileIdx, storedName }) {
        const base = `${serverUrl || ''}${apiBasePath}/cards/${encodeURIComponent(cardId)}/files/${fileIdx}`;
        return storedName ? `${base}?sn=${encodeURIComponent(storedName)}` : base;
      },
      readFetchedSourceJsonByRef({ cardId, ref }) {
        const ctx = cardContextForCard(cardId) ?? primaryContext();
        if (!ctx) return null;
        if (isAsyncBoardPlatformAdapter(ctx.boardAdapter as never)) return null;
        const adapter = ctx.boardAdapter as { resolveBlob: (ref: unknown) => string };
        const text = adapter.resolveBlob(parseRef(ref));
        const trimmed = text.trim();
        return trimmed ? JSON.parse(trimmed) : null;
      },
    });
  }

  return { mcpBoardFacade, mcpNonCoreFacade, mcpCardStoreFacade, createMcpFacade };
}
