/**
 * server-runtime-controlface
 *
 * MCP-only server runtime surface.
 *   POST /mcp
 *   POST /mcp-raw
 *   POST /mcp-actions
 *   POST /mcp-controlplane
 *   POST /mcp-webhooks
 *
 * This package intentionally does not expose /board-status,
 * /cards/*, or /sse watcher routes. Browser builds keep the full dispatcher
 * through a dedicated browser entrypoint.
 */
import type {
  MultiBoardRuntime,
  MultiBoardRuntimeOptions,
  SingleBoardRuntime,
  SingleBoardRuntimeOptions,
} from '../server-runtime/index.js';
import {
  createMultiBoardServerRuntime as createFullMultiBoardServerRuntime,
  createSingleBoardServerRuntime as createFullSingleBoardServerRuntime,
} from '../server-runtime/index.js';

export type {
  SingleBoardRuntimeOptions,
  MultiBoardRuntimeOptions,
  SingleBoardRuntime,
  MultiBoardRuntime,
} from '../server-runtime/index.js';

const MCP_ONLY_SUFFIXES = ['/mcp', '/mcp-raw', '/mcp-actions', '/mcp-controlplane', '/mcp-webhooks'] as const;

function isAllowedSingleBoardMcpPath(apiBasePath: string, pathName: string): boolean {
  return MCP_ONLY_SUFFIXES.some((suffix) => pathName === `${apiBasePath}${suffix}`);
}

function isAllowedMultiBoardMcpPath(apiBasePath: string, pathName: string): boolean {
  return MCP_ONLY_SUFFIXES.some((suffix) => {
    const marker = `${suffix}`;
    if (!pathName.startsWith(`${apiBasePath}/`)) return false;
    if (!pathName.endsWith(marker)) return false;
    const boardScopedPrefix = pathName.slice(apiBasePath.length + 1, pathName.length - marker.length);
    return boardScopedPrefix.length > 0 && !boardScopedPrefix.includes('/');
  });
}

export function createSingleBoardServerRuntime(options: SingleBoardRuntimeOptions): SingleBoardRuntime {
  const runtime = createFullSingleBoardServerRuntime(options);
  return {
    ...runtime,
    async handleRuntimeApi(req, res, parsedUrl) {
      if (!isAllowedSingleBoardMcpPath(runtime.apiBasePath, parsedUrl.pathname)) return false;
      return runtime.handleRuntimeApi(req, res, parsedUrl);
    },
  };
}

export function createMultiBoardServerRuntime(options: MultiBoardRuntimeOptions): MultiBoardRuntime {
  const runtime = createFullMultiBoardServerRuntime(options);
  return {
    ...runtime,
    async handleApi(req, res, parsedUrl) {
      if (!isAllowedMultiBoardMcpPath(runtime.apiBasePath, parsedUrl.pathname)) return false;
      return runtime.handleApi(req, res, parsedUrl);
    },
  };
}
