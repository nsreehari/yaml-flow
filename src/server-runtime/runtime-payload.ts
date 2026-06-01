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

/** Minimum surface of the kv-storage handle used to read persisted status. */
interface KvStorageReader {
  read(key: string): unknown | Promise<unknown>;
}

/** Minimum surface of the board-platform adapter consumed by readStatusSnapshot. */
interface BoardAdapterForPayload {
  kvStorageForRef(ref: string): KvStorageReader;
}

/** Minimum surface of the board-ops handle consumed by payload readers. */
interface BoardOpsForPayload {
  getAllOutputsComputedValues(input: Record<string, unknown>): { status: string; data?: unknown } | Promise<{ status: string; data?: unknown }>;
  getAllOutputsDataObjects(input: Record<string, unknown>): { status: string; data?: unknown } | Promise<{ status: string; data?: unknown }>;
}

/** Subset of BoardContext consumed by runtime-payload readers. */
export interface RuntimePayloadBoardContext {
  boardOps: BoardOpsForPayload;
  boardAdapter: BoardAdapterForPayload;
  outputsStoreRef: string;
  notification: NotificationState;
}

export interface RuntimePayloadDeps {
  boardId: string;
  /** Live reference to the runtime's board-contexts array (read on each call). */
  boardContexts: ReadonlyArray<RuntimePayloadBoardContext>;
  readCardDefinitions: () => Promise<Array<Record<string, unknown>>>;
  readChatRecords: (cardId: string) => Array<Record<string, unknown>>;
  getChatProcessing: (cardId: string) => boolean;
}

export interface RuntimePayloadModule {
  readStatusSnapshot: () => Promise<unknown>;
  readCardRuntimeArtifacts: () => Promise<Record<string, unknown>>;
  readDataObjectsByToken: () => Promise<Record<string, unknown>>;
  buildPublishedRuntimePayload: () => Promise<unknown>;
}

export function createRuntimePayloadModule(deps: RuntimePayloadDeps): RuntimePayloadModule {
  const { boardId, boardContexts, readCardDefinitions, readChatRecords, getChatProcessing } = deps;

  async function readStatusSnapshot(): Promise<unknown> {
    const statuses = (await Promise.all(boardContexts.map(async (ctx) => {
      try {
        const kv = ctx.boardAdapter.kvStorageForRef(ctx.outputsStoreRef);
        const persisted = await Promise.resolve(kv.read('status'));
        if (persisted !== null && persisted !== undefined) return persisted;
      } catch {
        // Fall back to notification memory if direct KV read fails.
      }
      return ctx.notification.status;
    }))).filter(Boolean);
    if (statuses.length === 0) return null;
    if (statuses.length === 1) return statuses[0];

    // Merge multiple board statuses into a single snapshot
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

  async function readCardRuntimeArtifacts(): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    const process = async (ctx: RuntimePayloadBoardContext) => {
      try {
        const result = await ctx.boardOps.getAllOutputsComputedValues({});
        if (result.status === 'success' && result.data && typeof result.data === 'object') {
          for (const [cardId, values] of Object.entries(result.data as Record<string, unknown>)) {
            const card = ctx.notification.cards[cardId] as Record<string, unknown> | undefined;
            out[cardId] = {
              schema_version: 'v1',
              card_id: cardId,
              card_data: card?.card_data ?? {},
              computed_values: values ?? {},
            };
          }
          return;
        }
      } catch {
        // Fall back to notification memory below.
      }
      for (const [cardId, values] of Object.entries(ctx.notification.computedValues)) {
        const card = ctx.notification.cards[cardId] as Record<string, unknown> | undefined;
        out[cardId] = {
          schema_version: 'v1',
          card_id: cardId,
          card_data: card?.card_data ?? {},
          computed_values: values ?? {},
        };
      }
    };
    for (const ctx of boardContexts) await process(ctx);
    return out;
  }

  async function readDataObjectsByToken(): Promise<Record<string, unknown>> {
    const merged: Record<string, unknown> = {};
    for (const ctx of boardContexts) {
      try {
        const result = await ctx.boardOps.getAllOutputsDataObjects({});
        if (result.status === 'success' && result.data && typeof result.data === 'object') {
          Object.assign(merged, result.data as Record<string, unknown>);
          continue;
        }
      } catch {
        // Fall back to notification memory below.
      }
      Object.assign(merged, ctx.notification.dataObjects || {});
    }
    return merged;
  }

  async function buildPublishedRuntimePayload(): Promise<unknown> {
    const cardDefinitions = await readCardDefinitions();
    const rawArtifacts = await readCardRuntimeArtifacts();
    const dataObjectsByToken = await readDataObjectsByToken();
    const cardRuntimeById: Record<string, unknown> = {};

    for (const cardDef of cardDefinitions) {
      if (!cardDef?.id) continue;
      const id = cardDef.id as string;
      const raw = (rawArtifacts[id] || {}) as Record<string, unknown>;
      const cardData: Record<string, unknown> = {
        ...((raw.card_data && typeof raw.card_data === 'object' ? raw.card_data
          : cardDef.card_data && typeof cardDef.card_data === 'object' ? cardDef.card_data
            : {}) as Record<string, unknown>),
      };
      cardRuntimeById[id] = {
        schema_version: raw.schema_version || 'v1',
        card_id: raw.card_id || id,
        card_data: cardData,
        computed_values: raw.computed_values && typeof raw.computed_values === 'object' ? raw.computed_values : {},
      };
    }

    const cardChatsByCardId: Record<string, unknown> = {};
    for (const cardDef of cardDefinitions) {
      if (!cardDef?.id) continue;
      const id = cardDef.id as string;
      try {
        const records = readChatRecords(id);
        const processing = getChatProcessing(id);
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
