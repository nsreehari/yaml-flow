/**
 * notification-consumer
 *
 * Public browser-safe helpers for downstream notification consumers.
 * These helpers are safe for Vite/browser usage and avoid reaching into
 * internal cli/common paths.
 */

import type { RuntimeNotification } from '../cli/common/notification-interface.js';
import {
  isBoardChangeNotification,
  isChatScopedRuntimeNotification,
  isRuntimeNotificationBatch,
  notificationCategoryForKind,
  withRuntimeNotificationBatchCategories,
  withRuntimeNotificationCategories,
} from '../cli/common/notification-interface.js';

export type {
  BoardChangeNotification,
  BoardOutputNotification,
  CardStoreNotification,
  ChatStoreNotification,
  HostedRuntimeNotification,
  NotificationCategory,
  NotificationChatMessage,
  RuntimeNotification,
  RuntimeNotificationBatch,
} from '../cli/common/notification-interface.js';

export {
  isBoardChangeNotification,
  isChatScopedRuntimeNotification,
  isRuntimeNotificationBatch,
  notificationCategoryForKind,
  withRuntimeNotificationBatchCategories,
  withRuntimeNotificationCategories,
};

export function isRuntimeNotification(value: unknown): value is RuntimeNotification {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return typeof record.kind === 'string' && record.kind.length > 0 && record.kind !== 'notification-batch';
}

export function runtimeNotificationsFromPayload(payload: unknown): RuntimeNotification[] {
  if (isRuntimeNotificationBatch(payload)) return payload.notifications;
  return isRuntimeNotification(payload) ? [payload] : [];
}