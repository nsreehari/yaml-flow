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
