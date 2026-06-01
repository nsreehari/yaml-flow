/**
 * server-runtime/mcp-invoker.ts
 *
 * Pure helpers for invoking MCP tools through a registry and turning a tool
 * result into a human-readable error message. Both helpers are platform-free
 * and depend only on plain values — no closure state.
 */

export type McpToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;
export type McpToolRegistry = Record<string, McpToolHandler>;

/**
 * Look up `tool` in `registry` and invoke it with `args`. Normalises the
 * returned shape so callers always see `{ status, data? }` (or an explicit
 * `fail` / `error` envelope). Throws an Error tagged with `statusCode: 400`
 * if the tool is unknown.
 */
export async function invokeMcpTool(
  tool: string,
  args: Record<string, unknown>,
  registry: McpToolRegistry,
): Promise<unknown> {
  const handler = registry[tool];
  if (!handler) {
    throw Object.assign(new Error(`Unknown MCP tool: ${tool}`), { statusCode: 400 });
  }
  const result = await handler(args);
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const record = result as Record<string, unknown>;
    const status = record.status;
    if (status === 'success') {
      return Object.prototype.hasOwnProperty.call(record, 'data')
        ? result
        : { status: 'success', data: {} };
    }
    if (status === 'fail' || status === 'error') {
      return result;
    }
  }
  return { status: 'success', data: result };
}

/**
 * Extract a single human-readable failure message from an MCP tool result,
 * looking through validation envelopes for the first useful issue string.
 * Returns `fallback` when nothing better can be found.
 */
export function extractMcpFailureMessage(result: unknown, fallback: string): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return fallback;
  const record = result as Record<string, unknown>;
  if (typeof record.error === 'string' && record.error.trim()) return record.error;
  if (record.step === 'validate') {
    const validation = record.validation;
    if (validation && typeof validation === 'object' && !Array.isArray(validation)) {
      const validationRecord = validation as Record<string, unknown>;
      const validationData = validationRecord.data;
      if (validationData && typeof validationData === 'object' && !Array.isArray(validationData)) {
        const issues = (validationData as Record<string, unknown>).issues;
        if (Array.isArray(issues)) {
          const firstIssue = issues.find((issue) => typeof issue === 'string' && issue.trim());
          if (typeof firstIssue === 'string') return `Validation failed: ${firstIssue}`;
        }
        const errors = (validationData as Record<string, unknown>).errors;
        if (Array.isArray(errors) && errors.length > 0) {
          return 'Validation failed';
        }
      }
    }
    return 'Validation failed';
  }
  return fallback;
}
