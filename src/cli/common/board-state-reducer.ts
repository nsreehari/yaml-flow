/**
 * board-state-reducer — shared reactive state helpers for browser board shells.
 *
 * Used by browser board shells and transport clients.
 *
 * Pure functions; no side effects; no DOM/localStorage/fetch dependencies.
 */

// ============================================================================
// Types
// ============================================================================

export interface CardChatMessage {
  role: string;
  text: string;
  files?: unknown[];
}

export interface CardChatState {
  messages: CardChatMessage[];
  receiving: boolean;
  processing?: boolean;
}

export interface CardModel {
  id: string;
  card: unknown;
  card_data: unknown;
  requires: unknown;
  computed_values: unknown;
  runtime_state: unknown;
  card_chats: CardChatState | null;
}

export interface BoardState {
  payload: unknown;
  cardIds: string[];
  modelsById: Record<string, CardModel>;
}

export interface DeriveBoardStateOptions {
  includeCard?: (model: CardModel, sourceState: BoardState) => boolean;
  mapCard?: (model: CardModel, sourceState: BoardState) => CardModel;
  mapPayload?: (
    payload: unknown,
    context: { sourceState: BoardState; cardIds: string[]; modelsById: Record<string, CardModel> },
  ) => unknown;
}

export type SelectLiveCardModelFn = (payload: unknown, cardId: string) => CardModel;

// ============================================================================
// Helpers
// ============================================================================

function clone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

function stableEq<T>(prev: T, next: T): T {
  if (prev === next) return prev;
  try {
    if (JSON.stringify(prev) === JSON.stringify(next)) return prev;
  } catch (_) { /* ignore */ }
  return next;
}

function deepEqJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; }
}

function taskStatusToCardStatus(taskStatus: string | null | undefined): string {
  if (taskStatus === 'running' || taskStatus === 'in-progress') return 'loading';
  if (taskStatus === 'failed') return 'error';
  return 'fresh';
}

// ============================================================================
// buildBoardState — full rebuild from a runtime payload snapshot
// ============================================================================

export function buildBoardState(
  payload: unknown,
  prevState: BoardState | null,
  selectLiveCardModel: SelectLiveCardModelFn,
): BoardState {
  const p = payload as { cardDefinitions?: Array<{ id: string }> } | null;
  const cardDefs = (p && Array.isArray(p.cardDefinitions)) ? p.cardDefinitions : [];
  const cardIds = cardDefs.map((c) => c.id);
  const prevModels = (prevState && prevState.modelsById) || {};
  const modelsById: Record<string, CardModel> = {};

  for (const id of cardIds) {
    const fresh = selectLiveCardModel(payload, id);
    const prev = prevModels[id];
    if (!prev) {
      modelsById[id] = fresh;
      continue;
    }
    // Preserve previous card_chats when fresh payload has no concrete chat state
    const nextCardChats = (fresh as unknown as { card_chats?: CardChatState | null }).card_chats != null
      ? stableEq(prev.card_chats, (fresh as unknown as { card_chats?: CardChatState | null }).card_chats ?? null)
      : prev.card_chats ?? null;
    const stab: CardModel = {
      id: fresh.id,
      card:            stableEq(prev.card,            fresh.card),
      card_data:       stableEq(prev.card_data,       fresh.card_data),
      requires:        stableEq(prev.requires,        fresh.requires),
      computed_values: stableEq(prev.computed_values, fresh.computed_values),
      runtime_state:   stableEq(prev.runtime_state,   fresh.runtime_state),
      card_chats:      nextCardChats,
    };
    modelsById[id] = (
      stab.card            === prev.card &&
      stab.card_data       === prev.card_data &&
      stab.requires        === prev.requires &&
      stab.computed_values === prev.computed_values &&
      stab.runtime_state   === prev.runtime_state &&
      stab.card_chats      === prev.card_chats
    ) ? prev : stab;
  }

  return { payload, cardIds, modelsById };
}

export function deriveBoardState(
  sourceState: BoardState,
  options: DeriveBoardStateOptions = {},
): BoardState {
  if (!sourceState) return sourceState;

  const includeCard = typeof options.includeCard === 'function'
    ? options.includeCard
    : (() => true);
  const mapCard = typeof options.mapCard === 'function'
    ? options.mapCard
    : ((model: CardModel) => model);

  let changed = false;
  const cardIds: string[] = [];
  const modelsById: Record<string, CardModel> = {};

  for (const cardId of sourceState.cardIds) {
    const model = sourceState.modelsById[cardId];
    if (!model) {
      changed = true;
      continue;
    }
    if (!includeCard(model, sourceState)) {
      changed = true;
      continue;
    }
    const nextModel = mapCard(model, sourceState);
    if (!nextModel || nextModel.id !== cardId) {
      throw new Error(`deriveBoardState: mapped card must preserve id "${cardId}"`);
    }
    if (nextModel !== model) changed = true;
    cardIds.push(cardId);
    modelsById[cardId] = nextModel;
  }

  const payload = typeof options.mapPayload === 'function'
    ? options.mapPayload(sourceState.payload, { sourceState, cardIds, modelsById })
    : sourceState.payload;
  if (payload !== sourceState.payload) changed = true;

  if (!changed && cardIds.length === sourceState.cardIds.length) return sourceState;
  return { payload, cardIds, modelsById };
}

// ============================================================================
// applyNotification — incremental state reducer
// ============================================================================

export function applyNotification(
  prevState: BoardState,
  notifications: Array<{ kind: string; [key: string]: unknown }>,
  selectLiveCardModel: SelectLiveCardModelFn,
  getFullPayload: () => unknown,
): BoardState {
  if (!prevState || !Array.isArray(notifications) || notifications.length === 0) return prevState;

  let modelsById = prevState.modelsById;
  let cardIds = prevState.cardIds;
  let cloned = false;
  let changed = false;

  // Build token → [cardId, ...] map from current requires keys
  const consumersByToken: Record<string, string[]> = {};
  for (const cid of cardIds) {
    const m = modelsById[cid];
    const reqs = m && m.requires;
    if (reqs && typeof reqs === 'object') {
      for (const t of Object.keys(reqs as object)) {
        (consumersByToken[t] = consumersByToken[t] || []).push(cid);
      }
    }
  }

  function ensureClone() {
    if (!cloned) { modelsById = { ...modelsById }; cloned = true; }
  }

  for (const note of notifications) {
    if (!note || !note.kind) continue;

    if (note.kind === 'computed_values') {
      const cardId = note.cardId as string;
      const prev = modelsById[cardId];
      if (!prev) continue;
      const nextValues = (note.values || {}) as unknown;
      if (deepEqJson(prev.computed_values, nextValues)) continue;
      ensureClone();
      modelsById[cardId] = { ...prev, computed_values: nextValues };
      changed = true;

    } else if (note.kind === 'data_object') {
      const key = note.key as string;
      const notePayload = note.payload;
      const consumers = consumersByToken[key] || [];
      for (const cid of consumers) {
        const prevC = modelsById[cid];
        if (!prevC) continue;
        const prevReqs = (prevC.requires || {}) as Record<string, unknown>;
        if (deepEqJson(prevReqs[key], notePayload)) continue;
        ensureClone();
        modelsById[cid] = { ...prevC, requires: { ...prevReqs, [key]: notePayload } };
        changed = true;
      }

    } else if (note.kind === 'card_refreshed') {
      const cardId = note.cardId as string;
      let fresh: CardModel | null = null;
      const existing = modelsById[cardId];
      const noteCard = note.card;

      // Prefer authoritative card payload from notification to avoid stale
      // getFullPayload snapshots during server-runtime incremental updates.
      if (existing && noteCard && typeof noteCard === 'object' && !Array.isArray(noteCard)) {
        const cardObj = noteCard as Record<string, unknown>;
        const nextCardData = (
          cardObj.card_data && typeof cardObj.card_data === 'object' && !Array.isArray(cardObj.card_data)
        )
          ? cardObj.card_data
          : existing.card_data;
        const nextRequires = (
          cardObj.requires && typeof cardObj.requires === 'object' && !Array.isArray(cardObj.requires)
        )
          ? cardObj.requires
          : existing.requires;
        const nextComputedValues = (
          cardObj.computed_values && typeof cardObj.computed_values === 'object' && !Array.isArray(cardObj.computed_values)
        )
          ? cardObj.computed_values
          : existing.computed_values;
        const nextRuntimeState = (
          cardObj.runtime_state && typeof cardObj.runtime_state === 'object' && !Array.isArray(cardObj.runtime_state)
        )
          ? cardObj.runtime_state
          : existing.runtime_state;
        fresh = {
          ...existing,
          card: noteCard,
          card_data: nextCardData,
          requires: nextRequires,
          computed_values: nextComputedValues,
          runtime_state: nextRuntimeState,
        };
      }

      if (!fresh) {
        try {
          const fp = getFullPayload();
          if (fp) fresh = selectLiveCardModel(fp, cardId);
        } catch (_) { /* ignore */ }
      }

      if (!fresh) continue;
      if (existing &&
        deepEqJson(existing.card,            fresh.card) &&
        deepEqJson(existing.card_data,       fresh.card_data) &&
        deepEqJson(existing.requires,        fresh.requires) &&
        deepEqJson(existing.computed_values, fresh.computed_values) &&
        deepEqJson(existing.runtime_state,   fresh.runtime_state)) {
        continue;
      }
      ensureClone();
      modelsById[cardId] = fresh;
      if (!cardIds.includes(cardId)) cardIds = [...cardIds, cardId];
      changed = true;

    } else if (note.kind === 'card_removed') {
      const cardId = note.cardId as string;
      if (!modelsById[cardId]) continue;
      ensureClone();
      delete modelsById[cardId];
      cardIds = cardIds.filter((id) => id !== cardId);
      changed = true;

    } else if (note.kind === 'card_chats') {
      const cardId = note.cardId as string;
      const prev = modelsById[cardId];
      if (!prev) continue;
      const rawMessages = Array.isArray(note.messages)
        ? (note.messages as CardChatMessage[])
        : (prev.card_chats?.messages ?? []);
      const receiving = typeof note.receiving === 'boolean' ? note.receiving : (prev.card_chats?.receiving ?? false);
      const processing = typeof note.processing === 'boolean' ? note.processing : (prev.card_chats?.processing ?? false);
      const newCardChats: CardChatState = { messages: rawMessages, receiving, processing };
      if (deepEqJson(prev.card_chats, newCardChats)) continue;
      ensureClone();
      modelsById[cardId] = { ...prev, card_chats: newCardChats };
      changed = true;

    } else if (note.kind === 'chat_messages') {
      // chat_messages updates messages only, preserves receiving flag
      const cardId = note.cardId as string;
      const prev = modelsById[cardId];
      if (!prev) continue;
      const rawMessages = Array.isArray(note.messages) ? (note.messages as CardChatMessage[]) : [];
      const prevChats = prev.card_chats || { messages: [], receiving: false, processing: false };
      const newCardChats: CardChatState = { messages: rawMessages, receiving: prevChats.receiving, processing: !!prevChats.processing };
      if (deepEqJson(prev.card_chats, newCardChats)) continue;
      ensureClone();
      modelsById[cardId] = { ...prev, card_chats: newCardChats };
      changed = true;

    } else if (note.kind === 'status') {
      const statusCards = (note.status as { cards?: Array<{
        name?: string;
        status?: string;
        runtime?: { last_transition_at?: string | null };
        error?: { message?: string } | null;
        blocked_by?: string[];
        requires_missing?: string[];
      }> })?.cards ?? [];

      for (const statusCard of statusCards) {
        const sid = statusCard?.name;
        if (!sid || !modelsById[sid]) continue;
        const prevS = modelsById[sid];
        const nextCardStatus = taskStatusToCardStatus(statusCard.status);
        const nextCardData = {
          ...(prevS.card_data as object || {}),
          status: nextCardStatus,
          lastRun: statusCard.runtime?.last_transition_at ?? null,
          ...(statusCard.error?.message ? { error: statusCard.error.message } : {}),
        };
        // Remove error key if no error
        if (!statusCard.error?.message) {
          delete (nextCardData as { error?: string }).error;
        }
        const nextRuntimeState = {
          task_status:      statusCard.status ?? null,
          card_status:      nextCardStatus,
          runtime:          statusCard.runtime ? clone(statusCard.runtime) : {},
          error:            statusCard.error   ? clone(statusCard.error)   : null,
          blocked_by:       Array.isArray(statusCard.blocked_by)       ? clone(statusCard.blocked_by)       : [],
          requires_missing: Array.isArray(statusCard.requires_missing)  ? clone(statusCard.requires_missing) : [],
        };
        if (deepEqJson(prevS.card_data, nextCardData) && deepEqJson(prevS.runtime_state, nextRuntimeState)) continue;
        ensureClone();
        modelsById[sid] = { ...prevS, card_data: nextCardData, runtime_state: nextRuntimeState };
        changed = true;
      }
    }
  }

  if (!changed) return prevState;
  return { payload: prevState.payload, cardIds, modelsById };
}
