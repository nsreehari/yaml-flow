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
import type { ArgsMassaging, OutputTransforms } from './execution-interface.js';
import type { NormalizedHandlerResult } from '../../step-machine-public/types.js';

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

/**
 * Apply `outputTransforms` to a raw invoke result.
 *
 * Context for all expressions: `{ output }` where `output` is the raw
 * { result, data, error? } envelope from invokeRefSync.
 *
 * Returns a new NormalizedHandlerResult with overrides applied.
 * Throws with a label-tagged message if any expression fails.
 */
export function resolveOutputTransforms(
  transforms: OutputTransforms | undefined,
  raw: NormalizedHandlerResult,
  label: string,
): NormalizedHandlerResult {
  if (!transforms || typeof transforms !== 'object') return raw;

  const ctx = { output: raw };
  let result = raw.result;
  let data = raw.data;
  let error = raw.error;

  if (typeof transforms.resultExpr === 'string') {
    try {
      const val = jsonata(transforms.resultExpr).evaluate(ctx);
      if (typeof val !== 'string' || !val.trim()) {
        throw new Error(`resultExpr did not produce a non-empty string (got ${JSON.stringify(val)})`);
      }
      result = val;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[${label}] outputTransforms.resultExpr failed: ${msg}`);
    }
  }

  if (typeof transforms.dataTemplate === 'string') {
    try {
      const val = jsonata(transforms.dataTemplate).evaluate(ctx);
      if (!val || typeof val !== 'object' || Array.isArray(val)) {
        throw new Error(`dataTemplate did not produce an object (got ${JSON.stringify(val)})`);
      }
      data = val as Record<string, unknown>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[${label}] outputTransforms.dataTemplate failed: ${msg}`);
    }
  }

  if (typeof transforms.errorExpr === 'string') {
    try {
      const val = jsonata(transforms.errorExpr).evaluate(ctx);
      // $undefined() evaluates to undefined — clears the error field
      error = val != null ? String(val) : undefined;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[${label}] outputTransforms.errorExpr failed: ${msg}`);
    }
  }

  return error !== undefined
    ? { result, data, error }
    : { result, data };
}
