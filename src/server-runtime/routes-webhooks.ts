/**
 * server-runtime/routes-webhooks.ts
 *
 * Worker-callback webhook routes extracted from createSingleBoardServerRuntime.
 *   POST /callback/board-worker/:token/success
 *   POST /callback/board-worker/:token/failure
 */

import type { RuntimeRequest, RuntimeResponse } from './types.js';
import { escapeRegExp } from './internal-helpers.js';

export interface RoutesWebhooksDeps {
  apiBasePath: string;
  json: (res: RuntimeResponse, status: number, payload: unknown) => void;
  readJsonBody: (req: RuntimeRequest) => Promise<Record<string, unknown>>;
  initBoardAndSetup: () => Promise<void>;
  applyBoardWorkerCallback: (
    token: string,
    outcome: 'success' | 'failure',
    body: Record<string, unknown>,
  ) => Promise<{ statusCode: number; body: unknown }>;
}

export interface RoutesWebhooks {
  handleWebhooksApi: (req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL) => Promise<boolean>;
}

export function createRoutesWebhooks(deps: RoutesWebhooksDeps): RoutesWebhooks {
  const { apiBasePath, json, readJsonBody, initBoardAndSetup, applyBoardWorkerCallback } = deps;

  async function handleWebhooksApi(req: RuntimeRequest, res: RuntimeResponse, parsedUrl: URL): Promise<boolean> {
    const method = req.method || 'GET';
    const p = parsedUrl.pathname;

    try {
      const boardWorkerCallbackMatch = p.match(new RegExp(`^${escapeRegExp(apiBasePath)}/callback/board-worker/([^/]+)/(success|failure)$`));
      if (method === 'POST' && boardWorkerCallbackMatch) {
        await initBoardAndSetup();
        const token = decodeURIComponent(boardWorkerCallbackMatch[1]);
        const outcome = boardWorkerCallbackMatch[2] as 'success' | 'failure';
        const body = await readJsonBody(req);
        const callbackResult = await applyBoardWorkerCallback(token, outcome, body);
        json(res, callbackResult.statusCode, callbackResult.body);
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
