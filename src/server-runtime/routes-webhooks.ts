/**
 * server-runtime/routes-webhooks.ts
 *
 * Worker webhook MCP route extracted from createSingleBoardServerRuntime.
 *   POST /mcp-webhooks
 */

import type { RuntimeRequest, RuntimeResponse } from './types.js';
import { invokeMcpTool, extractMcpFailureMessage } from './mcp-invoker.js';
import type { ToolRegistry } from './mcp-tool-registries.js';

export interface RoutesWebhooksDeps {
  apiBasePath: string;
  json: (res: RuntimeResponse, status: number, payload: unknown) => void;
  readJsonBody: (req: RuntimeRequest) => Promise<Record<string, unknown>>;
  initBoardAndSetup: () => Promise<void>;
  createMcpWebhookToolRegistry: () => ToolRegistry;
}

export interface RoutesWebhooks {
  handleWebhooksApi: (req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL) => Promise<boolean>;
}

export function createRoutesWebhooks(deps: RoutesWebhooksDeps): RoutesWebhooks {
  const { apiBasePath, json, readJsonBody, initBoardAndSetup, createMcpWebhookToolRegistry } = deps;

  async function handleWebhooksApi(req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL): Promise<boolean> {
    const method = req.method || 'GET';
    const p = parsedUrl.pathname;

    try {
      if (method === 'POST' && p === `${apiBasePath}/mcp-webhooks`) {
        await initBoardAndSetup();
        const body = await readJsonBody(req);
        const tool = typeof body.tool === 'string' ? body.tool.trim() : '';
        const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args)
          ? body.args as Record<string, unknown>
          : {};
        if (!tool) {
          json(res, 400, { error: 'tool is required' });
          return true;
        }
        try {
          const result = await invokeMcpTool(tool, args, createMcpWebhookToolRegistry());
          if (result && typeof result === 'object' && !Array.isArray(result)) {
            const record = result as Record<string, unknown>;
            if (record.status === 'fail') {
              json(res, 400, { error: extractMcpFailureMessage(result, 'Request failed') });
              return true;
            }
            if (record.status === 'error') {
              json(res, 500, { error: extractMcpFailureMessage(result, 'Internal error') });
              return true;
            }
          }
          json(res, 200, result);
        } catch (error) {
          const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === 'number'
            ? Number((error as { statusCode: number }).statusCode)
            : 500;
          const message = error instanceof Error ? error.message : String(error);
          json(res, statusCode, { error: message });
        }
        return true;
      }

      return false;
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number })?.statusCode || 500;
      json(res, statusCode, { error: String((err as Error)?.message || err) });
      return true;
    }
  }

  return { handleWebhooksApi };
}
