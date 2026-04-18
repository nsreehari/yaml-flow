/**
 * card-compute — JSONata-powered compute engine for LiveCards nodes.
 *
 * Isomorphic: works in browser, Node.js, and bundlers.
 * No DOM dependency. Compute expressions are JSONata strings.
 *
 * @example
 * ```typescript
 * import { CardCompute } from 'yaml-flow/card-compute';
 *
 * const node = {
 *   id: 'sales',
 *   state: { data: [{ revenue: 100 }, { revenue: 200 }] },
 *   compute: [
 *     { bindTo: 'total', expr: '$sum(state.data.revenue)' },
 *     { bindTo: 'avg',   expr: '$average(state.data.revenue)' },
 *   ],
 * };
 * await CardCompute.run(node);
 * // node.computed_values.total === 300
 * // node.computed_values.avg   === 150
 * ```
 *
 * Expressions are evaluated against { state, requires, computed_values }.
 * computed_values is ephemeral — never persisted to disk.
 */

import jsonata from 'jsonata';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A source definition: cli writes to outputFile; bindTo names the sources.* key in compute context. */
export interface ComputeSource {
  bindTo: string;
  outputFile?: string;
  cli?: string;
  // Deprecated alias retained for compatibility with older cards.
  script?: string;
  optional?: boolean;
  [key: string]: unknown;
}

/** Options for CardCompute.run() */
export interface RunOptions {
  /** Pre-loaded sources data map (keyed by bindTo). Use in browser or when caller loads files. */
  sourcesData?: Record<string, unknown>;
}

/** A single compute step: bindTo names the computed_values key; expr is a JSONata expression. */
export interface ComputeStep {
  bindTo: string;
  expr: string;
}

/** Minimal node shape expected by CardCompute. */
export interface ComputeNode {
  id?: string;
  state?: Record<string, unknown>;
  requires?: Record<string, unknown>;
  sources?: ComputeSource[];
  compute?: ComputeStep[];
  computed_values?: Record<string, unknown>;
  /** Ephemeral: populated by run() from sourcesData option. Never persisted. */
  _sourcesData?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Deep path utilities
// ---------------------------------------------------------------------------

function deepGet(obj: unknown, path: string): unknown {
  if (!path || !obj) return undefined;
  const parts = path.split('.');
  let cur: unknown = obj;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  return cur;
}

function deepSet(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

// ---------------------------------------------------------------------------
// Engine — JSONata-based async evaluation
// ---------------------------------------------------------------------------

/**
 * Run all compute steps on a node.
 * Each step's expr is evaluated against { state, requires, sources, computed_values }.
 * Results are written to node.computed_values[bindTo].
 * computed_values and _sourcesData are reset on each call — ephemeral, never persisted.
 *
 * @param options.sourcesData  Pre-loaded map of { [bindTo]: data } for sources namespace.
 *   In Node/CLI: loaded from outputFiles by the caller (card-handler).
 *   In browser:  passed in by the caller (e.g. from fetch results).
 */
async function run(node: ComputeNode, options?: RunOptions): Promise<ComputeNode> {
  if (!node?.compute?.length) return node;
  if (!node.state) node.state = {};
  node.computed_values = {};
  node._sourcesData = options?.sourcesData ?? {};

  // Context passed to JSONata
  const ctx: Record<string, unknown> = {
    state: node.state,
    requires: node.requires ?? {},
    sources: node._sourcesData,
    computed_values: node.computed_values,
  };

  for (const step of node.compute) {
    try {
      const val = await jsonata(step.expr).evaluate(ctx);
      deepSet(node.computed_values, step.bindTo, val);
      ctx.computed_values = node.computed_values; // subsequent steps see earlier results
    } catch (err) {
      console.error(`CardCompute.run error on "${node.id ?? '?'}.${step.bindTo}":`, err);
    }
  }

  return node;
}

/**
 * Evaluate a single JSONata expression against a node's context.
 * Context is { state, requires, sources, computed_values }.
 */
async function evalExpr(expr: string, node: ComputeNode): Promise<unknown> {
  const ctx = {
    state: node.state ?? {},
    requires: node.requires ?? {},
    sources: node._sourcesData ?? {},
    computed_values: node.computed_values ?? {},
  };
  return jsonata(expr).evaluate(ctx);
}

// ---------------------------------------------------------------------------
// resolve — synchronous deep-get from node
// ---------------------------------------------------------------------------

function resolve(node: ComputeNode, path: string): unknown {
  // sources.* resolves from the ephemeral _sourcesData map
  if (path.startsWith('sources.')) {
    return deepGet(node._sourcesData ?? {}, path.slice('sources.'.length));
  }
  return deepGet(node, path);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Result of validateNode — ok: true means valid, ok: false has errors[]. */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

const VALID_ELEMENT_KINDS = new Set([
  'metric', 'table', 'chart', 'form', 'filter', 'list',
  'notes', 'todo', 'alert', 'narrative', 'badge', 'text',
  'markdown', 'custom',
]);

const VALID_STATUSES = new Set(['fresh', 'stale', 'loading', 'error']);
const ALLOWED_KEYS = new Set(['id', 'meta', 'requires', 'provides', 'view', 'state', 'compute', 'sources']);

function validateNode(node: unknown): ValidationResult {
  const errors: string[] = [];

  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return { ok: false, errors: ['Node must be a non-null object'] };
  }

  const n = node as Record<string, unknown>;

  if (typeof n.id !== 'string' || !n.id) errors.push('id: required, must be a non-empty string');

  for (const key of Object.keys(n)) {
    if (!ALLOWED_KEYS.has(key)) errors.push(`Unknown top-level key: "${key}"`);
  }

  if (n.state == null || typeof n.state !== 'object' || Array.isArray(n.state)) {
    errors.push('state: required, must be an object');
  } else {
    const state = n.state as Record<string, unknown>;
    if (state.status != null && !VALID_STATUSES.has(state.status as string)) {
      errors.push(`state.status: must be one of: ${[...VALID_STATUSES].join(', ')}`);
    }
  }

  if (n.meta != null) {
    if (typeof n.meta !== 'object' || Array.isArray(n.meta)) {
      errors.push('meta: must be an object');
    } else {
      const meta = n.meta as Record<string, unknown>;
      if (meta.title != null && typeof meta.title !== 'string') errors.push('meta.title: must be a string');
      if (meta.tags != null && !Array.isArray(meta.tags)) errors.push('meta.tags: must be an array');
    }
  }

  if (n.requires != null && !Array.isArray(n.requires)) errors.push('requires: must be an array of strings');

  if (n.provides != null) {
    if (!Array.isArray(n.provides)) {
      errors.push('provides: must be an array of { bindTo, src } bindings');
    } else {
      (n.provides as unknown[]).forEach((p, i) => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) {
          errors.push(`provides[${i}]: must be an object with bindTo and src`);
        } else {
          const b = p as Record<string, unknown>;
          if (typeof b.bindTo !== 'string' || !b.bindTo) errors.push(`provides[${i}]: missing required "bindTo" string`);
          if (typeof b.src !== 'string' || !b.src) errors.push(`provides[${i}]: missing required "src" string`);
        }
      });
    }
  }

  // compute — ordered array of { bindTo, expr } steps
  if (n.compute != null) {
    if (!Array.isArray(n.compute)) {
      errors.push('compute: must be an array of compute steps');
    } else {
      (n.compute as unknown[]).forEach((step, i) => {
        if (!step || typeof step !== 'object' || Array.isArray(step)) {
          errors.push(`compute[${i}]: must be a compute step object`);
        } else {
          const s = step as Record<string, unknown>;
          if (typeof s.bindTo !== 'string' || !s.bindTo) errors.push(`compute[${i}]: missing required "bindTo" property`);
          if (typeof s.expr !== 'string' || !s.expr) errors.push(`compute[${i}]: missing required "expr" string (JSONata expression)`);
        }
      });
    }
  }

  if (n.sources != null) {
    if (!Array.isArray(n.sources)) {
      errors.push('sources: must be an array');
    } else {
      (n.sources as unknown[]).forEach((src, i) => {
        if (!src || typeof src !== 'object' || Array.isArray(src)) {
          errors.push(`sources[${i}]: must be an object`);
        } else {
          const s = src as Record<string, unknown>;
          if (typeof s.bindTo !== 'string' || !s.bindTo) errors.push(`sources[${i}]: missing required "bindTo" property`);
          if (s.outputFile != null && typeof s.outputFile !== 'string') errors.push(`sources[${i}]: outputFile must be a string`);
          if (s.optional != null && typeof s.optional !== 'boolean') errors.push(`sources[${i}]: optional must be a boolean`);
        }
      });
    }
  }

  if (n.view != null) {
    if (typeof n.view !== 'object' || Array.isArray(n.view)) {
      errors.push('view: must be an object');
    } else {
      const view = n.view as Record<string, unknown>;
      if (!Array.isArray(view.elements) || view.elements.length === 0) {
        errors.push('view.elements: required, must be a non-empty array');
      } else {
        (view.elements as Record<string, unknown>[]).forEach((elem, i) => {
          if (!elem || typeof elem !== 'object') { errors.push(`view.elements[${i}]: must be an object`); return; }
          if (!elem.kind || typeof elem.kind !== 'string') {
            errors.push(`view.elements[${i}].kind: required, must be a string`);
          } else if (!VALID_ELEMENT_KINDS.has(elem.kind as string)) {
            errors.push(`view.elements[${i}].kind: unknown kind "${elem.kind}". Valid: ${[...VALID_ELEMENT_KINDS].join(', ')}`);
          }
          if (elem.data != null && (typeof elem.data !== 'object' || Array.isArray(elem.data))) {
            errors.push(`view.elements[${i}].data: must be an object`);
          }
        });
      }
      if (view.layout != null && (typeof view.layout !== 'object' || Array.isArray(view.layout))) errors.push('view.layout: must be an object');
      if (view.features != null && (typeof view.features !== 'object' || Array.isArray(view.features))) errors.push('view.features: must be an object');
    }
  }

  return { ok: errors.length === 0, errors };
}

export const CardCompute = {
  run,
  eval: evalExpr,
  resolve,
  validate: validateNode,
};

export { validateLiveCardSchema } from './schema-validator.js';

export default CardCompute;

