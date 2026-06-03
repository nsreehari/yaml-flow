import type {
  QueueDeadLetterMessage,
  QueueLeasedMessage,
  QueueMessage,
} from '../common/storage-interface.js';
import type { AsyncQueueStorage } from './storage-async-interface.js';

export interface AzureQueueSentMessageLike {
  messageId?: string;
  insertionTime?: Date;
}

export interface AzureQueueReceivedMessageLike {
  messageId?: string;
  messageText?: string;
  insertedOn?: Date;
  insertionTime?: Date;
  dequeueCount?: number;
  popReceipt?: string;
  nextVisibleOn?: Date;
}

export interface AzureQueuePeekedMessageLike {
  messageId?: string;
  messageText?: string;
  insertedOn?: Date;
  insertionTime?: Date;
  dequeueCount?: number;
}

export interface AzureQueueClientLike {
  sendMessage(content: string): Promise<AzureQueueSentMessageLike>;
  receiveMessages(options?: { numberOfMessages?: number; visibilityTimeout?: number }): Promise<{ receivedMessageItems: AzureQueueReceivedMessageLike[] }>;
  deleteMessage(messageId: string, popReceipt: string): Promise<unknown>;
  updateMessage(messageId: string, popReceipt: string, content: string, visibilityTimeout?: number): Promise<unknown>;
  peekMessages(options?: { numberOfMessages?: number }): Promise<{ peekedMessageItems: AzureQueuePeekedMessageLike[] }>;
}

export interface AzureQueueStorageOptions {
  deadLetterQueueClient?: AzureQueueClientLike;
  now?: () => Date;
}

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const maybe = error as { statusCode?: unknown; code?: unknown };
  if (typeof maybe.statusCode === 'number') return maybe.statusCode;
  if (typeof maybe.code === 'number') return maybe.code;
  return undefined;
}

function encodeBody(body: unknown): string {
  const json = JSON.stringify(body);
  const buf = (globalThis as { Buffer?: { from(data: string, enc?: string): { toString(enc: string): string } } }).Buffer;
  if (buf) return buf.from(json, 'utf-8').toString('base64');
  if (typeof btoa === 'function') return btoa(json);
  throw new Error('No base64 encoder available in this runtime');
}

function decodeBody<T>(body: string | undefined): T {
  const raw = body ?? '';
  const buf = (globalThis as { Buffer?: { from(data: string, enc: string): { toString(enc: string): string } } }).Buffer;
  if (buf) return JSON.parse(buf.from(raw, 'base64').toString('utf-8')) as T;
  if (typeof atob === 'function') return JSON.parse(atob(raw)) as T;
  throw new Error('No base64 decoder available in this runtime');
}

function toIso(value: Date | undefined, fallback: () => Date): string {
  return (value ?? fallback()).toISOString();
}

function mapQueued<T>(message: AzureQueuePeekedMessageLike, now: () => Date): QueueMessage<T> {
  return {
    id: String(message.messageId ?? ''),
    body: decodeBody<T>(message.messageText),
    enqueuedAt: toIso(message.insertedOn ?? message.insertionTime, now),
    attempt: Number(message.dequeueCount ?? 0),
  };
}

function mapLeased<T>(message: AzureQueueReceivedMessageLike, now: () => Date): QueueLeasedMessage<T> {
  return {
    id: String(message.messageId ?? ''),
    body: decodeBody<T>(message.messageText),
    enqueuedAt: toIso(message.insertedOn ?? message.insertionTime, now),
    attempt: Number(message.dequeueCount ?? 0),
    leaseToken: String(message.popReceipt ?? ''),
    leaseExpiresAt: toIso(message.nextVisibleOn, now),
  };
}

export function createAzureQueueStorage(
  queueClient: AzureQueueClientLike,
  options: AzureQueueStorageOptions = {},
): AsyncQueueStorage {
  const now = options.now ?? (() => new Date());
  const staged = new Map<string, { body: unknown; enqueuedAt: string; attempt: number; dedupKey?: string }>();

  return {
    async enqueue<T>(body: T): Promise<QueueMessage<T>> {
      const response = await queueClient.sendMessage(encodeBody(body));
      return {
        id: String(response.messageId ?? ''),
        body,
        enqueuedAt: toIso(response.insertionTime, now),
        attempt: 0,
      };
    },

    async enqueueMany<T>(bodies: T[]): Promise<QueueMessage<T>[]> {
      const queued = [] as QueueMessage<T>[];
      for (const body of bodies) queued.push(await this.enqueue(body));
      return queued;
    },

    async stage<T>(body: T, opts?: { dedupKey?: string }): Promise<QueueMessage<T> | null> {
      const dedupKey = opts?.dedupKey;
      if (dedupKey) {
        for (const existing of staged.values()) {
          if (existing.dedupKey === dedupKey) return null;
        }
      }
      const id = `staged:${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2, 10)}`;
      const message = { body, enqueuedAt: now().toISOString(), attempt: 0, ...(dedupKey ? { dedupKey } : {}) };
      staged.set(id, message);
      return { id, body, enqueuedAt: message.enqueuedAt, attempt: 0 };
    },

    async commitStaged(messageId: string): Promise<boolean> {
      const message = staged.get(messageId);
      if (!message) return false;
      staged.delete(messageId);
      await queueClient.sendMessage(encodeBody(message.body));
      return true;
    },

    async discardStaged(messageId: string): Promise<boolean> {
      if (!staged.has(messageId)) return false;
      staged.delete(messageId);
      return true;
    },

    async peekStaged<T>(prefix = ''): Promise<QueueMessage<T>[]> {
      return Array.from(staged.entries())
        .filter(([id]) => !prefix || id.startsWith(prefix))
        .map(([id, message]) => ({ id, body: message.body as T, enqueuedAt: message.enqueuedAt, attempt: message.attempt }));
    },

    async lease<T>(opts?: { max?: number; visibilityMs?: number }): Promise<QueueLeasedMessage<T>[]> {
      const result = await queueClient.receiveMessages({
        numberOfMessages: opts?.max,
        visibilityTimeout: opts?.visibilityMs ? Math.max(1, Math.ceil(opts.visibilityMs / 1000)) : undefined,
      });
      return result.receivedMessageItems.map((message) => mapLeased<T>(message, now));
    },

    async ack(messageId: string, leaseToken: string): Promise<boolean> {
      try {
        await queueClient.deleteMessage(messageId, leaseToken);
        return true;
      } catch (error) {
        if (getStatusCode(error) === 404) return false;
        throw error;
      }
    },

    async nack(messageId: string, leaseToken: string, opts?: { dead?: boolean; reason?: string }): Promise<boolean> {
      try {
        if (opts?.dead) {
          if (!options.deadLetterQueueClient) return false;
          const deadPayload = { messageId, reason: opts.reason ?? null };
          await options.deadLetterQueueClient.sendMessage(encodeBody(deadPayload));
          await queueClient.deleteMessage(messageId, leaseToken);
          return true;
        }
        await queueClient.updateMessage(messageId, leaseToken, encodeBody({ requeued: true }), 0);
        return true;
      } catch (error) {
        if (getStatusCode(error) === 404) return false;
        throw error;
      }
    },

    async peekActive<T>(prefix = ''): Promise<QueueMessage<T>[]> {
      const result = await queueClient.peekMessages({ numberOfMessages: 32 });
      return result.peekedMessageItems
        .map((message) => mapQueued<T>(message, now))
        .filter((message) => !prefix || message.id.startsWith(prefix));
    },

    async peekDeadLetter<T>(prefix = ''): Promise<QueueDeadLetterMessage<T>[]> {
      if (!options.deadLetterQueueClient) return [];
      const result = await options.deadLetterQueueClient.peekMessages({ numberOfMessages: 32 });
      return result.peekedMessageItems
        .map((message) => {
          const body = decodeBody<{ messageId?: string; reason?: string } & T>(message.messageText);
          return {
            id: String(message.messageId ?? ''),
            body: body as T,
            enqueuedAt: toIso(message.insertedOn ?? message.insertionTime, now),
            attempt: Number(message.dequeueCount ?? 0),
            reason: typeof body.reason === 'string' ? body.reason : undefined,
          } satisfies QueueDeadLetterMessage<T>;
        })
        .filter((message) => !prefix || message.id.startsWith(prefix));
    },
  };
}