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
  'source_defs',
] as const;

type KnownNamespace = typeof KNOWN_NAMESPACES[number];

const NAMESPACE_REFERENCE_RE = /\b(card_data|requires|fetched_sources|computed_values|source_defs)\b/g;
const ROOT_PATH_NAMESPACE_RE = /^\s*(card_data|requires|fetched_sources|computed_values|source_defs)(\.|$)/;

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

  const errors = (validate.errors ?? []).map(e => {
    const path = e.instancePath || '/';
    return `${path}: ${e.message ?? 'unknown error'}`;
  });

  // JSON Schema draft-07 cannot enforce per-property uniqueness across array items.
  // Check bindTo and outputFile uniqueness here after the AJV structural pass.
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    const source_defs = (node as Record<string, unknown>).source_defs;
    if (Array.isArray(source_defs)) {
      const bindTos = new Set<string>();
      const outputFiles = new Set<string>();
      source_defs.forEach((src, i) => {
        if (!src || typeof src !== 'object' || Array.isArray(src)) return;
        const s = src as Record<string, unknown>;
        if (typeof s.bindTo === 'string' && s.bindTo) {
          if (bindTos.has(s.bindTo)) {
            errors.push(`/source_defs/${i}/bindTo: bindTo "${s.bindTo}" must be unique across all source_defs`);
          }
          bindTos.add(s.bindTo);
        }
        if (typeof s.outputFile === 'string' && s.outputFile) {
          if (outputFiles.has(s.outputFile)) {
            errors.push(`/source_defs/${i}/outputFile: outputFile "${s.outputFile}" must be unique across all source_defs`);
          }
          outputFiles.add(s.outputFile);
        }
      });
    }
  }

  if (!valid || errors.length > 0) return { ok: false, errors };
  return { ok: true, errors: [] };
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

  // Validate provides[].src paths use a valid root namespace.
  const VALID_PROVIDES_SRC_NAMESPACES = new Set<KnownNamespace>([
    'card_data', 'requires', 'fetched_sources', 'computed_values',
  ]);
  const provides = asRecord.provides;
  if (Array.isArray(provides)) {
    provides.forEach((entry, i) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
      const src = (entry as Record<string, unknown>).src;
      if (typeof src !== 'string' || src.trim().length === 0) return;
      const rootNamespace = parseRootPathNamespace(src);
      if (rootNamespace === null) {
        errors.push(`/provides/${i}/src: path "${src}" must start with a valid namespace (${[...VALID_PROVIDES_SRC_NAMESPACES].join(', ')})`);
      } else if (!VALID_PROVIDES_SRC_NAMESPACES.has(rootNamespace)) {
        errors.push(`/provides/${i}/src: disallowed namespace "${rootNamespace}" in path "${src}" (valid: ${[...VALID_PROVIDES_SRC_NAMESPACES].join(', ')})`);
      }
    });
  }

  const view = asRecord.view;
  if (view && typeof view === 'object' && !Array.isArray(view)) {
    walkViewPathReferences(view, '/view', errors);
  }

  // Validate source_defs[i].refs values: each must be a JSONata expression rooted at
  // card_data or requires only. fetched_sources/computed_values/source_defs are not
  // valid here because sources run before those namespaces exist.
  const VALID_REFS_NAMESPACES = new Set<KnownNamespace>(['card_data', 'requires']);
  const source_defs = asRecord.source_defs;
  if (Array.isArray(source_defs)) {
    source_defs.forEach((srcDef, i) => {
      if (!srcDef || typeof srcDef !== 'object' || Array.isArray(srcDef)) return;
      const refs = (srcDef as Record<string, unknown>).refs;
      if (!refs || typeof refs !== 'object' || Array.isArray(refs)) return;
      for (const [key, exprVal] of Object.entries(refs as Record<string, unknown>)) {
        if (typeof exprVal !== 'string' || exprVal.trim().length === 0) continue;
        validateJsonataExprWithNamespaces(
          exprVal,
          `/source_defs/${i}/refs/${key}`,
          VALID_REFS_NAMESPACES,
          errors,
        );
      }
    });
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
