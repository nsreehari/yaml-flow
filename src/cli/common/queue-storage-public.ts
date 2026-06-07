import type { NotificationEmitter, QueueStorageNotification } from './notification-interface.js';
import {
  withRuntimeNotificationBatchCategories,
  withRuntimeNotificationCategories,
} from './notification-interface.js';
import type { QueueMessage, QueueStorage } from './storage-interface.js';

export interface QueueStoragePublicOptions {
  emitNotification?: NotificationEmitter;
  lane?: string;
}

export interface QueueStoragePublic extends QueueStorage {}

function findActiveMessageById(queue: Pick<QueueStorage, 'peekActive'>, messageId: string): QueueMessage<unknown> | undefined {
  return queue.peekActive<unknown>().find((message) => message.id === messageId);
}

export function createQueueStoragePublic(
  queue: QueueStorage,
  options: QueueStoragePublicOptions = {},
): QueueStoragePublic {
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
    enqueue<T>(body: T): QueueMessage<T> {
      const message = queue.enqueue(body);
      void emitQueueNotifications([{ kind: 'message_enqueued', lane: options.lane, message }]);
      return message;
    },

    enqueueMany<T>(bodies: T[]): QueueMessage<T>[] {
      const messages = queue.enqueueMany(bodies);
      void emitQueueNotifications(messages.map((message) => ({ kind: 'message_enqueued', lane: options.lane, message })));
      return messages;
    },

    enqueueIfAbsent: queue.enqueueIfAbsent
      ? <T>(body: T, dedupKey: string): QueueMessage<T> | null => {
          const message = queue.enqueueIfAbsent!(body, dedupKey);
          if (message) {
            void emitQueueNotifications([{ kind: 'message_enqueued', lane: options.lane, message }]);
          }
          return message;
        }
      : undefined,

    lease<T>(leaseOptions?: { max?: number; visibilityMs?: number }) {
      return queue.lease<T>(leaseOptions);
    },

    ack(messageId: string, leaseToken: string): boolean {
      return queue.ack(messageId, leaseToken);
    },

    nack(messageId: string, leaseToken: string, nackOptions?: { dead?: boolean; reason?: string }): boolean {
      return queue.nack(messageId, leaseToken, nackOptions);
    },

    peekActive<T>(prefix?: string): QueueMessage<T>[] {
      return queue.peekActive<T>(prefix);
    },

    peekDeadLetter<T>(prefix?: string) {
      return queue.peekDeadLetter<T>(prefix);
    },

    stage<T>(body: T, stageOptions?: { dedupKey?: string }): QueueMessage<T> | null {
      return queue.stage(body, stageOptions);
    },

    commitStaged(messageId: string): boolean {
      const committed = queue.commitStaged(messageId);
      if (committed) {
        const message = findActiveMessageById(queue, messageId);
        if (message) {
          void emitQueueNotifications([{ kind: 'message_enqueued', lane: options.lane, message }]);
        }
      }
      return committed;
    },

    discardStaged(messageId: string, reason?: string): boolean {
      return queue.discardStaged(messageId, reason);
    },

    peekStaged<T>(prefix?: string): QueueMessage<T>[] {
      return queue.peekStaged<T>(prefix);
    },
  };
}