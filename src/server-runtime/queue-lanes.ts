import type { BoardWorkerRequest, BoardWorkerStore } from '../cli/common/board-worker-store.js';
import { createQueueLaneRegistry } from '../cli/common/queue-lane-registry.js';
import type { QueueLaneDescriptor, QueueLaneRegistry } from '../cli/common/queue-lane-registry.js';
import type { QueueStorage } from '../cli/common/storage-interface.js';
import type {
  AsyncBoardWorkerStore,
} from '../cli/cloud/board-platform-adapter-async.js';
import type { AsyncQueueStorage } from '../cli/cloud/storage-async-interface.js';
import type {
  BoardRuntimePlatformAdapter,
  HostedBoardQueueLaneTuning,
  QueueLaneRuntimeTuning,
  RuntimeLogger,
  SingleBoardRuntime,
} from './types.js';

type BoardWorkerStoreLike = BoardWorkerStore | AsyncBoardWorkerStore;
type QueueStorageLike = QueueStorage | AsyncQueueStorage;

export interface HostedBoardQueueLaneRegistryOptions {
  boardId: string;
  runtime: Pick<SingleBoardRuntime, 'processAccumulatedLane' | 'handleChatAgentRequest' | 'queueLaneTuning'>;
  boardAdapter: BoardRuntimePlatformAdapter;
  logger?: RuntimeLogger;
  executeTaskExecutorRequest?: (args: Record<string, unknown>, request: BoardWorkerRequest) => Promise<void>;
}

function applyLaneTuning<TMessage>(lane: QueueLaneDescriptor<TMessage>, tuning?: QueueLaneRuntimeTuning): QueueLaneDescriptor<TMessage> {
  if (!tuning) return lane;
  return {
    ...lane,
    ...(tuning.pollIntervalMs != null ? { pollIntervalMs: tuning.pollIntervalMs } : {}),
    ...(tuning.visibilityMs != null ? { visibilityMs: tuning.visibilityMs } : {}),
    ...(tuning.concurrency != null ? { concurrency: tuning.concurrency } : {}),
    ...(tuning.maxAttempts != null ? { maxAttempts: tuning.maxAttempts } : {}),
  };
}

function createBoardWorkerStoreLane(
  id: string,
  store: BoardWorkerStoreLike,
  handleRequest: (args: Record<string, unknown>, request: BoardWorkerRequest) => Promise<void>,
  onError?: (error: unknown, attempt: number, request: BoardWorkerRequest) => void,
): QueueLaneDescriptor<BoardWorkerRequest> {
  return {
    id,
    async lease(opts) {
      const leased = await Promise.resolve(store.leaseRequests(opts));
      return leased.map((lease) => ({
        id: lease.messageId,
        attempt: lease.attempt,
        message: lease.request as BoardWorkerRequest,
        ack: () => Promise.resolve(store.ackRequest(lease.messageId, lease.leaseToken)),
        nack: (nackOpts) => Promise.resolve(store.nackRequest(lease.messageId, lease.leaseToken, nackOpts)),
      }));
    },
    async handle(message) {
      await handleRequest(message.args, message);
    },
    onError: onError
      ? (error, lease) => onError(error, lease.attempt, lease.message)
      : undefined,
  };
}

function createQueueStorageLane(
  id: string,
  queue: QueueStorageLike,
  handleMessage: () => Promise<void>,
  onError?: (error: unknown, attempt: number) => void,
): QueueLaneDescriptor {
  return {
    id,
    async lease(opts) {
      const leased = await Promise.resolve(queue.lease(opts));
      return leased.map((lease) => ({
        id: lease.id,
        attempt: lease.attempt,
        message: lease.body,
        ack: () => Promise.resolve(queue.ack(lease.id, lease.leaseToken)),
        nack: (nackOpts) => Promise.resolve(queue.nack(lease.id, lease.leaseToken, nackOpts)),
      }));
    },
    async handle() {
      await handleMessage();
    },
    onError: onError
      ? (error, lease) => onError(error, lease.attempt)
      : undefined,
  };
}

export function createHostedBoardQueueLaneRegistry(opts: HostedBoardQueueLaneRegistryOptions): QueueLaneRegistry {
  const logger = opts.logger ?? { info() {}, warn() {}, error() {} };
  const boardAdapter = opts.boardAdapter;
  const queueLaneTuning: HostedBoardQueueLaneTuning = opts.runtime.queueLaneTuning ?? {};
  const processQueue = boardAdapter.processAccumulatedStore();
  const chatStore = boardAdapter.chatAgentStore();
  const lanes: QueueLaneDescriptor[] = [];
  lanes.push(applyLaneTuning(createQueueStorageLane(
      'process-accumulated',
      processQueue,
      async () => {
        const result = await opts.runtime.processAccumulatedLane();
        if (result.status !== 'success') {
          throw new Error(result.error || `processAccumulatedLane returned ${result.status}`);
        }
      },
      (error, attempt) => {
        logger.error(
          `[board-server] queued process-accumulated failed for ${opts.boardId} (attempt ${attempt}): ${String(error && (error as Error).message || error)}`,
        );
      },
    ), queueLaneTuning.processAccumulated));
  lanes.push(applyLaneTuning(createBoardWorkerStoreLane(
      'chat-agent',
      chatStore,
      async (_args, request) => {
        await opts.runtime.handleChatAgentRequest(request);
      },
      (error, attempt, request) => {
        const cardId = typeof request.args?.cardId === 'string' ? request.args.cardId : '';
        logger.error(
          `[board-server] queued chat-agent failed for ${opts.boardId}${cardId ? `/${cardId}` : ''} (attempt ${attempt}): ${String(error && (error as Error).message || error)}`,
        );
      },
    ), queueLaneTuning.chatAgent) as QueueLaneDescriptor);

  if (opts.executeTaskExecutorRequest) {
    const boardWorkerStore = boardAdapter.boardWorkerStore();
    lanes.push(applyLaneTuning(createBoardWorkerStoreLane(
      'task-executor',
      boardWorkerStore,
      opts.executeTaskExecutorRequest,
      (error, attempt) => {
        logger.error(
          `[board-server] queued board-worker failed for ${opts.boardId} (attempt ${attempt}): ${String(error && (error as Error).message || error)}`,
        );
      },
    ), queueLaneTuning.taskExecutor) as QueueLaneDescriptor);
  }

  return createQueueLaneRegistry(lanes);
}