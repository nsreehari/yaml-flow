/**
 * schema-validator — Full JSON Schema validation for published runtime artifacts.
 *
 * Uses AJV to validate against the published board-status.schema.json and
 * card-runtime.schema.json contracts.
 */

import boardStatusSchema from '../../schema/board-status.schema.json';
import cardRuntimeSchema from '../../schema/card-runtime.schema.json';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

export interface SchemaValidationResult {
  ok: boolean;
  errors: string[];
}

type AjvValidateFunction = {
  (data: unknown): boolean;
  errors?: Array<{ instancePath?: string; message?: string }> | null;
};

let boardStatusValidator: AjvValidateFunction | null = null;
let cardRuntimeValidator: AjvValidateFunction | null = null;

function createAjv(): Ajv2020 {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  return ajv;
}

function toValidationResult(validate: AjvValidateFunction): SchemaValidationResult {
  const errors = (validate.errors ?? []).map((error) => {
    const instancePath = error.instancePath || '/';
    return `${instancePath}: ${error.message ?? 'unknown error'}`;
  });
  return { ok: false, errors };
}

function getBoardStatusValidator(): AjvValidateFunction {
  if (boardStatusValidator) return boardStatusValidator;
  boardStatusValidator = createAjv().compile(boardStatusSchema);
  return boardStatusValidator;
}

function getCardRuntimeValidator(): AjvValidateFunction {
  if (cardRuntimeValidator) return cardRuntimeValidator;
  cardRuntimeValidator = createAjv().compile(cardRuntimeSchema);
  return cardRuntimeValidator;
}

export function validateBoardStatusSchema(statusObject: unknown): SchemaValidationResult {
  const validate = getBoardStatusValidator();
  if (validate(statusObject)) return { ok: true, errors: [] };
  return toValidationResult(validate);
}

export function validateCardRuntimeSchema(cardRuntimeObject: unknown): SchemaValidationResult {
  const validate = getCardRuntimeValidator();
  if (validate(cardRuntimeObject)) return { ok: true, errors: [] };
  return toValidationResult(validate);
}
