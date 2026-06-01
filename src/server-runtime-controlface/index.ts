/**
 * server-runtime-controlface
 *
 * Control-plane routes + top-level runtime factories.
 *   GET  /init-board, /board-status
 *   POST /mcp-controlplane
 *   GET|PATCH /cards/:id
 *   POST /cards/:id/retrigger, /actions
 *   GET|POST /cards/:id/chats
 *   POST|GET /cards/:id/files
 *
 * Also re-exports createSingleBoardServerRuntime and
 * createMultiBoardServerRuntime for consumers that want the full
 * composition point.
 */
export type { RoutesRuntimeApiDeps, RoutesRuntimeApi } from '../server-runtime/routes-runtime-api.js';
export { createRoutesRuntimeApi } from '../server-runtime/routes-runtime-api.js';

export type {
  SingleBoardRuntimeOptions,
  MultiBoardRuntimeOptions,
  SingleBoardRuntime,
  MultiBoardRuntime,
} from '../server-runtime/index.js';
export {
  createSingleBoardServerRuntime,
  createMultiBoardServerRuntime,
} from '../server-runtime/index.js';
