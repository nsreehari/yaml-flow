import { afterEach, describe, expect, it, vi } from 'vitest';

import { serializeRef } from '../../src/cli/common/storage-interface.js';
import { invokeExecutionRef } from '../../src/cli/node/execution-adapter.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('http transports', () => {
  it('unwraps status/data JSON envelopes from http:post responses', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      status: 'success',
      data: { messages: [{ id: 'm1' }] },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;

    const result = await invokeExecutionRef({
      meta: 'task-executor',
      howToRun: 'http:post',
      whatToRun: serializeRef({ kind: 'http-url', value: 'http://example.test/mcp' }),
    }, { tool: 'inspect.chat-messages-on-cards' });

    expect(result.result).toBe('success');
    expect(result.data).toEqual({ messages: [{ id: 'm1' }] });
    expect(result.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('captures headers for non-JSON http:post responses', async () => {
    globalThis.fetch = vi.fn(async () => new Response('hello', {
      status: 200,
      headers: {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="hello.txt"',
      },
    })) as typeof fetch;

    const result = await invokeExecutionRef({
      meta: 'task-executor',
      howToRun: 'http:post',
      whatToRun: serializeRef({ kind: 'http-url', value: 'http://example.test/mcp-raw' }),
    }, { tool: 'inspect.file-contents' });

    expect(result.result).toBe('success');
    expect(result.data).toEqual({ stdout: 'hello' });
    expect(result.headers).toEqual({
      'content-disposition': 'attachment; filename="hello.txt"',
      'content-type': 'text/plain',
    });
    expect((result as { bodyBase64?: unknown }).bodyBase64).toBeUndefined();
  });
});