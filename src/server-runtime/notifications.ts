/**
 * server-runtime/notifications.ts
 *
 * Per-board notification accumulator state and the small set of pure helpers
 * that fold incoming runtime events into that state. Owned by the runtime
 * closure; no I/O.
 */

export interface NotificationState {
  status: unknown;
  computedValues: Record<string, unknown>;
  dataObjects: Record<string, unknown>;
  cards: Record<string, unknown>;
}

export function makeNotificationState(): NotificationState {
  return { status: null, computedValues: {}, dataObjects: {}, cards: {} };
}

export function hasNonEmptyCardCountStatus(status: unknown): boolean {
  if (!status || typeof status !== 'object') return false;
  const summary = (status as Record<string, unknown>).summary;
  if (!summary || typeof summary !== 'object') return false;
  return Number((summary as Record<string, unknown>).card_count || 0) > 0;
}

export function appendNotification(state: NotificationState, event: unknown): void {
  if (!event || typeof event !== 'object') return;
  const e = event as Record<string, unknown>;
  // Unpack notification-batch so individual items update state.*
  if (e.kind === 'notification-batch' && Array.isArray(e.notifications)) {
    for (const n of e.notifications) appendNotification(state, n);
    return;
  }
  if (e.kind === 'status') {
    // Ignore empty status snapshots (e.g. auxiliary contexts) so they do not
    // overwrite the primary board status.
    if (hasNonEmptyCardCountStatus(e.status)) state.status = e.status;
  }
  if (e.kind === 'computed_values' && e.cardId) state.computedValues[e.cardId as string] = e.values;
  if (e.kind === 'data_object' && e.key) state.dataObjects[e.key as string] = e.payload;
  if (e.kind === 'card_refreshed' && e.cardId) state.cards[e.cardId as string] = e.card;
  if (e.kind === 'card_removed' && e.cardId) {
    delete state.cards[e.cardId as string];
    delete state.computedValues[e.cardId as string];
  }
}
