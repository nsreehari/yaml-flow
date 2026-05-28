/**
 * chat-store-lib-public.ts
 *
 * Platform-free public API for ChatStorage operations.
 *
 * Follows the same CommandInput / CommandResult convention as
 * card-store-lib-public.ts and artifacts-store-lib-public.ts.
 * No platform code here — inject a ChatStorage built from your platform adapter.
 *
 * Usage:
 *   import { createChatStorePublic } from './chat-store-lib-public.js';
 *   import { createFsBoardChatStorage } from '../node/fs-board-adapter.js';
 *
 *   const store = createChatStorePublic(createFsBoardChatStorage(parseRef(storeRef).value));
 *   const result = store.append({ params: { cardId: 'c1' }, body: { role: 'user', text: 'hello' } });
 *   const result = store.readAll({ params: { cardId: 'c1' } });
 *   const result = store.readAll({ params: { cardId: 'c1' }, body: { lastUserTurns: 5 } });
 *   const result = store.readAfter({ params: { cardId: 'c1', cursor: '<id>' } });
 *   const result = store.clear({ params: { cardId: 'c1' } });
 *   const result = store.setProcessing({ params: { cardId: 'c1' }, body: { active: true } });
 *   const result = store.isProcessing({ params: { cardId: 'c1' } });
 *   const result = store.getConfig({ params: { cardId: 'c1' } });
 *   const result = store.setConfig({ params: { cardId: 'c1' }, body: { systemPrompt: '...' } });
 */

import type { CommandInput, CommandResult } from './board-live-cards-public.js';
import type { ChatConfig, ChatRecord, ChatReadAfterResult, ChatStorage } from './chat-storage-lib.js';

export type ChatStoreCommandName =
  | 'append'
  | 'read-all'
  | 'read-after'
  | 'clear'
  | 'set-processing'
  | 'is-processing'
  | 'get-config'
  | 'set-config';

export type ChatStoreCommandEnvelope = {
  command: ChatStoreCommandName;
  cardId?: string;
  role?: unknown;
  text?: unknown;
  files?: unknown;
  turn?: unknown;
  lastUserTurns?: unknown;
  tailTurns?: unknown;
  turnId?: unknown;
  allTurns?: unknown;
  tailTurnsBeforeId?: unknown;
  cursor?: unknown;
  active?: unknown;
  [key: string]: unknown;
};

export type ChatStoreCommandBatchEnvelope = {
  cardId?: string;
  commands: ChatStoreCommandEnvelope[];
};

export type ChatStoreBatchResult = {
  results: Array<{ index: number; command: string; data?: unknown }>;
};

// ============================================================================
// ChatStorePublic — public interface
// ============================================================================

export interface ChatStorePublic {
  /**
   * Append a message to a card's chat history.
   * params.cardId: string
   * body.role: string
   * body.text: string
   * body.files?: unknown[]
   */
  append(input: CommandInput): CommandResult<{ id: string }>;

  /**
    * Read all messages for a card in insertion order.
   * params.cardId: string
    * body.lastUserTurns?: positive integer
   */
  readAll(input: CommandInput): CommandResult<{ records: ChatRecord[] }>;

  /**
   * Read messages appended after a cursor.
   * params.cardId: string
   * params.cursor?: string | null  (omit or null to read from the beginning)
   */
  readAfter(input: CommandInput): CommandResult<ChatReadAfterResult>;

  /**
   * Remove all messages for a card.
   * params.cardId: string
   */
  clear(input: CommandInput): CommandResult<{ ok: true }>;

  /**
   * Set or clear the processing flag for a card.
   * params.cardId: string
   * body.active: boolean
   */
  setProcessing(input: CommandInput): CommandResult<{ ok: true }>;

  /**
   * Check whether a card is currently processing.
   * params.cardId: string
   */
  isProcessing(input: CommandInput): CommandResult<{ active: boolean }>;

  /**
   * Read the chat config for a card.
   * params.cardId: string
   */
  getConfig(input: CommandInput): CommandResult<{ config: ChatConfig }>;

  /**
   * Patch (merge) the chat config for a card.
   * params.cardId: string
   * body: Partial<ChatConfig>  e.g. { systemPrompt: '...' }
   */
  setConfig(input: CommandInput): CommandResult<{ ok: true }>;

  /**
   * Run a single command envelope against this store instance.
   * The store is already bound to a backing adapter, so boardDir is not part
   * of the public contract here.
   */
  run(envelope: ChatStoreCommandEnvelope, label?: string): CommandResult<unknown>;

  /**
   * Run a sequence of command envelopes with optional top-level cardId default.
   * Stops on first non-success result and returns that failure/error.
   */
  runBatch(envelope: ChatStoreCommandBatchEnvelope): CommandResult<ChatStoreBatchResult>;
}

// ============================================================================
// createChatStorePublic — factory
// ============================================================================

export function createChatStorePublic(store: ChatStorage): ChatStorePublic {
  function parsePositiveInteger(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function sliceLastUserTurns(records: ChatRecord[], lastUserTurns: number): ChatRecord[] {
    let remainingUserTurns = lastUserTurns;
    for (let index = records.length - 1; index >= 0; index -= 1) {
      if (records[index]?.role !== 'user') continue;
      remainingUserTurns -= 1;
      if (remainingUserTurns === 0) return records.slice(index);
    }
    return records;
  }

  function hasAnyExplicitTurn(records: ChatRecord[]): boolean {
    return records.some((record) => typeof record?.turn === 'string' && record.turn !== '');
  }

  function sliceLastTurns(records: ChatRecord[], tailTurns: number): ChatRecord[] {
    if (tailTurns <= 0) return [];
    if (!hasAnyExplicitTurn(records)) return sliceLastUserTurns(records, tailTurns);

    const byTurn = new Map<string, ChatRecord[]>();
    const orderedTurns: string[] = [];
    for (const record of records) {
      const turn = typeof record?.turn === 'string' ? record.turn : '';
      if (!byTurn.has(turn)) {
        byTurn.set(turn, []);
        orderedTurns.push(turn);
      }
      byTurn.get(turn)!.push(record);
    }

    const selectedTurns = orderedTurns.slice(Math.max(0, orderedTurns.length - tailTurns));
    return selectedTurns.flatMap((turn) => byTurn.get(turn) ?? []);
  }

  function ok<T>(data: T): CommandResult<T> {
    return { status: 'success', data } as CommandResult<T>;
  }
  function fail<T>(error: string): CommandResult<T> {
    return { status: 'fail', error } as CommandResult<T>;
  }
  function oops<T>(e: unknown): CommandResult<T> {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) } as CommandResult<T>;
  }

  function run(envelope: ChatStoreCommandEnvelope, label = 'command envelope'): CommandResult<unknown> {
    const cardId = typeof envelope.cardId === 'string' ? envelope.cardId : undefined;
    if (!envelope.command) return fail(`chat-store: ${label} missing "command"`);
    if (!cardId) return fail(`chat-store: ${label} missing "cardId"`);

    if (envelope.command === 'append') {
      return api.append({
        params: { cardId },
        body: { role: envelope.role, text: envelope.text, files: envelope.files, turn: envelope.turn },
      });
    }
    if (envelope.command === 'read-all') {
      return api.readAll({
        params: { cardId },
        body: {
          lastUserTurns: envelope.lastUserTurns,
          tailTurns: envelope.tailTurns,
          turnId: envelope.turnId,
          allTurns: envelope.allTurns,
          tailTurnsBeforeId: envelope.tailTurnsBeforeId,
        },
      });
    }
    if (envelope.command === 'read-after') {
      return api.readAfter({ params: { cardId }, body: { cursor: envelope.cursor ?? null } });
    }
    if (envelope.command === 'clear') {
      return api.clear({ params: { cardId } });
    }
    if (envelope.command === 'set-processing') {
      return api.setProcessing({ params: { cardId }, body: { active: envelope.active } });
    }
    if (envelope.command === 'is-processing') {
      return api.isProcessing({ params: { cardId } });
    }
    if (envelope.command === 'get-config') {
      return api.getConfig({ params: { cardId } });
    }
    if (envelope.command === 'set-config') {
      const { command: _c, cardId: _i, ...patch } = envelope;
      return api.setConfig({ params: { cardId }, body: patch });
    }

    return fail(`chat-store: unknown command "${String(envelope.command)}"`);
  }

  function runBatch(envelope: ChatStoreCommandBatchEnvelope): CommandResult<ChatStoreBatchResult> {
    if (!Array.isArray(envelope.commands) || envelope.commands.length === 0) {
      return fail('chat-store: command envelope must include a non-empty "commands" array');
    }

    const results: ChatStoreBatchResult['results'] = [];
    for (let index = 0; index < envelope.commands.length; index += 1) {
      const item = envelope.commands[index];
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return fail(`chat-store: command envelope entry ${index} must be an object`);
      }
      const merged: ChatStoreCommandEnvelope = {
        cardId: envelope.cardId,
        ...item,
      };
      const result = run(merged, `command envelope entry ${index}`);
      if (result.status !== 'success') return result as CommandResult<ChatStoreBatchResult>;
      results.push({ index, command: String(merged.command), data: result.data });
    }

    return ok({ results });
  }

  const api: ChatStorePublic = {
    append(input: CommandInput): CommandResult<{ id: string }> {
      try {
        const cardId = input.params?.['cardId'] as string | undefined;
        if (!cardId) return fail('append requires params.cardId');
        const body = (input.body ?? {}) as Record<string, unknown>;
        const role = typeof body.role === 'string' ? body.role : '';
        const text = typeof body.text === 'string' ? body.text : '';
        const files = Array.isArray(body.files) ? body.files : [];
        const turn = typeof body.turn === 'string' ? body.turn : '';
        if (!role) return fail('append requires body.role');
        const id = store.append(cardId, role, text, files, turn);
        return ok({ id });
      } catch (e) { return oops(e); }
    },

    readAll(input: CommandInput): CommandResult<{ records: ChatRecord[] }> {
      try {
        const cardId = input.params?.['cardId'] as string | undefined;
        if (!cardId) return fail('readAll requires params.cardId');
        const body = (input.body ?? {}) as Record<string, unknown>;
        const turnId = typeof body.turnId === 'string' ? body.turnId : '';
        const allTurns = body.allTurns === true;
        const tailTurnsBeforeId = typeof body.tailTurnsBeforeId === 'string' ? body.tailTurnsBeforeId : '';
        const tailTurnsRaw = body.tailTurns === undefined ? body.lastUserTurns : body.tailTurns;
        const tailTurns = tailTurnsRaw === undefined
          ? (allTurns ? undefined : (turnId ? undefined : 1))
          : parsePositiveInteger(tailTurnsRaw);

        if (tailTurnsRaw !== undefined && tailTurns === null) {
          return fail('readAll requires body.tailTurns (positive integer)');
        }

        const records = store.readAll(cardId);
        let visible = records.filter((record) => !turnId || String(record.turn || '') === turnId);

        if (tailTurnsBeforeId) {
          const tailTurnsCount = tailTurns;
          if (typeof tailTurnsCount !== 'number' || !Number.isInteger(tailTurnsCount) || tailTurnsCount <= 0) {
            return fail('readAll requires body.tailTurns (positive integer) when body.tailTurnsBeforeId is provided');
          }

          const byTurn = new Map<string, ChatRecord[]>();
          const orderedTurns: string[] = [];
          for (const record of records) {
            const turn = String(record.turn || '');
            if (!byTurn.has(turn)) {
              byTurn.set(turn, []);
              orderedTurns.push(turn);
            }
            byTurn.get(turn)!.push(record);
          }

          const anchorIndex = orderedTurns.findIndex((value) => value === tailTurnsBeforeId);
          const sliceStart = Math.max(0, anchorIndex - tailTurnsCount);
          const selectedTurns = anchorIndex === -1 ? [] : orderedTurns.slice(sliceStart, anchorIndex);
          visible = selectedTurns.flatMap((turn) => byTurn.get(turn) ?? []);
          return ok({ records: visible });
        }

        if (typeof tailTurns === 'number') {
          return ok({ records: sliceLastTurns(visible, tailTurns) });
        }

        return ok({ records: visible });
      } catch (e) { return oops(e); }
    },

    readAfter(input: CommandInput): CommandResult<ChatReadAfterResult> {
      try {
        const cardId = input.params?.['cardId'] as string | undefined;
        if (!cardId) return fail('readAfter requires params.cardId');
        // cursor can be null (read from start) — read from body to avoid params type constraints
        const body = (input.body ?? {}) as Record<string, unknown>;
        const cursor = (body.cursor as string | null | undefined) ?? null;
        return ok(store.readAfter(cardId, cursor));
      } catch (e) { return oops(e); }
    },

    clear(input: CommandInput): CommandResult<{ ok: true }> {
      try {
        const cardId = input.params?.['cardId'] as string | undefined;
        if (!cardId) return fail('clear requires params.cardId');
        store.clear(cardId);
        return ok({ ok: true as const });
      } catch (e) { return oops(e); }
    },

    setProcessing(input: CommandInput): CommandResult<{ ok: true }> {
      try {
        const cardId = input.params?.['cardId'] as string | undefined;
        if (!cardId) return fail('setProcessing requires params.cardId');
        const body = (input.body ?? {}) as Record<string, unknown>;
        if (typeof body.active !== 'boolean') return fail('setProcessing requires body.active (boolean)');
        store.setProcessing(cardId, body.active);
        return ok({ ok: true as const });
      } catch (e) { return oops(e); }
    },

    isProcessing(input: CommandInput): CommandResult<{ active: boolean }> {
      try {
        const cardId = input.params?.['cardId'] as string | undefined;
        if (!cardId) return fail('isProcessing requires params.cardId');
        return ok({ active: store.isProcessing(cardId) });
      } catch (e) { return oops(e); }
    },

    getConfig(input: CommandInput): CommandResult<{ config: ChatConfig }> {
      try {
        const cardId = input.params?.['cardId'] as string | undefined;
        if (!cardId) return fail('getConfig requires params.cardId');
        return ok({ config: store.getConfig(cardId) });
      } catch (e) { return oops(e); }
    },

    setConfig(input: CommandInput): CommandResult<{ ok: true }> {
      try {
        const cardId = input.params?.['cardId'] as string | undefined;
        if (!cardId) return fail('setConfig requires params.cardId');
        const patch = (input.body ?? {}) as Partial<ChatConfig>;
        store.setConfig(cardId, patch);
        return ok({ ok: true as const });
      } catch (e) { return oops(e); }
    },

    run,
    runBatch,
  };

  return api;
}
