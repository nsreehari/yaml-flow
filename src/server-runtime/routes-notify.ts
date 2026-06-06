/**
 * server-runtime/routes-notify.ts
 *
 * POST /<apiBasePath>/notify — co-process notification ingress.
 *
 * Security model: loopback-only (127.0.0.1 / ::1 / ::ffff:127.0.0.1).
 * This endpoint is intentionally NOT reachable from external HTTP consumers.
 * Queue runners and task executors running on the same host use this to push
 * notifications (chat_processing, watchparty_update, task_progress, etc.)
 * into the SSE fan-out without needing any shared secret.
 *
 * Body:  { notifications: Array<{ kind: string; [key: string]: unknown; sentAtMs?: number }> }
 * Response: { status: 'success', data: { accepted: number; rejected: number } }
 *
 * Items are dropped (not 400) if:
 *   - missing or non-string kind
 *   - sentAtMs is present and older than STALE_THRESHOLD_MS
 */

import type { RuntimeRequest, RuntimeResponse } from './types.js';
import { filterFreshRuntimeNotifications } from './runtime-notification-ingress.js';
import type { RuntimeNotification } from '../cli/common/notification-interface.js';

const STALE_THRESHOLD_MS = 30_000;

function isLoopback(req: RuntimeRequest): boolean {
  const addr = (req as unknown as { socket?: { remoteAddress?: string } })
    .socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

export interface RoutesNotifyDeps {
  apiBasePath: string;
  emitNotifications: (notifications: RuntimeNotification[]) => void;
  readJsonBody: (req: RuntimeRequest) => Promise<unknown>;
  json: (res: RuntimeResponse, status: number, payload: unknown) => void;
}

export function createRoutesNotify(deps: RoutesNotifyDeps) {
  const { apiBasePath, emitNotifications, readJsonBody, json } = deps;
  const notifyPath = `${apiBasePath}/notify`;

  async function handleNotifyRoute(
    req: RuntimeRequest,
    res: RuntimeResponse,
    parsedUrl: URL,
  ): Promise<boolean> {
    if (parsedUrl.pathname !== notifyPath) return false;

    if ((req.method ?? '').toUpperCase() !== 'POST') {
      json(res, 405, { status: 'error', error: 'Method not allowed' });
      return true;
    }

    if (!isLoopback(req)) {
      json(res, 403, { status: 'error', error: 'Forbidden' });
      return true;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      json(res, 400, { status: 'error', error: 'Invalid JSON body' });
      return true;
    }

    if (
      !body ||
      typeof body !== 'object' ||
      !Array.isArray((body as Record<string, unknown>).notifications)
    ) {
      json(res, 400, { status: 'error', error: 'body.notifications must be an array' });
      return true;
    }

    const raw = (body as { notifications: unknown[] }).notifications;
    const { accepted: valid, rejected } = filterFreshRuntimeNotifications(raw, Date.now(), STALE_THRESHOLD_MS);

    if (valid.length > 0) {
      emitNotifications(valid);
    }

    json(res, 200, { status: 'success', data: { accepted: valid.length, rejected } });
    return true;
  }

  return { handleNotifyRoute };
}
