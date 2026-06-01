/**
 * server-runtime-webhooks
 *
 * Worker-callback webhook routes.
 *   POST /callback/board-worker/:token/success
 *   POST /callback/board-worker/:token/failure
 */
export type { RoutesWebhooksDeps, RoutesWebhooks } from '../server-runtime/routes-webhooks.js';
export { createRoutesWebhooks } from '../server-runtime/routes-webhooks.js';
