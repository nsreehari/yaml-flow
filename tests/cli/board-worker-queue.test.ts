import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createBoardWorkerQueueLane,
  createQueueLaneRegistry,
  createQueueStorageLane,
  createBoardWorkerStore,
  createFsBoardPlatformAdapter,
  createFsQueueStorage,
  parseRef,
  serializeRef,
  startQueueLaneRunners,
} from '../../src/cli/node/fs-board-adapter.js';
import { createInProcessBoardCallbackTransport } from '../../src/cli/common/board-callback-transport.js';
import {
  registerInProcessBoardWorkerCallback,
  reportComplete,
  unregisterInProcessBoardWorkerCallback,
} from '../../src/cli/public/board-worker-adapter.ts';

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('board-worker queue transport', () => {
  it('leases and acknowledges fs-backed queue messages', () => {
    const root = makeTempDir('yaml-flow-queue-');
    try {
      const queue = createFsQueueStorage(path.join(root, 'queue'));
      const enqueued = queue.enqueue({ kind: 'test', value: 1 });

      expect(queue.peekActive()).toHaveLength(1);

      const [lease] = queue.lease<{ kind: string; value: number }>({ visibilityMs: 250 });
      expect(lease.id).toBe(enqueued.id);
      expect(lease.attempt).toBe(1);
      expect(queue.peekActive()).toHaveLength(0);

      expect(queue.ack(lease.id, lease.leaseToken)).toBe(true);
      expect(queue.peekActive()).toHaveLength(0);
      expect(queue.peekDeadLetter()).toHaveLength(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('dead-letters board-worker requests through the semantic store', () => {
    const root = makeTempDir('yaml-flow-board-worker-store-');
    try {
      const store = createBoardWorkerStore(createFsQueueStorage(path.join(root, 'queue')));
      const requestId = store.enqueueRequest({
        boardId: 'board-1',
        ref: {
          meta: 'task-executor',
          howToRun: 'queue-storage',
          whatToRun: serializeRef({ kind: 'queue-storage', value: 'board:board-1:board-worker' }),
        },
        args: { payload: 'x' },
      });

      const [lease] = store.leaseRequests({ visibilityMs: 250 });
      expect(lease.messageId).toBe(requestId);
      expect(store.nackRequest(lease.messageId, lease.leaseToken, { dead: true, reason: 'boom' })).toBe(true);

      const deadLetters = store.peekDeadLetter();
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]?.reason).toBe('boom');
      expect(deadLetters[0]?.request.boardId).toBe('board-1');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('dispatches queue-backed board-worker requests through the host runner and callback loop', async () => {
    const root = makeTempDir('yaml-flow-queue-dispatch-');
    const callbackKey = `test:queue-callback:${Date.now()}`;
    const baseRef = parseRef(serializeRef({ kind: 'fs-path', value: root }));
    const callbackTransport = createInProcessBoardCallbackTransport(callbackKey);
    const callback = callbackTransport.createCallback('source-token');
    let callbackPayload: Record<string, unknown> | null = null;
    const executedBoardIds: string[] = [];

    registerInProcessBoardWorkerCallback(callbackKey, (payload) => {
      callbackPayload = payload as Record<string, unknown>;
      return { status: 'success' };
    });

    try {
      const queueStoreRef = serializeRef({ kind: 'fs-path', value: path.join(root, 'queue-root') });
      const adapter = createFsBoardPlatformAdapter(baseRef, process.cwd(), {
        suppressSpawn: true,
        callbackTransport,
        queueStoreRef,
      });
      const stopRunner = startQueueLaneRunners(createQueueLaneRegistry([
        createBoardWorkerQueueLane({
          id: 'task-executor',
          workerStore: createBoardWorkerStore(adapter.queueStorageForRef(queueStoreRef, 'task-executor')),
          handleRequest: async (args, request) => {
            executedBoardIds.push(String(request.boardId || ''));
            expect(args.source_def).toEqual({ bindTo: 'prices' });
            const outputRef = parseRef(String((args.output as Record<string, unknown>).ref));
            expect(outputRef.value.replace(/\\/g, '/')).toContain('/sources/card-1/.staged/delivery-1/prices.json');
            fs.mkdirSync(path.dirname(outputRef.value), { recursive: true });
            fs.writeFileSync(outputRef.value, JSON.stringify({ ok: true }), 'utf-8');
            reportComplete(args.callback as typeof callback, outputRef);
          },
          pollIntervalMs: 10,
          visibilityMs: 250,
        }),
      ]));

      try {
        const result = await adapter.dispatchExecution({
          meta: 'task-executor',
          howToRun: 'queue-storage',
          whatToRun: serializeRef({ kind: 'queue-storage', value: 'board:board-1:board-worker' }),
          extra: { boardId: 'board-1' },
        }, {
          source_def: { bindTo: 'prices' },
          callback,
          output: {
            ref: serializeRef({ kind: 'fs-path', value: path.join(root, 'sources', 'card-1', '.staged', 'delivery-1', 'prices.json') }),
            deliveryToken: 'delivery-1',
            outputFile: 'prices.json',
            cardId: 'card-1',
          },
        });

        expect(result).toEqual({ dispatched: true });
        await waitFor(() => callbackPayload !== null);
        expect(executedBoardIds).toEqual(['board-1']);
        expect(callbackPayload).toEqual({
          token: 'source-token',
          outcome: 'success',
          ref: serializeRef({ kind: 'fs-path', value: path.join(root, 'sources', 'card-1', '.staged', 'delivery-1', 'prices.json') }),
        });
        expect(createBoardWorkerStore(adapter.queueStorageForRef(queueStoreRef, 'task-executor')).peekActive()).toHaveLength(0);
      } finally {
        stopRunner();
      }
    } finally {
      unregisterInProcessBoardWorkerCallback(callbackKey);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('drives process-accumulated wakeups from the queue runner and acknowledges them', async () => {
    const root = makeTempDir('yaml-flow-process-accumulated-');
    try {
      const queue = createFsQueueStorage(path.join(root, 'queue'));
      queue.enqueue({ boardRef: '::fs-path::/tmp/board-1' });
      let processCalls = 0;

      const stopRunner = startQueueLaneRunners(createQueueLaneRegistry([
        createQueueStorageLane({
          id: 'process-accumulated',
          queueStorage: queue,
          handleMessage: async () => {
            processCalls += 1;
          },
          pollIntervalMs: 10,
          visibilityMs: 250,
        }),
      ]));

      try {
        await waitFor(() => processCalls === 1);
        expect(queue.peekActive()).toHaveLength(0);
        expect(queue.peekDeadLetter()).toHaveLength(0);
      } finally {
        stopRunner();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});