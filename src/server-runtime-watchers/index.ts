/**
 * server-runtime-watchers
 *
 * SSE connection management and subscription routes — sole owner of SseHub.
 *   GET  /sse
 *   POST /cards/:id/chats/(un)subscribe-sse
 *   POST /watch-channel/:name/(subscribe|unsubscribe)-sse
 *   POST /cards/:id/watch-channel/:name/(subscribe|unsubscribe)-sse
 */
export type { RoutesWatchersDeps, RoutesWatchers } from '../server-runtime/routes-watchers.js';
export { createRoutesWatchers } from '../server-runtime/routes-watchers.js';

export type { SseHub, SseHubDeps } from '../server-runtime/sse-hub.js';
export { createSseHub } from '../server-runtime/sse-hub.js';
