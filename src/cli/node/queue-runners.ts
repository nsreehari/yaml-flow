import type {
  BoardWorkerRequest,
  BoardWorkerStore,
} from '../common/board-worker-store.js';
import type {
  QueueLaneDescriptor,
  QueueLaneLease,
  QueueLaneRegistry,
} from '../common/queue-lane-registry.js';
import type { QueueStorage } from '../common/storage-interface.js';

export interface CreateBoardWorkerQueueLaneOptions {
  id?: string;
  workerStore: BoardWorkerStore;
  handleRequest(args: Record<string, unknown>, request: BoardWorkerRequest): Promise<void>;
  pollIntervalMs?: number;
  visibilityMs?: number;
  concurrency?: number;
  maxAttempts?: number;
  onError?: (error: unknown, lease: QueueLaneLease<BoardWorkerRequest>) => void;
}

export interface CreateQueueStorageLaneOptions<TMessage> {
  id: string;
  queueStorage: QueueStorage;
  handleMessage(message: TMessage, lease: QueueLaneLease<TMessage>): Promise<void>;
  pollIntervalMs?: number;
  visibilityMs?: number;
  concurrency?: number;
  maxAttempts?: number;
  onError?: (error: unknown, lease: QueueLaneLease<TMessage>) => void;
}

export function createBoardWorkerQueueLane(opts: CreateBoardWorkerQueueLaneOptions): QueueLaneDescriptor<BoardWorkerRequest> {
  return {
    id: opts.id ?? 'board-worker',
    pollIntervalMs: opts.pollIntervalMs,
    visibilityMs: opts.visibilityMs,
    concurrency: opts.concurrency,
    maxAttempts: opts.maxAttempts,
    async lease(leaseOpts) {
      return opts.workerStore.leaseRequests(leaseOpts).map((lease) => ({
        id: lease.messageId,
        attempt: lease.attempt,
        message: lease.request,
        ack: () => opts.workerStore.ackRequest(lease.messageId, lease.leaseToken),
        nack: (nackOpts) => opts.workerStore.nackRequest(lease.messageId, lease.leaseToken, nackOpts),
      }));
    },
    async handle(message) {
      await opts.handleRequest(message.args, message);
    },
    onError: opts.onError,
  };
}

export function createQueueStorageLane<TMessage>(opts: CreateQueueStorageLaneOptions<TMessage>): QueueLaneDescriptor<TMessage> {
  return {
    id: opts.id,
    pollIntervalMs: opts.pollIntervalMs,
    visibilityMs: opts.visibilityMs,
    concurrency: opts.concurrency,
    maxAttempts: opts.maxAttempts,
    async lease(leaseOpts) {
      return opts.queueStorage.lease<TMessage>(leaseOpts).map((lease) => ({
        id: lease.id,
        attempt: lease.attempt,
        message: lease.body,
        ack: () => opts.queueStorage.ack(lease.id, lease.leaseToken),
        nack: (nackOpts) => opts.queueStorage.nack(lease.id, lease.leaseToken, nackOpts),
      }));
    },
    handle: opts.handleMessage,
    onError: opts.onError,
  };
}

async function runLaneLease<TMessage>(lane: QueueLaneDescriptor<TMessage>, lease: QueueLaneLease<TMessage>): Promise<void> {
  try {
    await lane.handle(lease.message, lease);
    await lease.ack();
  } catch (error) {
    const dead = lease.attempt >= Math.max(1, Math.floor(lane.maxAttempts ?? 5));
    await lease.nack({
      dead,
      reason: error instanceof Error ? error.message : String(error),
    });
    lane.onError?.(error, lease);
  }
}

export function startQueueLaneRunner<TMessage>(lane: QueueLaneDescriptor<TMessage>): () => void {
  const pollIntervalMs = Math.max(1, Math.floor(lane.pollIntervalMs ?? 250));
  const visibilityMs = Math.max(1, Math.floor(lane.visibilityMs ?? 60_000));
  const concurrency = Math.max(1, Math.floor(lane.concurrency ?? 1));
  let stopped = false;
  let draining = false;

  async function tick(): Promise<void> {
    if (stopped || draining) return;
    draining = true;
    try {
      const leases = await lane.lease({ max: concurrency, visibilityMs });
      for (const lease of leases) {
        await runLaneLease(lane, lease);
      }
    } finally {
      draining = false;
    }
  }

  const timer = setInterval(() => { void tick(); }, pollIntervalMs);
  if (typeof (timer as NodeJS.Timeout).unref === 'function') {
    (timer as NodeJS.Timeout).unref();
  }
  void tick();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function drainQueueLaneOnce<TMessage>(lane: QueueLaneDescriptor<TMessage>): Promise<number> {
  const visibilityMs = Math.max(1, Math.floor(lane.visibilityMs ?? 60_000));
  const concurrency = Math.max(1, Math.floor(lane.concurrency ?? 1));
  const leases = await lane.lease({ max: concurrency, visibilityMs });
  for (const lease of leases) {
    await runLaneLease(lane, lease);
  }
  return leases.length;
}

export async function drainQueueLaneToIdle<TMessage>(
  lane: QueueLaneDescriptor<TMessage>,
  opts?: { maxPasses?: number },
): Promise<number> {
  const maxPasses = Math.max(1, Math.floor(opts?.maxPasses ?? 256));
  let total = 0;
  for (let pass = 0; pass < maxPasses; pass += 1) {
    const drained = await drainQueueLaneOnce(lane);
    total += drained;
    if (drained <= 0) return total;
  }
  throw new Error(`drainQueueLaneToIdle exceeded ${maxPasses} passes for lane "${lane.id}"`);
}

export function startQueueLaneRunners(registryOrLanes: QueueLaneRegistry | QueueLaneDescriptor[]): () => void {
  const lanes = Array.isArray(registryOrLanes) ? registryOrLanes : registryOrLanes.lanes;
  const stops = lanes.map((lane) => startQueueLaneRunner(lane));
  return () => {
    for (const stop of stops) stop();
  };
}