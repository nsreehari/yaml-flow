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

const KNOWN_NAMESPACES = [
  'card_data',
  'requires',
  'fetched_sources',
  'computed_values',
  'sources',
] as const;

type KnownNamespace = typeof KNOWN_NAMESPACES[number];

const NAMESPACE_REFERENCE_RE = /\b(card_data|requires|fetched_sources|computed_values|sources)\b/g;
const ROOT_PATH_NAMESPACE_RE = /^\s*(card_data|requires|fetched_sources|computed_values|sources)(\.|$)/;

function referencedNamespaces(expression: string): Set<KnownNamespace> {
  const namespaces = new Set<KnownNamespace>();
  let match: RegExpExecArray | null;
  NAMESPACE_REFERENCE_RE.lastIndex = 0;
  while ((match = NAMESPACE_REFERENCE_RE.exec(expression)) !== null) {
    namespaces.add(match[1] as KnownNamespace);
  }
  return namespaces;
}

function parseRootPathNamespace(pathValue: string): KnownNamespace | null {
  const match = ROOT_PATH_NAMESPACE_RE.exec(pathValue);
  return match ? (match[1] as KnownNamespace) : null;
}

function validateJsonataExprWithNamespaces(
  expr: string,
  path: string,
  allowedNamespaces: Set<KnownNamespace>,
  errors: string[],
): void {
  try {
    jsonata(expr);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push(`${path}: invalid JSONata expression (${message})`);
    return;
  }

  const usedNamespaces = referencedNamespaces(expr);
  for (const namespace of usedNamespaces) {
    if (!allowedNamespaces.has(namespace)) {
      errors.push(`${path}: disallowed namespace "${namespace}" in expression`);
    }
  }
}

function walkViewPathReferences(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      walkViewPathReferences(entry, `${path}/${index}`, errors);
    });
    return;
  }

  if (typeof value === 'string') {
    const rootNamespace = parseRootPathNamespace(value);
    if (!rootNamespace) return;
    if (!new Set<KnownNamespace>(['card_data', 'requires', 'fetched_sources', 'computed_values']).has(rootNamespace)) {
      errors.push(`${path}: disallowed namespace "${rootNamespace}" in view reference`);
    }
    return;
  }

  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  for (const [key, next] of Object.entries(record)) {
    walkViewPathReferences(next, `${path}/${key}`, errors);
  }
}

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

  const asRecord = node as Record<string, unknown>;

  const compute = asRecord.compute;
  if (Array.isArray(compute)) {
    compute.forEach((step, i) => {
      if (!step || typeof step !== 'object' || Array.isArray(step)) return;
      const expr = (step as Record<string, unknown>).expr;
      if (typeof expr !== 'string' || expr.trim().length === 0) return;
      validateJsonataExprWithNamespaces(
        expr,
        `/compute/${i}/expr`,
        new Set<KnownNamespace>(['card_data', 'requires', 'fetched_sources', 'computed_values']),
        errors,
      );
    });
  }

  const view = asRecord.view;
  if (view && typeof view === 'object' && !Array.isArray(view)) {
    walkViewPathReferences(view, '/view', errors);
  }

  return { ok: errors.length === 0, errors };
}

export function validateLiveCard(
  node: unknown,
): ValidationResult {
  return validateLiveCardDefinition(node);
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
