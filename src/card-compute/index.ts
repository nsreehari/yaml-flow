/**
 * card-compute — Pure JSON expression evaluator for node-based cards.
 *
 * Isomorphic: works in browser, Node.js, and bundlers.
 * No DOM dependency. No eval(). Pure declarative JSON expressions.
 *
 * @example
 * ```typescript
 * import { CardCompute } from 'yaml-flow/card-compute';
 *
 * const node = {
 *   id: 'sales',
 *   state: { data: [{ revenue: 100 }, { revenue: 200 }] },
 *   compute: {
 *     total: { fn: 'sum', input: 'state.data', field: 'revenue' },
 *     avg:   { fn: 'avg', input: 'state.data', field: 'revenue' },
 *   },
 * };
 * CardCompute.run(node);
 * // node.state.total === 300
 * // node.state.avg   === 150
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A compute expression — pure JSON, arbitrarily nestable. */
export interface ComputeExpr {
  fn: string;
  input?: string | number | boolean | ComputeExpr | (string | number | boolean | ComputeExpr)[];
  field?: string;
  where?: ComputeExpr;
  apply?: ComputeExpr;
  cond?: ComputeExpr;
  then?: unknown;
  else?: unknown;
  format?: string;
  decimals?: number;
  separator?: string;
  direction?: 'asc' | 'desc';
  start?: number;
  end?: number;
  depth?: number;
  path?: string;
  value?: unknown;
  [key: string]: unknown;
}

/** A single compute step: bindTo is the output key, rest is the expression. */
export interface ComputeStep extends ComputeExpr {
  bindTo: string;
}

/** Minimal node shape expected by CardCompute. */
export interface ComputeNode {
  id?: string;
  state?: Record<string, unknown>;
  requires?: Record<string, unknown>;
  compute?: ComputeStep[];
  computed_values?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Internal evaluator signature passed to compute functions. */
export type EvalFn = (expr: unknown, node: ComputeNode) => unknown;

/** A compute function implementation. */
export type ComputeFn = (input: unknown, evalFn: EvalFn, opts: ComputeExpr) => unknown;

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
// Built-in functions (53)
// ---------------------------------------------------------------------------

const _fns: Record<string, ComputeFn> = {};

// ---- Aggregates ----

_fns.sum = (input, _e, opts) => {
  const a = Array.isArray(input) ? input : [];
  return opts.field
    ? a.reduce((s, r) => s + (Number(r[opts.field!]) || 0), 0)
    : a.reduce((s, v) => s + (Number(v) || 0), 0);
};

_fns.avg = (input, _e, opts) => {
  const s = _fns.sum(input, _e, opts) as number;
  const n = Array.isArray(input) ? input.length : 1;
  return n ? s / n : 0;
};

_fns.min = (input, _e, opts) => {
  const a = Array.isArray(input) ? input : [];
  const vals = opts.field ? a.map(r => Number(r[opts.field!])) : a.map(Number);
  return vals.length ? Math.min(...vals) : 0;
};

_fns.max = (input, _e, opts) => {
  const a = Array.isArray(input) ? input : [];
  const vals = opts.field ? a.map(r => Number(r[opts.field!])) : a.map(Number);
  return vals.length ? Math.max(...vals) : 0;
};

_fns.count = (input) => Array.isArray(input) ? input.length : (input != null ? 1 : 0);
_fns.first = (input) => Array.isArray(input) ? input[0] : input;
_fns.last  = (input) => Array.isArray(input) ? input[input.length - 1] : input;

// ---- Math ----

_fns.add = (input) => { const a = Array.isArray(input) ? input : []; return a.reduce((s, v) => s + Number(v), 0); };
_fns.sub = (input) => { const a = Array.isArray(input) ? input : []; return a.length >= 2 ? Number(a[0]) - Number(a[1]) : 0; };
_fns.mul = (input) => { const a = Array.isArray(input) ? input : []; return a.reduce((s, v) => s * Number(v), 1); };
_fns.div = (input) => { const a = Array.isArray(input) ? input : []; return a.length >= 2 && Number(a[1]) !== 0 ? Number(a[0]) / Number(a[1]) : 0; };

_fns.round = (input, _e, opts) => {
  const decimals = opts.decimals != null ? (opts.decimals as number) : 0;
  const factor = Math.pow(10, decimals);
  return Math.round(Number(input) * factor) / factor;
};

_fns.abs = (input) => Math.abs(Number(input));
_fns.mod = (input) => { const a = Array.isArray(input) ? input : []; return a.length >= 2 ? Number(a[0]) % Number(a[1]) : 0; };

// ---- Compare ----

_fns.gt  = (input) => { const a = Array.isArray(input) ? input : []; return a.length >= 2 && Number(a[0]) > Number(a[1]); };
_fns.gte = (input) => { const a = Array.isArray(input) ? input : []; return a.length >= 2 && Number(a[0]) >= Number(a[1]); };
_fns.lt  = (input) => { const a = Array.isArray(input) ? input : []; return a.length >= 2 && Number(a[0]) < Number(a[1]); };
_fns.lte = (input) => { const a = Array.isArray(input) ? input : []; return a.length >= 2 && Number(a[0]) <= Number(a[1]); };
_fns.eq  = (input) => { const a = Array.isArray(input) ? input : []; return a.length >= 2 && a[0] === a[1]; };
_fns.neq = (input) => { const a = Array.isArray(input) ? input : []; return a.length >= 2 && a[0] !== a[1]; };

// ---- Logic ----

_fns.and = (input) => { const a = Array.isArray(input) ? input : []; return a.every(Boolean); };
_fns.or  = (input) => { const a = Array.isArray(input) ? input : []; return a.some(Boolean); };
_fns.not = (input) => !input;
// "if" is handled in evalExpr

// ---- String ----

_fns.concat = (input) => {
  const a = Array.isArray(input) ? input : [];
  return a.map(v => v != null ? String(v) : '').join('');
};

_fns.upper = (input) => String(input || '').toUpperCase();
_fns.lower = (input) => String(input || '').toLowerCase();

_fns.template = (input, _e, opts) => {
  let t = String(opts.format || '');
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    for (const k of Object.keys(input as Record<string, unknown>)) {
      const v = (input as Record<string, unknown>)[k];
      t = t.split('{{' + k + '}}').join(v != null ? String(v) : '');
    }
  }
  return t;
};

_fns.join = (input, _e, opts) => {
  const a = Array.isArray(input) ? input : [];
  const sep = opts.separator != null ? String(opts.separator) : ', ';
  return a.map(v => v != null ? String(v) : '').join(sep);
};

_fns.split = (input, _e, opts) => {
  const sep = opts.separator != null ? String(opts.separator) : ',';
  return String(input || '').split(sep).map(s => s.trim());
};

_fns.trim = (input) => String(input || '').trim();

// ---- Collection ----

_fns.pluck = (input, _e, opts) => Array.isArray(input) ? input.map(r => r[opts.field!]) : [];

_fns.filter = (input, _e, opts) => {
  if (!Array.isArray(input)) return [];
  if (opts.field) return input.filter(r => !!r[opts.field!]);
  return input.filter(Boolean);
};

_fns.map = (input) => Array.isArray(input) ? input.slice() : [];

_fns.sort = (input, _e, opts) => {
  const a = Array.isArray(input) ? input.slice() : [];
  const f = opts.field;
  const dir = opts.direction === 'desc' ? -1 : 1;
  if (f) return a.sort((x, y) => x[f] > y[f] ? dir : x[f] < y[f] ? -dir : 0);
  return a.sort((x, y) => x > y ? dir : x < y ? -dir : 0);
};

_fns.slice = (input, _e, opts) => Array.isArray(input) ? input.slice(opts.start || 0, opts.end as number | undefined) : input;
_fns.flat = (input, _e, opts) => {
  const depth = opts.depth != null ? (opts.depth as number) : 1;
  return Array.isArray(input) ? input.flat(depth) : [input];
};

_fns.unique = (input) => {
  if (!Array.isArray(input)) return [input];
  const seen = new Set<unknown>();
  return input.filter(v => {
    const key = typeof v === 'object' ? JSON.stringify(v) : v;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

_fns.group = (input, _e, opts) => {
  const a = Array.isArray(input) ? input : [];
  const g: Record<string, unknown[]> = {};
  a.forEach(r => { const k = String(r[opts.field!] || ''); if (!g[k]) g[k] = []; g[k].push(r); });
  return g;
};

_fns.flatten_keys = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const result: { key: string; value: unknown }[] = [];
  for (const k of Object.keys(input as Record<string, unknown>)) {
    const vals = Array.isArray((input as Record<string, unknown>)[k])
      ? (input as Record<string, unknown>)[k] as unknown[]
      : [(input as Record<string, unknown>)[k]];
    vals.forEach(v => result.push({ key: k, value: v }));
  }
  return result;
};

_fns.entries = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  return Object.keys(input as Record<string, unknown>).map(k => ({ key: k, value: (input as Record<string, unknown>)[k] }));
};

_fns.from_entries = (input) => {
  if (!Array.isArray(input)) return {};
  const obj: Record<string, unknown> = {};
  input.forEach(item => { if (item.key != null) obj[item.key] = item.value; });
  return obj;
};

_fns.length = (input) => {
  if (Array.isArray(input)) return input.length;
  if (typeof input === 'string') return input.length;
  if (input && typeof input === 'object') return Object.keys(input).length;
  return 0;
};

// ---- Lookup ----

_fns.get = (input, _e, opts) => deepGet(input, opts.field || opts.path || '');
_fns.default = (input, _e, opts) => input != null ? input : opts.value;
_fns.coalesce = (input) => {
  const a = Array.isArray(input) ? input : [];
  for (let i = 0; i < a.length; i++) { if (a[i] != null) return a[i]; }
  return null;
};

// ---- Date ----

_fns.now = () => new Date().toISOString();
_fns.diff_days = (input) => {
  const a = Array.isArray(input) ? input : [];
  return a.length >= 2 ? Math.floor((new Date(a[0]).getTime() - new Date(a[1]).getTime()) / 86400000) : 0;
};

_fns.format_date = (input, _e, opts) => {
  try {
    const d = new Date(input as string);
    if (opts.format === 'iso') return d.toISOString();
    if (opts.format === 'date') return d.toLocaleDateString();
    if (opts.format === 'time') return d.toLocaleTimeString();
    return d.toLocaleDateString();
  } catch { return String(input); }
};

_fns.parse_date = (input) => {
  try { return new Date(input as string).toISOString(); } catch { return null; }
};

// ---- Type ----

_fns.to_number = (input) => Number(input) || 0;
_fns.to_string = (input) => input != null ? String(input) : '';
_fns.to_bool   = (input) => !!input;
_fns.type_of   = (input) => Array.isArray(input) ? 'array' : typeof input;
_fns.is_null   = (input) => input == null;
_fns.is_empty  = (input) => {
  if (input == null) return true;
  if (Array.isArray(input)) return input.length === 0;
  if (typeof input === 'string') return input.length === 0;
  if (typeof input === 'object') return Object.keys(input).length === 0;
  return false;
};

// ---------------------------------------------------------------------------
// Custom function registry
// ---------------------------------------------------------------------------

const _customFns: Record<string, ComputeFn> = {};

// ---------------------------------------------------------------------------
// Expression evaluator
// ---------------------------------------------------------------------------

function resolveRef(ref: string, node: ComputeNode): unknown {
  if (ref.startsWith('state.')) return deepGet(node, ref);
  if (ref.startsWith('requires.')) {
    const path = ref.slice('requires.'.length);
    return deepGet(node.requires, path);
  }
  if (ref.startsWith('computed_values.')) {
    const path = ref.slice('computed_values.'.length);
    return deepGet(node.computed_values, path);
  }
  return undefined;
}

function isRef(s: string): boolean {
  return s.startsWith('state.') || s.startsWith('requires.') || s.startsWith('computed_values.');
}

function evalExpr(expr: unknown, node: ComputeNode): unknown {
  if (expr == null) return expr;
  if (typeof expr !== 'object' || Array.isArray(expr)) return expr;

  const e = expr as ComputeExpr;
  if (!e.fn) return expr;

  // Resolve input
  let input: unknown = e.input;
  if (typeof input === 'string' && isRef(input)) {
    input = resolveRef(input, node);
  } else if (Array.isArray(input)) {
    input = input.map(v => {
      if (typeof v === 'string' && isRef(v as string)) return resolveRef(v as string, node);
      if (v && typeof v === 'object' && (v as ComputeExpr).fn) return evalExpr(v, node);
      return v;
    });
  } else if (input && typeof input === 'object' && (input as ComputeExpr).fn) {
    input = evalExpr(input, node);
  }

  // Special: if
  if (e.fn === 'if') {
    const cond = evalExpr(e.cond, node);
    if (cond) {
      return (e.then && typeof e.then === 'object' && (e.then as ComputeExpr).fn) ? evalExpr(e.then, node) : e.then;
    } else {
      return (e.else && typeof e.else === 'object' && (e.else as ComputeExpr).fn) ? evalExpr(e.else, node) : e.else;
    }
  }

  // Special: filter with where
  if (e.fn === 'filter' && Array.isArray(input) && e.where) {
    return (input as unknown[]).filter(item => {
      const tmp: ComputeNode = { state: { ...node.state, $: item }, requires: node.requires, computed_values: node.computed_values };
      return evalExpr(e.where, tmp);
    });
  }

  // Special: map with apply
  if (e.fn === 'map' && Array.isArray(input) && e.apply) {
    return (input as unknown[]).map(item => {
      const tmp: ComputeNode = { state: { ...node.state, $: item }, requires: node.requires, computed_values: node.computed_values };
      return evalExpr(e.apply as ComputeExpr, tmp);
    });
  }

  const fn = _customFns[e.fn] || _fns[e.fn];
  if (!fn) {
    console.warn('CardCompute: unknown function "' + e.fn + '"');
    return undefined;
  }

  return fn(input, evalExpr, e);
}

// ---------------------------------------------------------------------------
// run — evaluate all node.compute declarations
// ---------------------------------------------------------------------------

function run(node: ComputeNode): ComputeNode {
  if (!node || !node.compute) return node;
  if (!node.state) node.state = {};
  node.computed_values = {};

  for (const step of node.compute) {
    try {
      const val = evalExpr(step, node);
      deepSet(node.computed_values, step.bindTo, val);
    } catch (err) {
      console.error(`CardCompute.run error on "${node.id || '?'}.${step.bindTo}":`, err);
    }
  }

  return node;
}

// ---------------------------------------------------------------------------
// resolve — deep get from node
// ---------------------------------------------------------------------------

function resolve(node: ComputeNode, path: string): unknown {
  return deepGet(node, path);
}

// ---------------------------------------------------------------------------
// registerFunction — extend the vocabulary
// ---------------------------------------------------------------------------

function registerFunction(name: string, fn: ComputeFn): void {
  _customFns[name] = fn;
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

const VALID_SOURCE_KINDS = new Set(['api', 'websocket', 'static', 'llm']);
const VALID_STATUSES = new Set(['fresh', 'stale', 'loading', 'error']);

const ALLOWED_KEYS = new Set(['id', 'meta', 'requires', 'provides', 'view', 'state', 'compute', 'sources', 'optionalSources']);

/**
 * Validate a node against the LiveCards schema.
 * Lightweight structural check — no external dependencies.
 *
 * @example
 * ```typescript
 * const result = CardCompute.validate(node);
 * if (!result.ok) console.error(result.errors);
 * ```
 */
function validateNode(node: unknown): ValidationResult {
  const errors: string[] = [];

  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    return { ok: false, errors: ['Node must be a non-null object'] };
  }

  const n = node as Record<string, unknown>;

  // id
  if (typeof n.id !== 'string' || !n.id) {
    errors.push('id: required, must be a non-empty string');
  }

  // Check for unknown top-level keys
  for (const key of Object.keys(n)) {
    if (!ALLOWED_KEYS.has(key)) errors.push(`Unknown top-level key: "${key}"`);
  }

  // state (required)
  if (n.state == null || typeof n.state !== 'object' || Array.isArray(n.state)) {
    errors.push('state: required, must be an object');
  } else {
    const state = n.state as Record<string, unknown>;
    if (state.status != null && !VALID_STATUSES.has(state.status as string)) {
      errors.push(`state.status: must be one of: ${[...VALID_STATUSES].join(', ')}`);
    }
  }

  // meta (optional)
  if (n.meta != null) {
    if (typeof n.meta !== 'object' || Array.isArray(n.meta)) {
      errors.push('meta: must be an object');
    } else {
      const meta = n.meta as Record<string, unknown>;
      if (meta.title != null && typeof meta.title !== 'string') errors.push('meta.title: must be a string');
      if (meta.tags != null && !Array.isArray(meta.tags)) errors.push('meta.tags: must be an array');
    }
  }

  // requires (optional)
  if (n.requires != null && !Array.isArray(n.requires)) {
    errors.push('requires: must be an array of strings');
  }

  // provides (optional) — array of { bindTo, src } bindings
  if (n.provides != null) {
    if (!Array.isArray(n.provides)) {
      errors.push('provides: must be an array of { bindTo, src } bindings');
    } else {
      (n.provides as unknown[]).forEach((p, i) => {
        if (!p || typeof p !== 'object' || Array.isArray(p)) {
          errors.push(`provides[${i}]: must be an object with bindTo and src`);
        } else {
          const binding = p as Record<string, unknown>;
          if (typeof binding.bindTo !== 'string' || !binding.bindTo)
            errors.push(`provides[${i}]: missing required "bindTo" string`);
          if (typeof binding.src !== 'string' || !binding.src)
            errors.push(`provides[${i}]: missing required "src" string`);
        }
      });
    }
  }

  // compute (optional) — ordered array of ComputeStep
  if (n.compute != null) {
    if (!Array.isArray(n.compute)) {
      errors.push('compute: must be an array of compute steps');
    } else {
      (n.compute as unknown[]).forEach((step, i) => {
        if (!step || typeof step !== 'object' || Array.isArray(step)) {
          errors.push(`compute[${i}]: must be a compute step object`);
        } else {
          const s = step as Record<string, unknown>;
          if (typeof s.bindTo !== 'string' || !s.bindTo) {
            errors.push(`compute[${i}]: missing required "bindTo" property`);
          }
          if (!s.fn) {
            errors.push(`compute[${i}]: missing required "fn" property`);
          } else {
            const fn = s.fn as string;
            if (!_fns[fn] && !_customFns[fn]) {
              errors.push(`compute[${i}]: unknown function "${fn}"`);
            }
          }
        }
      });
    }
  }

  // sources (optional) — array of { script, bindTo }
  if (n.sources != null) {
    if (!Array.isArray(n.sources)) {
      errors.push('sources: must be an array');
    } else {
      (n.sources as unknown[]).forEach((src, i) => {
        if (!src || typeof src !== 'object' || Array.isArray(src)) {
          errors.push(`sources[${i}]: must be an object`);
        } else {
          const s = src as Record<string, unknown>;
          if (typeof s.bindTo !== 'string' || !s.bindTo) {
            errors.push(`sources[${i}]: missing required "bindTo" property`);
          }
        }
      });
    }
  }

  // optionalSources (optional) — same shape as sources
  if (n.optionalSources != null) {
    if (!Array.isArray(n.optionalSources)) {
      errors.push('optionalSources: must be an array');
    } else {
      (n.optionalSources as unknown[]).forEach((src, i) => {
        if (!src || typeof src !== 'object' || Array.isArray(src)) {
          errors.push(`optionalSources[${i}]: must be an object`);
        } else {
          const s = src as Record<string, unknown>;
          if (typeof s.bindTo !== 'string' || !s.bindTo) {
            errors.push(`optionalSources[${i}]: missing required "bindTo" property`);
          }
        }
      });
    }
  }

  // view (optional) — if present, validate its structure
  if (n.view != null) {
    if (typeof n.view !== 'object' || Array.isArray(n.view)) {
      errors.push('view: must be an object');
    } else {
      const view = n.view as Record<string, unknown>;

      // view.elements
      if (!Array.isArray(view.elements) || view.elements.length === 0) {
        errors.push('view.elements: required, must be a non-empty array');
      } else {
        (view.elements as Record<string, unknown>[]).forEach((elem, i) => {
          if (!elem || typeof elem !== 'object') {
            errors.push(`view.elements[${i}]: must be an object`);
            return;
          }
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

      // view.layout (optional)
      if (view.layout != null && (typeof view.layout !== 'object' || Array.isArray(view.layout))) {
        errors.push('view.layout: must be an object');
      }

      // view.features (optional)
      if (view.features != null && (typeof view.features !== 'object' || Array.isArray(view.features))) {
        errors.push('view.features: must be an object');
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export const CardCompute = {
  run,
  eval: evalExpr,
  resolve,
  validate: validateNode,
  registerFunction,
  get functions(): Record<string, ComputeFn> {
    const all: Record<string, ComputeFn> = {};
    for (const k of Object.keys(_fns)) all[k] = _fns[k];
    for (const k of Object.keys(_customFns)) all[k] = _customFns[k];
    return all;
  },
};

export { validateLiveCardSchema } from './schema-validator.js';

export default CardCompute;
