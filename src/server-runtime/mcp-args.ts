/**
 * server-runtime/mcp-args.ts
 *
 * Pure MCP tool argument parsers. These read from the args record and do not
 * touch runtime state. Kept here so the index closure does not redefine them.
 */

export function getMcpArgString(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof args[key] === 'string') return String(args[key]);
  }
  return '';
}

export function getMcpArgNumber(args: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    if (args[key] !== undefined) return Number(args[key]);
  }
  return undefined;
}

export function getMcpArgRecord(args: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  for (const key of keys) {
    const value = args[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  return {};
}

export function getRequiredMcpArgRecord(
  args: Record<string, unknown>,
  errorKey: string,
  ...keys: string[]
): Record<string, unknown> {
  for (const key of keys) {
    const value = args[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  }
  throw Object.assign(new Error(`MCP tool requires ${errorKey}`), { statusCode: 400 });
}

export function getRequiredMcpArgNumber(
  args: Record<string, unknown>,
  errorKey: string,
  ...keys: string[]
): number {
  for (const key of keys) {
    const value = args[key];
    if (value !== undefined) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  throw Object.assign(new Error(`MCP tool requires ${errorKey}`), { statusCode: 400 });
}

export function parseMcpUploadBytes(args: Record<string, unknown>): Uint8Array | null {
  if (Array.isArray(args.bytes)) {
    return new Uint8Array((args.bytes as unknown[]).map((value) => Math.max(0, Math.min(255, Number(value) || 0))));
  }
  if (typeof args.text === 'string') {
    return new TextEncoder().encode(args.text);
  }
  if (typeof args.base64 === 'string') {
    const base64 = String(args.base64).replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
    const binStr = atob(padded);
    return Uint8Array.from(binStr, (ch) => ch.charCodeAt(0));
  }
  return null;
}
