import type { CommandInput, CommandResult } from '../common/board-live-cards-public.js';
import type { LiveCard } from '../common/board-live-cards-lib.js';
import {
  type CardStoreNotification,
  type NotificationEmitter,
  type RuntimeNotificationBatch,
  withRuntimeNotificationBatchCategories,
  withRuntimeNotificationCategories,
} from '../common/notification-interface.js';
import type { AsyncCardAdminStore } from './board-live-cards-storage-async.js';

export interface AsyncCardStorePublic {
  get(input: CommandInput): Promise<CommandResult<{ cards: LiveCard[] }>>;
  buildNotificationBatch(input: CommandInput): Promise<CommandResult<RuntimeNotificationBatch>>;
  set(input: CommandInput): Promise<CommandResult<{ count: number }>>;
  del(input: CommandInput): Promise<CommandResult<{ count: number }>>;
  patch(input: CommandInput): Promise<CommandResult<{ count: number }>>;
  appendFiles(input: CommandInput): Promise<CommandResult<{ files_added: Array<{ idx: number; entry: unknown }> }>>;
}

export interface AsyncCardStorePublicOptions {
  emitNotification?: NotificationEmitter;
}

export function createAsyncCardStorePublic(
  store: AsyncCardAdminStore,
  options: AsyncCardStorePublicOptions = {},
): AsyncCardStorePublic {
  function ok<T>(data: T): CommandResult<T> {
    return { status: 'success', data } as CommandResult<T>;
  }
  function fail<T>(error: string): CommandResult<T> {
    return { status: 'fail', error } as CommandResult<T>;
  }
  function oops<T>(e: unknown): CommandResult<T> {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) } as CommandResult<T>;
  }

  async function emitCardNotifications(notifications: CardStoreNotification[]): Promise<void> {
    const emitNotification = options.emitNotification;
    if (!emitNotification || notifications.length === 0) return;
    const normalized = withRuntimeNotificationCategories(notifications);
    if (normalized.length === 1) {
      await emitNotification(normalized[0]);
      return;
    }
    await emitNotification(withRuntimeNotificationBatchCategories({ kind: 'notification-batch', notifications: normalized }));
  }

  async function readCardsFromInput(input: CommandInput): Promise<LiveCard[]> {
    const id = input.params?.['id'] as string | undefined;
    if (id) {
      const card = await store.readCard(id);
      if (!card) throw new Error(`card "${id}" not found`);
      return [card];
    }
    return await store.readAllCards();
  }

  function buildCardRefreshedBatch(cards: LiveCard[]): RuntimeNotificationBatch {
    return withRuntimeNotificationBatchCategories({
      kind: 'notification-batch',
      notifications: withRuntimeNotificationCategories(cards.map((card) => ({
        kind: 'card_refreshed',
        cardId: card.id,
        card,
      }))),
    });
  }

  function normalizeFilesBody(body: unknown): LiveCard[] | null {
    if (Array.isArray(body)) return body as LiveCard[];
    if (body && typeof body === 'object') {
      const obj = body as { files?: unknown };
      if (Array.isArray(obj.files)) return obj.files as LiveCard[];
      return [body as LiveCard];
    }
    return null;
  }

  return {
    async get(input: CommandInput): Promise<CommandResult<{ cards: LiveCard[] }>> {
      try {
        return ok({ cards: await readCardsFromInput(input) });
      } catch (e) { return oops(e); }
    },

    async buildNotificationBatch(input: CommandInput): Promise<CommandResult<RuntimeNotificationBatch>> {
      try {
        return ok(buildCardRefreshedBatch(await readCardsFromInput(input)));
      } catch (e) { return oops(e); }
    },

    async set(input: CommandInput): Promise<CommandResult<{ count: number }>> {
      try {
        const body = input.body;
        if (body == null) return fail('set requires a body (card object or array of cards)');
        const cards: LiveCard[] = Array.isArray(body) ? body as LiveCard[] : [body as LiveCard];
        for (const card of cards) {
          if (typeof card.id !== 'string') {
            return fail('each card must have a string `id` field');
          }
          await store.writeCard(card.id, card);
        }
        await emitCardNotifications(cards.map((card) => ({ kind: 'card_refreshed', cardId: card.id, card })));
        return ok({ count: cards.length });
      } catch (e) { return oops(e); }
    },

    async del(input: CommandInput): Promise<CommandResult<{ count: number }>> {
      try {
        const bodyIds = (input.body as { ids?: string[] } | undefined)?.ids ?? [];
        const paramId = input.params?.['id'] as string | undefined;
        const ids = paramId ? [...bodyIds, paramId] : bodyIds;
        if (ids.length === 0) return fail('del requires body.ids (string[]) or params.id');
        for (const id of ids) await store.removeCard(id);
        await emitCardNotifications(ids.map((id) => ({ kind: 'card_removed', cardId: id })));
        return ok({ count: ids.length });
      } catch (e) { return oops(e); }
    },

    async patch(input: CommandInput): Promise<CommandResult<{ count: number }>> {
      try {
        const id = input.params?.['id'] as string | undefined;
        const jsonPath = input.params?.['path'] as string | undefined;
        if (!id) return fail('patch requires params.id');
        if (!jsonPath) return fail('patch requires params.path');

        const body = input.body as { value?: unknown } | undefined;
        const value = body && Object.prototype.hasOwnProperty.call(body, 'value')
          ? body.value
          : input.body;

        await store.patchCard(id, jsonPath, value);
        const card = await store.readCard(id);
        if (!card) return fail(`card "${id}" not found`);
        await emitCardNotifications([{ kind: 'card_refreshed', cardId: id, card }]);
        return ok({ count: 1 });
      } catch (e) { return oops(e); }
    },

    async appendFiles(input: CommandInput): Promise<CommandResult<{ files_added: Array<{ idx: number; entry: unknown }> }>> {
      try {
        const id = input.params?.['id'] as string | undefined;
        if (!id) return fail('appendFiles requires params.id');

        const card = await store.readCard(id);
        if (!card) return fail(`card "${id}" not found`);

        const files = normalizeFilesBody(input.body);
        if (!files || files.length === 0) {
          return fail('appendFiles requires a file metadata object, array, or body.files array');
        }

        const cardData = (card.card_data && typeof card.card_data === 'object' && !Array.isArray(card.card_data))
          ? card.card_data as Record<string, unknown>
          : {};
        const existingFiles = Array.isArray(cardData.files) ? cardData.files : [];
        const nextFiles = [...existingFiles, ...files];
        const filesAdded = files.map((entry, offset) => ({
          idx: existingFiles.length + offset,
          entry,
        }));

        const patchResult = await this.patch({ params: { id, path: 'card_data.files' }, body: { value: nextFiles } });
        if (patchResult.status !== 'success') return patchResult;
        return ok({ files_added: filesAdded });
      } catch (e) { return oops(e); }
    },
  };
}