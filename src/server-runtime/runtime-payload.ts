/**
 * server-runtime/runtime-payload.ts
 *
 * Read-only aggregation of the per-runtime "published" payload that SSE
 * snapshots and the /board-status endpoint return. Pulled out of
 * createSingleBoardServerRuntime so the closure no longer has to host the
 * three readers (status, computed-values, data-objects) plus the published
 * payload assembler.
 *
 * Uses a structural board-context type with only the fields the readers need,
 * so this module doesn't pull in the heavy BoardContext interface from
 * index.ts.
 */

import type { NotificationState } from './notifications.js';
import type { BoardSseOneShotPayload } from '../cli/common/board-live-cards-public.js';

/** Minimum surface of the board-ops handle consumed by payload readers. */
interface BoardOpsForPayload {
  buildSseOneShotPayload(input: Record<string, unknown>): { status: string; data?: BoardSseOneShotPayload } | Promise<{ status: string; data?: BoardSseOneShotPayload }>;
}

/** Subset of BoardContext consumed by runtime-payload readers. */
export interface RuntimePayloadBoardContext {
  boardOps: BoardOpsForPayload;
  notification: NotificationState;
}

export interface RuntimePayloadDeps {
  boardId: string;
  /** Live reference to the runtime's board-contexts array (read on each call). */
  boardContexts: ReadonlyArray<RuntimePayloadBoardContext>;
  readChatRecords: (cardId: string) => Promise<Array<Record<string, unknown>>>;
  getChatProcessing: (cardId: string) => Promise<boolean>;
}

export interface RuntimePayloadModule {
  readStatusSnapshot: () => Promise<unknown>;
  readCardRuntimeArtifacts: () => Promise<Record<string, unknown>>;
  readDataObjectsByToken: () => Promise<Record<string, unknown>>;
  buildPublishedRuntimePayload: () => Promise<unknown>;
}

export function createRuntimePayloadModule(deps: RuntimePayloadDeps): RuntimePayloadModule {
  const { boardId, boardContexts, readChatRecords, getChatProcessing } = deps;

  function mergeStatusSnapshots(statuses: unknown[]): unknown {
    if (statuses.length === 0) return null;
    if (statuses.length === 1) return statuses[0];

    const mergedCards: unknown[] = [];
    const summaryKeys = ['completed', 'eligible', 'pending', 'blocked', 'unresolved', 'failed', 'in_progress', 'orphan_cards'];
    const totals: Record<string, number> = {};
    for (const k of summaryKeys) totals[k] = 0;

    for (const status of statuses) {
      const obj = status as Record<string, unknown>;
      const cards = Array.isArray(obj.cards) ? obj.cards : [];
      mergedCards.push(...cards);
      for (const k of summaryKeys) {
        totals[k] += Number((obj as { summary?: Record<string, unknown> })?.summary?.[k] || 0);
      }
    }

    const first = statuses[0] as Record<string, unknown>;
    return {
      ...first,
      cards: mergedCards,
      summary: {
        ...((first.summary || {}) as Record<string, unknown>),
        card_count: mergedCards.length,
        ...totals,
      },
    };
  }

  async function readBoardOneShotPayloads(): Promise<BoardSseOneShotPayload[]> {
    const payloads: BoardSseOneShotPayload[] = [];
    for (const ctx of boardContexts) {
      try {
        const result = await ctx.boardOps.buildSseOneShotPayload({});
        if (result.status === 'success' && result.data) payloads.push(result.data);
      } catch {
        // Aggregate readers will fall back to notification memory if needed.
      }
    }
    return payloads;
  }

  async function readStatusSnapshot(): Promise<unknown> {
    const payloads = await readBoardOneShotPayloads();
    const statuses = payloads.map((payload) => payload.statusSnapshot).filter(Boolean);
    if (statuses.length === 0) {
      const fallbackStatuses = boardContexts.map((ctx) => ctx.notification.status).filter(Boolean);
      return mergeStatusSnapshots(fallbackStatuses);
    }
    return mergeStatusSnapshots(statuses);
  }

  async function readCardRuntimeArtifacts(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const payloads = await readBoardOneShotPayloads();
    for (const payload of payloads) Object.assign(out, payload.cardRuntimeById || {});
    if (Object.keys(out).length > 0) return out;
    for (const ctx of boardContexts) {
      for (const [cardId, values] of Object.entries(ctx.notification.computedValues)) {
        const card = ctx.notification.cards[cardId] as Record<string, unknown> | undefined;
        out[cardId] = {
          schema_version: 'v1',
          card_id: cardId,
          card_data: card?.card_data ?? {},
          computed_values: values ?? {},
        };
      }
    }
    return out;
  }

  async function readDataObjectsByToken(): Promise<Record<string, unknown>> {
    const merged: Record<string, unknown> = {};
    const payloads = await readBoardOneShotPayloads();
    for (const payload of payloads) Object.assign(merged, payload.dataObjectsByToken || {});
    if (Object.keys(merged).length === 0) {
      for (const ctx of boardContexts) Object.assign(merged, ctx.notification.dataObjects || {});
    }
    return merged;
  }

  async function buildPublishedRuntimePayload(): Promise<unknown> {
    const payloads = await readBoardOneShotPayloads();
    const cardDefinitions = payloads.flatMap((payload) => Array.isArray(payload.cardDefinitions) ? payload.cardDefinitions : []);
    const dataObjectsByToken: Record<string, unknown> = {};
    const cardRuntimeById: Record<string, unknown> = {};
    for (const payload of payloads) {
      Object.assign(dataObjectsByToken, payload.dataObjectsByToken || {});
      Object.assign(cardRuntimeById, payload.cardRuntimeById || {});
    }

    const cardChatsByCardId: Record<string, unknown> = {};
    for (const cardDef of cardDefinitions) {
      if (!cardDef?.id) continue;
      const id = cardDef.id as string;
      try {
        const records = await readChatRecords(id);
        const processing = await getChatProcessing(id);
        if (records.length > 0 || processing) {
          cardChatsByCardId[id] = {
            messages: records.map((r) => ({
              role: String(r.role || 'system'),
              text: String(r.text || ''),
              files: Array.isArray(r.files) ? r.files : [],
            })),
            receiving: false,
            processing,
          };
        }
      } catch { /* ignore errors reading chat records for this card */ }
    }

    return {
      boardId,
      cardDefinitions,
      statusSnapshot: await readStatusSnapshot(),
      dataObjectsByToken,
      cardRuntimeById,
      cardChatsByCardId,
    };
  }

  return {
    readStatusSnapshot,
    readCardRuntimeArtifacts,
    readDataObjectsByToken,
    buildPublishedRuntimePayload,
  };
}
