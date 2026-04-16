import { describe, it, expect, vi } from 'vitest';
import {
  createCallbackHandler,
  createFireAndForgetHandler,
  createNoopHandler,
  createShellHandler,
} from '../../src/continuous-event-graph/handlers.js';
import type { TaskHandlerInput } from '../../src/continuous-event-graph/reactive.js';
import type { ResolveCallbackFn } from '../../src/continuous-event-graph/handlers.js';

// ============================================================================
// Helpers
// ============================================================================

function makeInput(nodeId: string = 'test-task'): TaskHandlerInput {
  return {
    nodeId,
    state: {},
    taskState: {
      status: 'running' as any,
      executionCount: 0,
      retryCount: 0,
      lastEpoch: 0,
    },
    config: { provides: ['output'] },
    callbackToken: 'test-token-123',
  };
}

/** Create a mock resolveCallback that records calls */
function mockResolve(): { resolve: ResolveCallbackFn; calls: Array<{ token: string; data: Record<string, unknown>; errors?: string[] }> } {
  const calls: Array<{ token: string; data: Record<string, unknown>; errors?: string[] }> = [];
  return {
    resolve: (token, data, errors) => { calls.push({ token, data, errors }); },
    calls,
  };
}

// ============================================================================
// createCallbackHandler
// ============================================================================

describe('createCallbackHandler', () => {
  it('returns task-initiated and resolves with data', async () => {
    const mock = mockResolve();
    const handler = createCallbackHandler(
      async (input) => ({ nodeId: input.nodeId }),
      () => mock.resolve,
    );

    const result = await handler(makeInput('my-task'));
    expect(result).toBe('task-initiated');

    // Wait for background resolution
    await new Promise(r => setTimeout(r, 10));
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].token).toBe('test-token-123');
    expect(mock.calls[0].data).toEqual({ nodeId: 'my-task' });
  });

  it('resolves with errors when fn throws', async () => {
    const mock = mockResolve();
    const handler = createCallbackHandler(
      async () => { throw new Error('boom'); },
      () => mock.resolve,
    );

    const result = await handler(makeInput());
    expect(result).toBe('task-initiated');

    await new Promise(r => setTimeout(r, 10));
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].errors).toEqual(['boom']);
  });
});

// ============================================================================
// createFireAndForgetHandler
// ============================================================================

describe('createFireAndForgetHandler', () => {
  it('returns task-initiated and resolves with empty data', async () => {
    let sideEffectDone = false;
    const mock = mockResolve();
    const handler = createFireAndForgetHandler(
      async () => {
        await new Promise(r => setTimeout(r, 50));
        sideEffectDone = true;
      },
      () => mock.resolve,
    );

    const result = await handler(makeInput());
    expect(result).toBe('task-initiated');

    // Wait for background completion
    await new Promise(r => setTimeout(r, 100));
    expect(sideEffectDone).toBe(true);
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].data).toEqual({});
  });

  it('swallows errors and still resolves', async () => {
    const mock = mockResolve();
    const handler = createFireAndForgetHandler(
      async () => { throw new Error('should be swallowed'); },
      () => mock.resolve,
    );

    const result = await handler(makeInput());
    expect(result).toBe('task-initiated');

    await new Promise(r => setTimeout(r, 10));
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].data).toEqual({});
  });

  it('works with synchronous functions', async () => {
    let called = false;
    const mock = mockResolve();
    const handler = createFireAndForgetHandler(
      () => { called = true; },
      () => mock.resolve,
    );

    await handler(makeInput());
    await new Promise(r => setTimeout(r, 10));
    expect(called).toBe(true);
    expect(mock.calls).toHaveLength(1);
  });
});

// ============================================================================
// createNoopHandler
// ============================================================================

describe('createNoopHandler', () => {
  it('returns task-initiated and resolves with empty data', async () => {
    const mock = mockResolve();
    const handler = createNoopHandler(() => mock.resolve);

    const result = await handler(makeInput());
    expect(result).toBe('task-initiated');
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].data).toEqual({});
  });

  it('resolves with static data when provided', async () => {
    const mock = mockResolve();
    const handler = createNoopHandler(() => mock.resolve, { x: 1 });

    await handler(makeInput());
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].data).toEqual({ x: 1 });
  });
});

// ============================================================================
// createShellHandler
// ============================================================================

describe('createShellHandler', () => {
  it('runs a simple echo command and resolves', async () => {
    const mock = mockResolve();
    const handler = createShellHandler({
      command: 'echo hello',
      captureOutput: true,
      getResolve: () => mock.resolve,
    });

    const result = await handler(makeInput());
    expect(result).toBe('task-initiated');

    // Wait for shell to finish
    await new Promise(r => setTimeout(r, 2000));
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].data?.stdout).toContain('hello');
  });

  it('substitutes ${taskName} in command', async () => {
    const mock = mockResolve();
    const handler = createShellHandler({
      command: 'echo ${taskName}',
      captureOutput: true,
      getResolve: () => mock.resolve,
    });

    await handler(makeInput('my-task'));
    await new Promise(r => setTimeout(r, 2000));
    expect(mock.calls[0].data?.stdout).toContain('my-task');
  });

  it('resolves with error on non-zero exit code', async () => {
    const mock = mockResolve();
    const handler = createShellHandler({
      command: 'exit 1',
      getResolve: () => mock.resolve,
    });

    await handler(makeInput());
    await new Promise(r => setTimeout(r, 2000));
    expect(mock.calls).toHaveLength(1);
    expect(mock.calls[0].errors).toBeDefined();
    expect(mock.calls[0].errors![0]).toContain('exited with code 1');
  });
});
