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

import { jsonata, type JsonataExpression } from './jsonata-loader.js';
import { serializeRef } from './storage-interface.js';
import type { ArgsMassaging, OutputTransforms } from './execution-interface.js';
import type { NormalizedHandlerResult } from '../../step-machine-public/types.js';

/** Register built-in helper functions available in all JSONata template expressions. */
function registerHelpers(expr: JsonataExpression): void {
  // $fsPathRef(path) — serialize a filesystem path as a KindValueRef string
  expr.registerFunction('fsPathRef', (path: unknown) => serializeRef({ kind: 'fs-path', value: String(path) }), '<s:s>');
}

export interface MassagedArgs {
  /** Resolved argv tail for local transports. */
  cmdArgs?: string[];
  /** Resolved stdin payload for local transports. */
  stdin?: unknown;
  /** Resolved final URL string for http transports. */
  url?: string;
  /** Resolved request headers for http transports. */
  headers?: Record<string, string>;
  /** Resolved request body for http transports. */
  body?: unknown;
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

  // ── Local transport fields ──────────────────────────────────────────────

  if (Array.isArray(argsMassaging.cmdTemplate)) {
    const resolved: string[] = [];
    for (const expr of argsMassaging.cmdTemplate) {
      try {
        const _ce = jsonata(expr); registerHelpers(_ce);
        resolved.push(String(_ce.evaluate(context)));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[${label}] argsMassaging.cmdTemplate failed on "${expr}": ${msg}`,
        );
      }
    }
    out.cmdArgs = resolved;
  }

  if (typeof argsMassaging.stdinTemplate === 'string') {
    try {
      const _se = jsonata(argsMassaging.stdinTemplate); registerHelpers(_se);
      out.stdin = _se.evaluate(context);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[${label}] argsMassaging.stdinTemplate failed: ${msg}`,
      );
    }
  }

  // ── HTTP transport fields ───────────────────────────────────────────────

  if (typeof argsMassaging.urlTemplate === 'string') {
    try {
      const _ue = jsonata(argsMassaging.urlTemplate); registerHelpers(_ue);
      out.url = String(_ue.evaluate(context));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[${label}] argsMassaging.urlTemplate failed: ${msg}`,
      );
    }
  }

  if (typeof argsMassaging.headerTemplate === 'string') {
    try {
      const _he = jsonata(argsMassaging.headerTemplate); registerHelpers(_he);
      const evaluated = _he.evaluate(context);
      if (typeof evaluated !== 'object' || evaluated === null) {
        throw new Error(`headerTemplate must produce an object, got: ${JSON.stringify(evaluated)}`);
      }
      out.headers = evaluated as Record<string, string>;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[${label}] argsMassaging.headerTemplate failed: ${msg}`,
      );
    }
  }

  if (typeof argsMassaging.bodyTemplate === 'string') {
    try {
      const _be = jsonata(argsMassaging.bodyTemplate); registerHelpers(_be);
      out.body = _be.evaluate(context);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[${label}] argsMassaging.bodyTemplate failed: ${msg}`,
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
      const _re = jsonata(transforms.resultExpr); registerHelpers(_re);
      const val = _re.evaluate(ctx);
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
      const _dt = jsonata(transforms.dataTemplate); registerHelpers(_dt);
      const val = _dt.evaluate(ctx);
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
      const _ee = jsonata(transforms.errorExpr); registerHelpers(_ee);
      const val = _ee.evaluate(ctx);
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
