import { describe, expect, it } from 'vitest';

import {
  invokeExecutionRef,
  registerInProcessExecutionHandler,
  unregisterInProcessExecutionHandler,
} from '../../src/cli/node/execution-adapter.js';
import {
  registerInProcessBoardWorkerCallback,
  reportComplete,
  serializeRef,
  unregisterInProcessBoardWorkerCallback,
} from '../../src/cli/public/board-worker-adapter.ts';

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