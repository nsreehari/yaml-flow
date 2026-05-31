import type { CommandResult } from '../common/board-live-cards-public.js';
import type { QueueLaneLease } from '../common/queue-lane-registry.js';
import type { QueueStorage } from '../common/storage-interface.js';
import { createQueueStorageLane, startQueueLaneRunner } from './queue-runners.js';

export interface StartProcessAccumulatedQueueRunnerOptions {
  queueStorage: QueueStorage;
  processAccumulatedEvents: () => Promise<CommandResult | void>;
  pollIntervalMs?: number;
  visibilityMs?: number;
  concurrency?: number;
  maxAttempts?: number;
  onError?: (error: unknown, lease: QueueLaneLease<unknown>) => void;
}

export function startProcessAccumulatedQueueRunner(opts: StartProcessAccumulatedQueueRunnerOptions): () => void {
  return startQueueLaneRunner(createQueueStorageLane<unknown>({
    id: 'process-accumulated',
    queueStorage: opts.queueStorage,
    handleMessage: async () => {
      const result = await opts.processAccumulatedEvents();
      if (result && result.status !== 'success') {
        throw new Error(result.error || `processAccumulatedEvents returned ${result.status}`);
      }
    },
    pollIntervalMs: opts.pollIntervalMs,
    visibilityMs: opts.visibilityMs,
    concurrency: opts.concurrency,
    maxAttempts: opts.maxAttempts,
    onError: opts.onError,
  }));
}