/**
 * server-runtime-core
 *
 * Shared, face-agnostic building blocks for the split server-runtime packages:
 *   - server-runtime-agentface  (POST /mcp, /mcp-raw)
 *   - server-runtime-controlface (/board/*, /cards/*, /mcp-controlplane)
 *   - server-runtime-watchers    (/sse + chat/notify watchers; sole sseHub owner)
 *   - server-runtime-webhooks    (/mcp-webhooks)
 *   - server-jobs-queue-runner   (drains 3 lanes; no HTTP)
 *
 * This package exposes types, MCP tool registries, queue-lane registry,
 * notification helpers, runtime payload assembly, MCP facade, MCP invoker,
 * and other utilities that the face packages share. No HTTP handling lives
 * here; faces compose these primitives.
 */

// ── Public types (re-exported from the original server-runtime/types.ts) ────
export * from '../server-runtime/types.js';

// ── Queue lanes (drainer registry + options) ────────────────────────────────
export * from '../server-runtime/queue-lanes.js';

// ── Notification state helpers ──────────────────────────────────────────────
export {
  makeNotificationState,
  hasNonEmptyCardCountStatus,
  appendNotification,
} from '../server-runtime/notifications.js';
export type { NotificationState } from '../server-runtime/notifications.js';

// ── MCP tool registries ─────────────────────────────────────────────────────
export {
  createMcpToolRegistry,
  createMcpWebhookToolRegistry,
  createMcpControlplaneToolRegistry,
} from '../server-runtime/mcp-tool-registries.js';
export type {
  ToolRegistry,
  McpFacadeForRegistry,
  McpWebhookFacadeForRegistry,
  McpControlplaneRegistryDeps,
} from '../server-runtime/mcp-tool-registries.js';

// ── MCP invoker ─────────────────────────────────────────────────────────────
export {
  invokeMcpTool,
  extractMcpFailureMessage,
} from '../server-runtime/mcp-invoker.js';
export type {
  McpToolHandler,
  McpToolRegistry,
} from '../server-runtime/mcp-invoker.js';

// ── MCP arg coercion helpers ────────────────────────────────────────────────
export * from '../server-runtime/mcp-args.js';

// ── MCP facade builder ──────────────────────────────────────────────────────
export { createMcpFacadeModule } from '../server-runtime/mcp-facade.js';
export type {
  McpFacadeBoardContextLike,
  McpFacadeDeps,
  McpFacadeModule,
} from '../server-runtime/mcp-facade.js';

// ── Runtime payload assembler ───────────────────────────────────────────────
export { createRuntimePayloadModule } from '../server-runtime/runtime-payload.js';
export type {
  RuntimePayloadBoardContext,
  RuntimePayloadDeps,
  RuntimePayloadModule,
} from '../server-runtime/runtime-payload.js';

// ── Controlplane tool handler builder ───────────────────────────────────────
export { createControlplaneToolHandlers } from '../server-runtime/controlplane-tool-handlers.js';

// ── Controlplane request/response helpers ───────────────────────────────────
export * from '../server-runtime/controlplane-helpers.js';

// ── Card-file ops helpers (file upload/download orchestration) ──────────────
export { createCardFileOps } from '../server-runtime/card-file-ops.js';

// ── Internal helpers (escapeRegExp, concatUint8Arrays, async adapter check) ─
export {
  isAsyncBoardPlatformAdapter,
  executionWhatToRunValue,
  escapeRegExp,
  concatUint8Arrays,
} from '../server-runtime/internal-helpers.js';
