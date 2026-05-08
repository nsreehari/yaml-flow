/**
 * step-machine-public — result utilities
 *
 * Pure helpers that:
 *  - Normalize handler return shapes into NormalizedHandlerResult.
 *  - Filter `data` to the keys declared in `produces_data`.
 *  - Wrap a handler with output filtering / input validation.
 *
 * No transport, no I/O — only object reshaping.
 */

import type { NormalizedHandlerResult, StepHandler } from './types.js';
import { jsonata } from './jsonata-loader.js';

// ============================================================================
// normalizeHandlerResult — accept legacy or strict shape
// ============================================================================

export function normalizeHandlerResult(
  raw: unknown,
  stepName: string,
): NormalizedHandlerResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`[step-machine-public] Step "${stepName}" returned a non-object result.`);
  }

  const obj = raw as Record<string, unknown>;
  const result = (obj.result ?? obj.status) as unknown;

  // Strict envelope: { result, data, error? }
  if (typeof result === 'string' && result.trim().length > 0) {
    const data: Record<string, unknown> =
      obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)
        ? { ...(obj.data as Record<string, unknown>) }
        : {};
    const error = typeof obj.error === 'string' ? (obj.error as string) : undefined;
    if (error && !('error' in data)) {
      data.error = error;
    }
    return { result, data, ...(error ? { error } : {}) };
  }

  // Bare object — treat the whole thing as data, intent = success.
  return { result: 'success', data: { ...obj } };
}

// ============================================================================
// filterProducedData — narrow data to declared produces_data keys
// ============================================================================

export function filterProducedData(
  data: Record<string, unknown>,
  produces: string[] | undefined,
): Record<string, unknown> {
  if (!produces || produces.length === 0) return data;
  const filtered: Record<string, unknown> = {};
  for (const key of produces) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      filtered[key] = data[key];
    }
  }
  return filtered;
}

// ============================================================================
// wrapWithOutputFiltering — compose normalization + produces_data filtering
// ============================================================================

export function wrapWithOutputFiltering(
  handler: StepHandler,
  produces: string[] | undefined,
): StepHandler {
  return async (input, context) => {
    const raw = await handler(input, context);
    const normalized = normalizeHandlerResult(raw, context?.stepName ?? 'unknown');
    return {
      result: normalized.result,
      data: filterProducedData(normalized.data, produces),
      ...(normalized.error ? { error: normalized.error } : {}),
    };
  };
}

// ============================================================================
// runInputValidations — evaluate validation expressions
// ============================================================================

/**
 * Evaluate each validation as a JSONata expression returning truthy.
 *
 * Returns `null` on success, or a normalized failure result on the first
 * failed/throwing validation.
 */
export function runInputValidations(
  input: Record<string, unknown>,
  validations: string[] | undefined,
  stepName: string,
): NormalizedHandlerResult | null {
  if (!validations || validations.length === 0) return null;
  for (const expr of validations) {
    try {
      const ok = jsonata(expr).evaluate(input);
      if (!ok) {
        return {
          result: 'failure',
          data: { error: `[${stepName}] input validation failed: ${expr}` },
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        result: 'failure',
        data: { error: `[${stepName}] input validation error on "${expr}": ${msg}` },
      };
    }
  }
  return null;
}

// ============================================================================
// wrapWithInputValidations — short-circuit if any validation fails
// ============================================================================

export function wrapWithInputValidations(
  handler: StepHandler,
  validations: string[] | undefined,
  stepName: string,
): StepHandler {
  if (!validations || validations.length === 0) return handler;
  return async (input, context) => {
    const failure = runInputValidations(input, validations, stepName);
    if (failure) return failure;
    return handler(input, context);
  };
}
