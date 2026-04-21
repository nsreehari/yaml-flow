/**
 * schema-validator — Full JSON Schema validation for LiveCards nodes.
 *
 * Uses AJV to validate against the published live-cards.schema.json.
 * For a lightweight sync check without AJV, use `CardCompute.validate()` instead.
 *
 * @example
 * ```typescript
 * import { validateLiveCardSchema } from 'yaml-flow/card-compute';
 *
 * const result = validateLiveCardSchema(node);
 * if (!result.ok) console.error(result.errors);
 * ```
 */

import type { ValidationResult } from './index.js';
import liveCardsSchema from '../../schema/live-cards.schema.json';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import jsonata from 'jsonata';

type AjvValidateFunction = {
  (data: unknown): boolean;
  errors?: Array<{ instancePath?: string; message?: string }> | null;
};

let _compiled: AjvValidateFunction | null = null;

function getValidator(): AjvValidateFunction {
  if (_compiled) return _compiled;
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  _compiled = ajv.compile(liveCardsSchema);
  return _compiled;
}

/**
 * Validate a node against the full LiveCards JSON Schema (draft-07).
 *
 * Requires `ajv` and `ajv-formats` to be installed.
 * Returns the same `ValidationResult` shape as `CardCompute.validate()`.
 */
export function validateLiveCardSchema(
  node: unknown,
): ValidationResult {
  const validate = getValidator();
  const valid = validate(node);

  if (valid) return { ok: true, errors: [] };

  const errors = (validate.errors ?? []).map(e => {
    const path = e.instancePath || '/';
    return `${path}: ${e.message ?? 'unknown error'}`;
  });

  return { ok: false, errors };
}

/**
 * Validate JSONata expressions in compute[] by compiling with the same parser used at runtime.
 */
export function validateLiveCardRuntimeExpressions(
  node: unknown,
): ValidationResult {
  const errors: string[] = [];

  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return { ok: true, errors: [] };
  }

  const compute = (node as Record<string, unknown>).compute;
  if (!Array.isArray(compute)) {
    return { ok: true, errors: [] };
  }

  compute.forEach((step, i) => {
    if (!step || typeof step !== 'object' || Array.isArray(step)) return;

    const expr = (step as Record<string, unknown>).expr;
    if (typeof expr !== 'string' || expr.trim().length === 0) return;

    try {
      jsonata(expr);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`/compute/${i}/expr: invalid JSONata expression (${message})`);
    }
  });

  return { ok: errors.length === 0, errors };
}

/**
 * Full validation for live card definitions:
 * 1) JSON Schema structure/contract checks
 * 2) Runtime JSONata parser compatibility checks for compute expressions
 */
export function validateLiveCardDefinition(
  node: unknown,
): ValidationResult {
  const schema = validateLiveCardSchema(node);
  if (!schema.ok) return schema;

  const runtime = validateLiveCardRuntimeExpressions(node);
  if (!runtime.ok) return { ok: false, errors: runtime.errors };

  return { ok: true, errors: [] };
}
