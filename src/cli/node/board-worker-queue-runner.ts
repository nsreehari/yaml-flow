import type {
  BoardWorkerRequest,
  BoardWorkerStore,
} from '../common/board-worker-store.js';
import type { QueueLaneLease } from '../common/queue-lane-registry.js';
import { createBoardWorkerQueueLane, startQueueLaneRunner } from './queue-runners.js';

export interface StartBoardWorkerQueueRunnerOptions {
  workerStore: BoardWorkerStore;
  executeBoardWorkerRequest(args: Record<string, unknown>, request: BoardWorkerRequest): Promise<void>;
  pollIntervalMs?: number;
  visibilityMs?: number;
  concurrency?: number;
  maxAttempts?: number;
  onError?: (error: unknown, lease: QueueLaneLease<BoardWorkerRequest>) => void;
}

export function startBoardWorkerQueueRunner(opts: StartBoardWorkerQueueRunnerOptions): () => void {
  return startQueueLaneRunner(createBoardWorkerQueueLane({
    id: 'task-executor',
    workerStore: opts.workerStore,
    handleRequest: opts.executeBoardWorkerRequest,
    pollIntervalMs: opts.pollIntervalMs,
    visibilityMs: opts.visibilityMs,
    concurrency: opts.concurrency,
    maxAttempts: opts.maxAttempts,
    onError: opts.onError,
  }));
}