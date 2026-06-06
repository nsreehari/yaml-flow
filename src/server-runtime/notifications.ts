/**
 * server-runtime/notifications.ts
 *
 * Per-board notification accumulator state and the small set of pure helpers
 * that fold incoming runtime events into that state. Owned by the runtime
 * closure; no I/O.
 */

import type { RuntimeNotification, RuntimeNotificationBatch } from '../cli/common/notification-interface.js';
import { isRuntimeNotificationLike } from './runtime-notification-ingress.js';

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

function isRuntimeNotificationBatchLike(event: unknown): event is RuntimeNotificationBatch {
  if (!event || typeof event !== 'object') return false;
  const record = event as Record<string, unknown>;
  return record.kind === 'notification-batch' && Array.isArray(record.notifications);
}

function appendRuntimeNotification(state: NotificationState, event: RuntimeNotification): void {
  if (event.kind === 'status') {
    // Ignore empty status snapshots (e.g. auxiliary contexts) so they do not
    // overwrite the primary board status.
    if (hasNonEmptyCardCountStatus(event.status)) state.status = event.status;
    return;
  }
  if (event.kind === 'computed_values') {
    state.computedValues[event.cardId] = event.values;
    return;
  }
  if (event.kind === 'data_object') {
    state.dataObjects[event.key] = event.payload;
    return;
  }
  if (event.kind === 'card_refreshed') {
    state.cards[event.cardId] = event.card;
    return;
  }
  if (event.kind === 'card_removed') {
    delete state.cards[event.cardId];
    delete state.computedValues[event.cardId];
  }
}

export function appendNotification(state: NotificationState, event: unknown): void {
  // Unpack notification-batch so individual items update state.*
  if (isRuntimeNotificationBatchLike(event)) {
    for (const notification of event.notifications) {
      if (isRuntimeNotificationLike(notification)) appendRuntimeNotification(state, notification);
    }
    return;
  }
  if (isRuntimeNotificationLike(event)) appendRuntimeNotification(state, event);
}
