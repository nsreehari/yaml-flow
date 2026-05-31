import type { ExecutionRef } from './execution-interface.js';
import type {
  QueueDeadLetterMessage,
  QueueLeasedMessage,
  QueueMessage,
  QueueStorage,
} from './storage-interface.js';

export interface BoardWorkerRequest {
  boardId?: string;
  ref: ExecutionRef;
  args: Record<string, unknown>;
}

export interface BoardWorkerQueuedRequest {
  messageId: string;
  enqueuedAt: string;
  attempt: number;
  request: BoardWorkerRequest;
}

export interface BoardWorkerLeasedRequest extends BoardWorkerQueuedRequest {
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface BoardWorkerDeadLetterRequest extends BoardWorkerQueuedRequest {
  reason?: string;
}

export interface BoardWorkerStore {
  enqueueRequest(request: BoardWorkerRequest): string;
  enqueueRequestIfAbsent?(request: BoardWorkerRequest, dedupKey: string): string | null;
  leaseRequests(opts?: { max?: number; visibilityMs?: number }): BoardWorkerLeasedRequest[];
  ackRequest(messageId: string, leaseToken: string): boolean;
  nackRequest(messageId: string, leaseToken: string, opts?: { dead?: boolean; reason?: string }): boolean;
  peekActive(): BoardWorkerQueuedRequest[];
  peekDeadLetter(): BoardWorkerDeadLetterRequest[];
}

function mapQueued(message: QueueMessage<BoardWorkerRequest>): BoardWorkerQueuedRequest {
  return {
    messageId: message.id,
    enqueuedAt: message.enqueuedAt,
    attempt: message.attempt,
    request: message.body,
  };
}

function mapLeased(message: QueueLeasedMessage<BoardWorkerRequest>): BoardWorkerLeasedRequest {
  return {
    ...mapQueued(message),
    leaseToken: message.leaseToken,
    leaseExpiresAt: message.leaseExpiresAt,
  };
}

function mapDead(message: QueueDeadLetterMessage<BoardWorkerRequest>): BoardWorkerDeadLetterRequest {
  return {
    ...mapQueued(message),
    reason: message.reason,
  };
}

export function createBoardWorkerStore(queue: QueueStorage): BoardWorkerStore {
  return {
    enqueueRequest(request: BoardWorkerRequest): string {
      return queue.enqueue(request).id;
    },

    enqueueRequestIfAbsent: queue.enqueueIfAbsent
      ? (request: BoardWorkerRequest, dedupKey: string): string | null => {
          const msg = queue.enqueueIfAbsent!(request, dedupKey);
          return msg ? msg.id : null;
        }
      : undefined,

    leaseRequests(opts?: { max?: number; visibilityMs?: number }): BoardWorkerLeasedRequest[] {
      return queue.lease<BoardWorkerRequest>(opts).map(mapLeased);
    },

    ackRequest(messageId: string, leaseToken: string): boolean {
      return queue.ack(messageId, leaseToken);
    },

    nackRequest(messageId: string, leaseToken: string, opts?: { dead?: boolean; reason?: string }): boolean {
      return queue.nack(messageId, leaseToken, opts);
    },

    peekActive(): BoardWorkerQueuedRequest[] {
      return queue.peekActive<BoardWorkerRequest>().map(mapQueued);
    },

    peekDeadLetter(): BoardWorkerDeadLetterRequest[] {
      return queue.peekDeadLetter<BoardWorkerRequest>().map(mapDead);
    },
  };
}