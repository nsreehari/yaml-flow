/**
 * cli/common/args-massaging — JSONata-based mapping from logical args to
 * transport-specific shape.
 *
 * `argsMassaging` is a property of `ExecutionRef`, so honoring it is the job
 * of every adapter (Node spawn, HTTP, Azure Function, etc.). This helper is
 * the shared pure-JSONata implementation reused by all adapters.
 *
 * Adapters call this as the first step inside their `invokeRefSync` /
 * `dispatchExecution` implementation, then perform their transport using
 * `cmdArgs` / `body` / `url`.
 */

import { jsonata } from './jsonata-loader.js';
import type { ArgsMassaging } from './execution-interface.js';

export interface MassagedArgs {
  /** Resolved argv tail for local transports. */
  cmdArgs?: string[];
  /** Resolved request body for http transports (or stdin payload for local). */
  body?: unknown;
  /** Resolved final URL string for http transports. */
  url?: string;
}

/**
 * Evaluate `argsMassaging` against the supplied context.
 *
 * Throws with a label-tagged message if any expression fails. Adapters
 * should catch and convert to a normalized failure result.
 */
export function resolveArgsMassaging(
  argsMassaging: ArgsMassaging | undefined,
  context: Record<string, unknown>,
  label: string,
): MassagedArgs {
  if (!argsMassaging || typeof argsMassaging !== 'object') return {};

  const out: MassagedArgs = {};

  if (Array.isArray(argsMassaging.cmdTemplate)) {
    const resolved: string[] = [];
    for (const expr of argsMassaging.cmdTemplate) {
      try {
        resolved.push(String(jsonata(expr).evaluate(context)));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[${label}] argsMassaging.cmdTemplate failed on "${expr}": ${msg}`,
        );
      }
    }
    out.cmdArgs = resolved;
  }

  if (typeof argsMassaging.bodyTemplate === 'string') {
    try {
      out.body = jsonata(argsMassaging.bodyTemplate).evaluate(context);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[${label}] argsMassaging.bodyTemplate failed: ${msg}`,
      );
    }
  }

  if (typeof argsMassaging.urlTemplate === 'string') {
    try {
      out.url = String(jsonata(argsMassaging.urlTemplate).evaluate(context));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[${label}] argsMassaging.urlTemplate failed: ${msg}`,
      );
    }
  }

  return out;
}
