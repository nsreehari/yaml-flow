import type {
  BoardWorkerLeasedRequest,
  BoardWorkerRequest,
  BoardWorkerStore,
} from '../common/board-worker-store.js';

export interface StartBoardWorkerQueueRunnerOptions {
  workerStore: BoardWorkerStore;
  executeBoardWorkerRequest(request: BoardWorkerRequest): Promise<void>;
  pollIntervalMs?: number;
  visibilityMs?: number;
  concurrency?: number;
  maxAttempts?: number;
  onError?: (error: unknown, lease: BoardWorkerLeasedRequest) => void;
}

export function startBoardWorkerQueueRunner(opts: StartBoardWorkerQueueRunnerOptions): () => void {
  const pollIntervalMs = Math.max(1, Math.floor(opts.pollIntervalMs ?? 250));
  const visibilityMs = Math.max(1, Math.floor(opts.visibilityMs ?? 60_000));
  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));
  const maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 5));
  let stopped = false;
  let draining = false;

  async function processLease(lease: BoardWorkerLeasedRequest): Promise<void> {
    try {
      await opts.executeBoardWorkerRequest(lease.request);
      opts.workerStore.ackRequest(lease.messageId, lease.leaseToken);
    } catch (error) {
      const dead = lease.attempt >= maxAttempts;
      opts.workerStore.nackRequest(lease.messageId, lease.leaseToken, {
        dead,
        reason: error instanceof Error ? error.message : String(error),
      });
      opts.onError?.(error, lease);
    }
  }

  async function tick(): Promise<void> {
    if (stopped || draining) return;
    draining = true;
    try {
      const leases = opts.workerStore.leaseRequests({ max: concurrency, visibilityMs });
      for (const lease of leases) {
        await processLease(lease);
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