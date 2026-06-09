/**
 * server-runtime/controlplane-helpers.ts
 *
 * Pure helpers used by the runtime's controlplane MCP handlers. The handlers
 * themselves still live in index.ts because they capture closure state; these
 * utilities are stateless.
 */

import type { CommandResult } from '../cli/common/board-live-cards-public.js';
import { getMcpArgString } from './mcp-args.js';

export function expectControlplaneSuccess<T>(result: CommandResult<T>, commandName: string): T {
  if (result?.status === 'success') {
    return Object.prototype.hasOwnProperty.call(result, 'data')
      ? (result as { data: T }).data
      : (undefined as T);
  }
  if (result?.status === 'fail' || result?.status === 'error') {
    throw Object.assign(new Error(result.error || `${commandName} failed`), { statusCode: 400 });
  }
  throw Object.assign(new Error(`${commandName} returned an unexpected response`), { statusCode: 500 });
}

export async function expectControlplaneSuccessAsync<T>(
  result: CommandResult<T> | Promise<CommandResult<T>>,
  commandName: string,
): Promise<T> {
  return expectControlplaneSuccess(await result, commandName);
}

export function getCardMetaKey(args: Record<string, unknown>): string {
  const key = getMcpArgString(args, 'key');
  if (!key) throw Object.assign(new Error('MCP tool requires key'), { statusCode: 400 });
  const segments = key.split('.');
  // Any namespace is allowed under __private. Keys must still have at least two
  // segments (so reserved top-level flags such as visible_controlplane_only are
  // not addressable) and each segment must be an identifier (blocks dotted-path
  // tricks and prototype-pollution segments like __proto__).
  const valid = segments.length >= 2
    && segments.every((segment) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(segment));
  if (!valid) throw Object.assign(new Error('MCP tool requires a card private key with at least two identifier segments (e.g. chat.foundry_thread_id)'), { statusCode: 400 });
  return key;
}

export function readCardMetaValue(
  card: Record<string, unknown>,
  key: string,
): { exists: boolean; value: unknown } {
  let target: unknown = card.__private;
  for (const segment of key.split('.')) {
    if (!target || typeof target !== 'object' || Array.isArray(target) || !Object.prototype.hasOwnProperty.call(target, segment)) {
      return { exists: false, value: null };
    }
    target = (target as Record<string, unknown>)[segment];
  }
  return { exists: true, value: target };
}
