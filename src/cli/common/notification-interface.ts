/**
 * notification-interface.ts
 *
 * Neutral shared notification contracts used by board/public/runtime layers.
 * This file defines shapes only. It does not own routing, transport, or
 * persistence semantics.
 */

import type { LiveCard } from './board-live-cards-lib.js';
import type { QueueMessage } from './storage-interface.js';

export type NotificationCategory =
  | 'board-output'
  | 'card-store'
  | 'chat-store'
  | 'hosted-runtime'
  | 'queue-storage'
  | 'batch';

export interface NotificationChatMessage {
  role: string;
  text: string;
  files?: unknown[];
  turn?: string;
}

export type BoardOutputNotification =
  | { category?: 'board-output'; kind: 'computed_values'; cardId: string; values: Record<string, unknown> }
  | { category?: 'board-output'; kind: 'data_object'; key: string; payload: unknown }
  | { category?: 'board-output'; kind: 'status'; status: unknown };

export type CardStoreNotification =
  | { category?: 'card-store'; kind: 'card_refreshed'; cardId: string; card: LiveCard }
  | { category?: 'card-store'; kind: 'card_removed'; cardId: string };

export type ChatStoreNotification =
  | {
      category?: 'chat-store';
      kind: 'card_chats';
      cardId: string;
      sentAt?: string;
      sentAtMs?: number;
      messages: NotificationChatMessage[];
      receiving: boolean;
      processing?: boolean;
    }
  | {
      category?: 'chat-store';
      kind: 'chat_messages';
      cardId: string;
      messages: NotificationChatMessage[];
    };

export type HostedRuntimeNotification = {
  category?: 'hosted-runtime';
  kind: 'chat_processing';
  cardId: string;
  active: boolean;
  sentAtMs?: number;
};

export type QueueStorageNotification =
  | {
      category?: 'queue-storage';
      kind: 'message_enqueued';
      lane?: string;
      message: QueueMessage<unknown>;
    };

export type BoardChangeNotification = BoardOutputNotification | CardStoreNotification;

export type RuntimeNotification =
  | BoardOutputNotification
  | CardStoreNotification
  | ChatStoreNotification
  | HostedRuntimeNotification
  | QueueStorageNotification;

export type RuntimeNotificationBatch = {
  category?: 'batch';
  kind: 'notification-batch';
  notifications: RuntimeNotification[];
};

export type NotificationEmitter = (
  notification: RuntimeNotification | RuntimeNotificationBatch,
) => void | Promise<void>;

export function isRuntimeNotificationBatch(value: unknown): value is RuntimeNotificationBatch {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'notification-batch' && Array.isArray(record.notifications);
}

export function isBoardChangeNotification(notification: RuntimeNotification): notification is BoardChangeNotification {
  const category = notification.category ?? notificationCategoryForKind(notification.kind);
  return category === 'board-output' || category === 'card-store';
}

export function isChatScopedRuntimeNotification(notification: RuntimeNotification): notification is ChatStoreNotification | HostedRuntimeNotification {
  const category = notification.category ?? notificationCategoryForKind(notification.kind);
  return category === 'chat-store' || category === 'hosted-runtime';
}

export function notificationCategoryForKind(kind: RuntimeNotification['kind']): Exclude<NotificationCategory, 'batch'> {
  switch (kind) {
    case 'computed_values':
    case 'data_object':
    case 'status':
      return 'board-output';
    case 'card_refreshed':
    case 'card_removed':
      return 'card-store';
    case 'card_chats':
    case 'chat_messages':
      return 'chat-store';
    case 'chat_processing':
      return 'hosted-runtime';
    case 'message_enqueued':
      return 'queue-storage';
  }
}

export function withRuntimeNotificationCategory<T extends RuntimeNotification>(notification: T): T {
  if (notification.category) return notification;
  return {
    ...notification,
    category: notificationCategoryForKind(notification.kind),
  } as T;
}

export function withRuntimeNotificationCategories<T extends RuntimeNotification[]>(notifications: T): T {
  return notifications.map((notification) => withRuntimeNotificationCategory(notification)) as T;
}

export function withRuntimeNotificationBatchCategories(batch: RuntimeNotificationBatch): RuntimeNotificationBatch {
  return {
    ...batch,
    category: batch.category ?? 'batch',
    notifications: withRuntimeNotificationCategories(batch.notifications),
  };
}