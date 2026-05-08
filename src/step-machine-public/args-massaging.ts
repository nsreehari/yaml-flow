/**
 * step-machine-public — args massaging
 *
 * Pure JSONata-based mapping from logical args (the flow's flat context)
 * into a transport-specific shape. Lives here because:
 *
 *   - It is platform-free (only depends on jsonata).
 *   - Multiple adapters (Node spawn, HTTP, Azure Function) reuse it.
 *
 * Adapters call this helper as the first step inside `invoke(ref, input)`,
 * then perform their transport using `cmdArgs` / `body` / `url`.
 */

import { jsonata } from './jsonata-loader.js';
import type { ArgsMassaging } from '../cli/common/execution-interface.js';

export interface MassagedArgs {
  /** Resolved argv tail for local transports. */
  cmdArgs?: string[];
  /** Resolved request body object for http transports. */
  body?: unknown;
  /** Resolved final URL string for http transports. */
  url?: string;
}

/**
 * Evaluate `argsMassaging` against the supplied context.
 *
 * Throws with a step-name-tagged message if any expression fails — adapters
 * should catch and convert to a normalized failure result.
 */
export function resolveArgsMassaging(
  argsMassaging: ArgsMassaging | undefined,
  context: Record<string, unknown>,
  stepName: string,
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
          `[step-machine-public] Step "${stepName}" argsMassaging.cmdTemplate failed on "${expr}": ${msg}`,
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
        `[step-machine-public] Step "${stepName}" argsMassaging.bodyTemplate failed: ${msg}`,
      );
    }
  }

  if (typeof argsMassaging.urlTemplate === 'string') {
    try {
      out.url = String(jsonata(argsMassaging.urlTemplate).evaluate(context));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[step-machine-public] Step "${stepName}" argsMassaging.urlTemplate failed: ${msg}`,
      );
    }
  }

  return out;
}
