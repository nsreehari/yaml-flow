export type QueueLaneAwaitable<T> = T | Promise<T>;

export interface QueueLaneLease<TMessage = unknown> {
  id: string;
  attempt: number;
  message: TMessage;
  ack(): QueueLaneAwaitable<boolean>;
  nack(opts?: { dead?: boolean; reason?: string }): QueueLaneAwaitable<boolean>;
}

export interface QueueLaneDescriptor<TMessage = unknown> {
  id: string;
  pollIntervalMs?: number;
  visibilityMs?: number;
  concurrency?: number;
  maxAttempts?: number;
  lease(opts?: { max?: number; visibilityMs?: number }): QueueLaneAwaitable<QueueLaneLease<TMessage>[]>;
  handle(message: TMessage, lease: QueueLaneLease<TMessage>): Promise<void>;
  onError?: (error: unknown, lease: QueueLaneLease<TMessage>) => void;
}

export interface QueueLaneRegistry {
  lanes: QueueLaneDescriptor[];
}

export function createQueueLaneRegistry(lanes: QueueLaneDescriptor[]): QueueLaneRegistry {
  return { lanes };
}