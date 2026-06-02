import { describe, expect, it, vi } from 'vitest';

import { createMcpWebhookToolRegistry } from '../../src/server-runtime/mcp-tool-registries.js';

describe('createMcpWebhookToolRegistry', () => {
  it('maps webhook tool names to the webhook MCP facade methods', async () => {
    const mcp = {
      webhookProcessAccumulated: vi.fn(async () => ({ status: 'success', data: { runtime_result: { drained: true } } })),
      webhookSourceFetchDone: vi.fn(async ({ token, ref }: { token: string; ref: string }) => ({
        status: 'success',
        data: { token, ref, runtime_result: { applied: true } },
      })),
      webhookSourceFetchFailed: vi.fn(async ({ token, reason }: { token: string; reason: string }) => ({
        status: 'success',
        data: { token, reason, runtime_result: { applied: true } },
      })),
    };

    const registry = createMcpWebhookToolRegistry(mcp);

    await expect(registry['webhook.process-accumulated']({})).resolves.toEqual({
      status: 'success',
      data: { runtime_result: { drained: true } },
    });
    await expect(registry['webhook.source-fetch-done']({ token: 'tok-1', ref: 'b64:abc' })).resolves.toEqual({
      status: 'success',
      data: { token: 'tok-1', ref: 'b64:abc', runtime_result: { applied: true } },
    });
    await expect(registry['webhook.source-fetch-failed']({ token: 'tok-2', reason: 'boom' })).resolves.toEqual({
      status: 'success',
      data: { token: 'tok-2', reason: 'boom', runtime_result: { applied: true } },
    });

    expect(mcp.webhookProcessAccumulated).toHaveBeenCalledTimes(1);
    expect(mcp.webhookSourceFetchDone).toHaveBeenCalledWith({ token: 'tok-1', ref: 'b64:abc' });
    expect(mcp.webhookSourceFetchFailed).toHaveBeenCalledWith({ token: 'tok-2', reason: 'boom' });
  });
});