import { describe, expect, it } from 'vitest';

import {
  dispatchTaskExecutorDetached,
  invokeExecutionRef,
  registerInProcessExecutionHandler,
  unregisterInProcessExecutionHandler,
} from '../../src/cli/node/execution-adapter.js';
import {
  registerInProcessBoardWorkerCallback,
  reportComplete,
  serializeRef,
  unregisterInProcessBoardWorkerCallback,
} from '../../src/cli/node/board-worker-adapter.ts';

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('in-process-loop transports', () => {
  it('invokeExecutionRef dispatches to a registered in-process execution handler', async () => {
    const handlerKey = 'test:execution-handler';
    registerInProcessExecutionHandler(handlerKey, async (_ref, args) => ({
      result: 'success',
      data: { echoed: args.payload },
    }));

    try {
      const result = await invokeExecutionRef({
        meta: 'task-executor',
        howToRun: 'in-process-loop',
        whatToRun: serializeRef({ kind: 'in-process-loop', value: handlerKey }),
      }, { payload: 'ok' });

      expect(result.result).toBe('success');
      expect(result.data).toEqual({ echoed: 'ok' });
    } finally {
      unregisterInProcessExecutionHandler(handlerKey);
    }
  });

  it('dispatchTaskExecutorDetached fires an in-process execution handler without waiting for completion', async () => {
    const handlerKey = 'test:detached-execution-handler';
    const calls: Array<Record<string, unknown>> = [];
    registerInProcessExecutionHandler(handlerKey, async (_ref, args) => {
      calls.push(args);
      return { result: 'success', data: { dispatched: true } };
    });

    try {
      dispatchTaskExecutorDetached({
        meta: 'task-executor',
        howToRun: 'in-process-loop',
        whatToRun: serializeRef({ kind: 'in-process-loop', value: handlerKey }),
      }, {
        subcommand: 'run-source-fetch',
        inRef: 'b64:in',
        outRef: 'b64:out',
        errRef: 'b64:err',
      }, process.cwd());

      await waitFor(() => calls.length === 1);
      expect(calls[0]).toMatchObject({
        subcommand: 'run-source-fetch',
        inRef: 'b64:in',
        outRef: 'b64:out',
        errRef: 'b64:err',
      });
    } finally {
      unregisterInProcessExecutionHandler(handlerKey);
    }
  });

  it('reportComplete dispatches to a registered in-process board-worker callback handler', () => {
    const callbackKey = 'test:board-worker-callback';
    let received: Record<string, unknown> | null = null;
    registerInProcessBoardWorkerCallback(callbackKey, (payload) => {
      received = payload as Record<string, unknown>;
      return { status: 'success' };
    });

    try {
      reportComplete({
        token: 'source-token',
        via: {
          meta: 'board-live-cards',
          howToRun: 'in-process-loop',
          whatToRun: serializeRef({ kind: 'in-process-loop', value: callbackKey }),
        },
      }, { kind: 'fs-path', value: '/tmp/out.json' });

      expect(received).toEqual({
        token: 'source-token',
        outcome: 'success',
        ref: serializeRef({ kind: 'fs-path', value: '/tmp/out.json' }),
      });
    } finally {
      unregisterInProcessBoardWorkerCallback(callbackKey);
    }
  });
});