/**
 * schema-validator — Full JSON Schema validation for StepFlow configs.
 *
 * Uses AJV to validate against the published flow.schema.json.
 * For a lightweight sync check without AJV, use `validateStepFlowConfig()` instead.
 *
 * @example
 * ```typescript
 * import { validateFlowSchema } from 'yaml-flow/step-machine';
 *
 * const result = validateFlowSchema(config);
 * if (!result.ok) console.error(result.errors);
 * ```
 */

import flowSchema from '../../schema/flow.schema.json';
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
  _compiled = ajv.compile(flowSchema);
  return _compiled;
}

/**
 * Validate a step-flow config against the full flow.schema.json (draft-07).
 *
 * Requires `ajv` and `ajv-formats` to be installed.
 */
export function validateFlowSchema(
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
