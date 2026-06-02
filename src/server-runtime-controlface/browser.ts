/**
 * server-runtime-controlface/browser
 *
 * Full browser/runtime entrypoint for the ServerRuntimeControlface bundle.
 * Unlike the npm package barrel, this keeps the full dispatcher surface,
 * including control routes and watchers/SSE.
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