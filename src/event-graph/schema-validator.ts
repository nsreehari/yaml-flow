/**
 * schema-validator — Full JSON Schema validation for EventGraph configs.
 *
 * Uses AJV to validate against the published event-graph.schema.json.
 * For a lightweight sync check without AJV, use `validateGraphConfig()` instead.
 *
 * @example
 * ```typescript
 * import { validateGraphSchema } from 'yaml-flow/event-graph';
 *
 * const result = validateGraphSchema(config);
 * if (!result.ok) console.error(result.errors);
 * ```
 */

import graphSchema from '../../schema/event-graph.schema.json';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

export interface SchemaValidationResult {
  ok: boolean;
  errors: string[];
}

type AjvValidateFunction = {
  (data: unknown): boolean;
  errors?: Array<{ instancePath?: string; message?: string }> | null;
};

let _compiled: AjvValidateFunction | null = null;

function getValidator(): AjvValidateFunction {
  if (_compiled) return _compiled;
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  _compiled = ajv.compile(graphSchema);
  return _compiled;
}

/**
 * Validate an event-graph config against the full event-graph.schema.json (draft-07).
 *
 * Requires `ajv` and `ajv-formats` to be installed.
 */
export function validateGraphSchema(
  config: unknown,
): SchemaValidationResult {
  const validate = getValidator();
  const valid = validate(config);

  if (valid) return { ok: true, errors: [] };

  const errors = (validate.errors ?? []).map(e => {
    const path = e.instancePath || '/';
    return `${path}: ${e.message ?? 'unknown error'}`;
  });

  return { ok: false, errors };
}
