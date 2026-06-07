import type { NotificationEmitter, QueueStorageNotification } from '../common/notification-interface.js';
import {
  withRuntimeNotificationBatchCategories,
  withRuntimeNotificationCategories,
} from '../common/notification-interface.js';
import type { QueueMessage } from '../common/storage-interface.js';
import type { AsyncQueueStorage } from './storage-async-interface.js';

export interface AsyncQueueStoragePublicOptions {
  emitNotification?: NotificationEmitter;
  lane?: string;
}

export interface AsyncQueueStoragePublic extends AsyncQueueStorage {}

async function findActiveMessageById(
  queue: Pick<AsyncQueueStorage, 'peekActive'>,
  messageId: string,
): Promise<QueueMessage<unknown> | undefined> {
  return (await queue.peekActive<unknown>()).find((message) => message.id === messageId);
}

export function createAsyncQueueStoragePublic(
  queue: AsyncQueueStorage,
  options: AsyncQueueStoragePublicOptions = {},
): AsyncQueueStoragePublic {
  async function emitQueueNotifications(notifications: QueueStorageNotification[]): Promise<void> {
    const emitNotification = options.emitNotification;
    if (!emitNotification || notifications.length === 0) return;
    const normalized = withRuntimeNotificationCategories(notifications);
    if (normalized.length === 1) {
      await emitNotification(normalized[0]);
      return;
    }
    await emitNotification(withRuntimeNotificationBatchCategories({ kind: 'notification-batch', notifications: normalized }));
  }

  return {
    async enqueue<T>(body: T): Promise<QueueMessage<T>> {
      const message = await queue.enqueue(body);
      await emitQueueNotifications([{ kind: 'message_enqueued', lane: options.lane, message }]);
      return message;
    },

    async enqueueMany<T>(bodies: T[]): Promise<QueueMessage<T>[]> {
      const messages = await queue.enqueueMany(bodies);
      await emitQueueNotifications(messages.map((message) => ({ kind: 'message_enqueued', lane: options.lane, message })));
      return messages;
    },

    enqueueIfAbsent: queue.enqueueIfAbsent
      ? async <T>(body: T, dedupKey: string): Promise<QueueMessage<T> | null> => {
          const message = await queue.enqueueIfAbsent!(body, dedupKey);
          if (message) {
            await emitQueueNotifications([{ kind: 'message_enqueued', lane: options.lane, message }]);
          }
          return message;
        }
      : undefined,

    lease<T>(leaseOptions?: { max?: number; visibilityMs?: number }) {
      return queue.lease<T>(leaseOptions);
    },

    ack(messageId: string, leaseToken: string): Promise<boolean> {
      return queue.ack(messageId, leaseToken);
    },

    nack(messageId: string, leaseToken: string, nackOptions?: { dead?: boolean; reason?: string }): Promise<boolean> {
      return queue.nack(messageId, leaseToken, nackOptions);
    },

    peekActive<T>(prefix?: string) {
      return queue.peekActive<T>(prefix);
    },

    peekDeadLetter<T>(prefix?: string) {
      return queue.peekDeadLetter<T>(prefix);
    },

    async stage<T>(body: T, stageOptions?: { dedupKey?: string }): Promise<QueueMessage<T> | null> {
      return queue.stage(body, stageOptions);
    },

    async commitStaged(messageId: string): Promise<boolean> {
      const committed = await queue.commitStaged(messageId);
      if (committed) {
        const message = await findActiveMessageById(queue, messageId);
        if (message) {
          await emitQueueNotifications([{ kind: 'message_enqueued', lane: options.lane, message }]);
        }
      }
      return committed;
    },

    async discardStaged(messageId: string, reason?: string): Promise<boolean> {
      return queue.discardStaged(messageId, reason);
    },

    peekStaged<T>(prefix?: string) {
      return queue.peekStaged<T>(prefix);
    },
  };
}