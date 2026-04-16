// card_compute.js — Pure JSON expression evaluator for LiveCards nodes
//
// Isomorphic: works in browser (global), Node.js (require), and ESM (import).
// No DOM dependency. Usable on both client and server.
//
// API:
//   CardCompute.run(node)                 → mutates node.state with computed values, returns node
//   CardCompute.eval(expr, node)          → evaluates a single compute_expr, returns value
//   CardCompute.resolve(node, path)       → deep-get a state path like "state.foo.bar"
//   CardCompute.registerFunction(name, fn) → add custom compute function
//   CardCompute.functions                 → read-only map of all registered functions
//
// Compute declarations (node.compute):
//   {
//     "total_value": { "fn": "sum", "input": "state.raw_quotes" },
//     "avg_price":   { "fn": "avg", "input": "state.raw_quotes" },
//     "direction":   { "fn": "if", "cond": { "fn": "gt", "input": ["state.latest", "state.prev"] }, "then": "up", "else": "down" }
//   }

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();                       // Node / CommonJS
  } else if (typeof define === 'function' && define.amd) {
    define(factory);                                   // AMD
  } else {
    root.CardCompute = factory();                      // Browser global
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ===========================================================================
  // Deep path utilities
  // ===========================================================================

  function _deepGet(obj, path) {
    if (!path || !obj) return undefined;
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function _deepSet(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  function resolve(node, path) {
    if (!path) return undefined;
    return _deepGet(node, path);
  }

  // ===========================================================================
  // Built-in function registry
  // ===========================================================================

  var _fns = {};

  // ---- Aggregates ----

  _fns.sum = function (input, _eval, opts) {
    var a = Array.isArray(input) ? input : [];
    return opts.field
      ? a.reduce(function (s, r) { return s + (Number(r[opts.field]) || 0); }, 0)
      : a.reduce(function (s, v) { return s + (Number(v) || 0); }, 0);
  };

  _fns.avg = function (input, _eval, opts) {
    var s = _fns.sum(input, _eval, opts);
    var n = Array.isArray(input) ? input.length : 1;
    return n ? s / n : 0;
  };

  _fns.min = function (input, _eval, opts) {
    var a = Array.isArray(input) ? input : [];
    var vals = opts.field ? a.map(function (r) { return Number(r[opts.field]); }) : a.map(Number);
    return vals.length ? Math.min.apply(null, vals) : 0;
  };

  _fns.max = function (input, _eval, opts) {
    var a = Array.isArray(input) ? input : [];
    var vals = opts.field ? a.map(function (r) { return Number(r[opts.field]); }) : a.map(Number);
    return vals.length ? Math.max.apply(null, vals) : 0;
  };

  _fns.count = function (input) {
    return Array.isArray(input) ? input.length : (input != null ? 1 : 0);
  };

  _fns.first = function (input) {
    return Array.isArray(input) ? input[0] : input;
  };

  _fns.last = function (input) {
    return Array.isArray(input) ? input[input.length - 1] : input;
  };

  // ---- Math ----

  _fns.add = function (input) {
    var a = Array.isArray(input) ? input : [];
    return a.reduce(function (s, v) { return s + Number(v); }, 0);
  };

  _fns.sub = function (input) {
    var a = Array.isArray(input) ? input : [];
    return a.length >= 2 ? Number(a[0]) - Number(a[1]) : 0;
  };

  _fns.mul = function (input) {
    var a = Array.isArray(input) ? input : [];
    return a.reduce(function (s, v) { return s * Number(v); }, 1);
  };

  _fns.div = function (input) {
    var a = Array.isArray(input) ? input : [];
    return a.length >= 2 && Number(a[1]) !== 0 ? Number(a[0]) / Number(a[1]) : 0;
  };

  _fns.round = function (input, _eval, opts) {
    var decimals = opts.decimals != null ? opts.decimals : 0;
    var factor = Math.pow(10, decimals);
    return Math.round(Number(input) * factor) / factor;
  };

  _fns.abs = function (input) { return Math.abs(Number(input)); };

  _fns.mod = function (input) {
    var a = Array.isArray(input) ? input : [];
    return a.length >= 2 ? Number(a[0]) % Number(a[1]) : 0;
  };

  // ---- Compare ----

  _fns.gt  = function (input) { var a = Array.isArray(input) ? input : []; return a.length >= 2 && Number(a[0]) > Number(a[1]); };
  _fns.gte = function (input) { var a = Array.isArray(input) ? input : []; return a.length >= 2 && Number(a[0]) >= Number(a[1]); };
  _fns.lt  = function (input) { var a = Array.isArray(input) ? input : []; return a.length >= 2 && Number(a[0]) < Number(a[1]); };
  _fns.lte = function (input) { var a = Array.isArray(input) ? input : []; return a.length >= 2 && Number(a[0]) <= Number(a[1]); };
  _fns.eq  = function (input) { var a = Array.isArray(input) ? input : []; return a.length >= 2 && a[0] === a[1]; };
  _fns.neq = function (input) { var a = Array.isArray(input) ? input : []; return a.length >= 2 && a[0] !== a[1]; };

  // ---- Logic ----

  _fns.and = function (input) { var a = Array.isArray(input) ? input : []; return a.every(Boolean); };
  _fns.or  = function (input) { var a = Array.isArray(input) ? input : []; return a.some(Boolean); };
  _fns.not = function (input) { return !input; };
  // "if" is handled specially in evalExpr

  // ---- String ----

  _fns.concat = function (input) {
    var a = Array.isArray(input) ? input : [];
    return a.map(function (v) { return v != null ? String(v) : ''; }).join('');
  };

  _fns.upper = function (input) { return String(input || '').toUpperCase(); };
  _fns.lower = function (input) { return String(input || '').toLowerCase(); };

  _fns.template = function (input, _eval, opts) {
    var t = String(opts.format || '');
    if (input && typeof input === 'object') {
      Object.keys(input).forEach(function (k) {
        t = t.split('{{' + k + '}}').join(input[k] != null ? String(input[k]) : '');
      });
    }
    return t;
  };

  _fns.join = function (input, _eval, opts) {
    var a = Array.isArray(input) ? input : [];
    var sep = opts.separator != null ? opts.separator : ', ';
    return a.map(function (v) { return v != null ? String(v) : ''; }).join(sep);
  };

  _fns.split = function (input, _eval, opts) {
    var sep = opts.separator != null ? opts.separator : ',';
    return String(input || '').split(sep).map(function (s) { return s.trim(); });
  };

  _fns.trim = function (input) { return String(input || '').trim(); };

  // ---- Collection ----

  _fns.pluck = function (input, _eval, opts) {
    return Array.isArray(input) ? input.map(function (r) { return r[opts.field]; }) : [];
  };

  _fns.filter = function (input, evalFn, opts) {
    // Handled specially in evalExpr for the where clause; fallback for simple truthy filter
    if (!Array.isArray(input)) return [];
    if (opts.field) return input.filter(function (r) { return !!r[opts.field]; });
    return input.filter(Boolean);
  };

  _fns.map = function (input) {
    // Handled specially in evalExpr for the apply clause
    return Array.isArray(input) ? input.slice() : [];
  };

  _fns.sort = function (input, _eval, opts) {
    var a = Array.isArray(input) ? input.slice() : [];
    var f = opts.field;
    var dir = opts.direction === 'desc' ? -1 : 1;
    if (f) return a.sort(function (x, y) { return x[f] > y[f] ? dir : x[f] < y[f] ? -dir : 0; });
    return a.sort(function (x, y) { return x > y ? dir : x < y ? -dir : 0; });
  };

  _fns.slice = function (input, _eval, opts) {
    return Array.isArray(input) ? input.slice(opts.start || 0, opts.end) : input;
  };

  _fns.flat = function (input, _eval, opts) {
    var depth = opts.depth != null ? opts.depth : 1;
    return Array.isArray(input) ? input.flat(depth) : [input];
  };

  _fns.unique = function (input) {
    if (!Array.isArray(input)) return [input];
    // For primitives, use Set. For objects, use JSON comparison.
    var seen = new Set();
    return input.filter(function (v) {
      var key = typeof v === 'object' ? JSON.stringify(v) : v;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  _fns.group = function (input, _eval, opts) {
    var a = Array.isArray(input) ? input : [];
    var g = {};
    a.forEach(function (r) {
      var k = String(r[opts.field] || '');
      if (!g[k]) g[k] = [];
      g[k].push(r);
    });
    return g;
  };

  _fns.flatten_keys = function (input) {
    // { a: [1,2], b: [3] } → [{ key: "a", value: 1 }, { key: "a", value: 2 }, { key: "b", value: 3 }]
    if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
    var result = [];
    Object.keys(input).forEach(function (k) {
      var vals = Array.isArray(input[k]) ? input[k] : [input[k]];
      vals.forEach(function (v) { result.push({ key: k, value: v }); });
    });
    return result;
  };

  _fns.entries = function (input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
    return Object.keys(input).map(function (k) { return { key: k, value: input[k] }; });
  };

  _fns.from_entries = function (input) {
    if (!Array.isArray(input)) return {};
    var obj = {};
    input.forEach(function (item) { if (item.key != null) obj[item.key] = item.value; });
    return obj;
  };

  _fns.length = function (input) {
    if (Array.isArray(input)) return input.length;
    if (typeof input === 'string') return input.length;
    if (input && typeof input === 'object') return Object.keys(input).length;
    return 0;
  };

  // ---- Lookup ----

  _fns.get = function (input, _eval, opts) {
    return _deepGet(input, opts.field || opts.path || '');
  };

  _fns.default = function (input, _eval, opts) {
    return input != null ? input : opts.value;
  };

  _fns.coalesce = function (input) {
    var a = Array.isArray(input) ? input : [];
    for (var i = 0; i < a.length; i++) { if (a[i] != null) return a[i]; }
    return null;
  };

  // ---- Date ----

  _fns.now = function () { return new Date().toISOString(); };

  _fns.diff_days = function (input) {
    var a = Array.isArray(input) ? input : [];
    return a.length >= 2 ? Math.floor((new Date(a[0]) - new Date(a[1])) / 86400000) : 0;
  };

  _fns.format_date = function (input, _eval, opts) {
    try {
      var d = new Date(input);
      if (opts.format === 'iso') return d.toISOString();
      if (opts.format === 'date') return d.toLocaleDateString();
      if (opts.format === 'time') return d.toLocaleTimeString();
      return d.toLocaleDateString();
    } catch (e) {
      return String(input);
    }
  };

  _fns.parse_date = function (input) {
    try { return new Date(input).toISOString(); } catch (e) { return null; }
  };

  // ---- Type ----

  _fns.to_number = function (input) { return Number(input) || 0; };
  _fns.to_string = function (input) { return input != null ? String(input) : ''; };
  _fns.to_bool   = function (input) { return !!input; };
  _fns.type_of   = function (input) { return Array.isArray(input) ? 'array' : typeof input; };
  _fns.is_null   = function (input) { return input == null; };
  _fns.is_empty  = function (input) {
    if (input == null) return true;
    if (Array.isArray(input)) return input.length === 0;
    if (typeof input === 'string') return input.length === 0;
    if (typeof input === 'object') return Object.keys(input).length === 0;
    return false;
  };

  // ===========================================================================
  // Expression evaluator
  // ===========================================================================

  var _customFns = {};

  function evalExpr(expr, node) {
    if (expr == null) return expr;

    // Literal values pass through
    if (typeof expr !== 'object' || Array.isArray(expr)) return expr;

    // Must have fn to be an expression
    if (!expr.fn) return expr;

    // Resolve input
    var input = expr.input;
    if (typeof input === 'string' && input.startsWith('state.')) {
      input = resolve(node, input);
    } else if (Array.isArray(input)) {
      input = input.map(function (v) {
        if (typeof v === 'string' && v.startsWith('state.')) return resolve(node, v);
        if (v && typeof v === 'object' && v.fn) return evalExpr(v, node);
        return v;
      });
    } else if (input && typeof input === 'object' && input.fn) {
      input = evalExpr(input, node);
    }

    // Special: if
    if (expr.fn === 'if') {
      var cond = evalExpr(expr.cond, node);
      if (cond) {
        return (expr.then && typeof expr.then === 'object' && expr.then.fn) ? evalExpr(expr.then, node) : expr.then;
      } else {
        return (expr.else && typeof expr.else === 'object' && expr.else.fn) ? evalExpr(expr.else, node) : expr.else;
      }
    }

    // Special: filter with where clause
    if (expr.fn === 'filter' && Array.isArray(input) && expr.where) {
      return input.filter(function (item) {
        var tmp = { state: Object.assign({}, node.state, { $: item }) };
        return evalExpr(expr.where, tmp);
      });
    }

    // Special: map with apply clause
    if (expr.fn === 'map' && Array.isArray(input) && expr.apply) {
      return input.map(function (item) {
        var tmp = { state: Object.assign({}, node.state, { $: item }) };
        return evalExpr(expr.apply, tmp);
      });
    }

    // Look up function
    var fn = _customFns[expr.fn] || _fns[expr.fn];
    if (!fn) {
      console.warn('CardCompute: unknown function "' + expr.fn + '"');
      return undefined;
    }

    return fn(input, evalExpr, expr);
  }

  // ===========================================================================
  // run — evaluate all compute declarations on a node
  // ===========================================================================

  function run(node) {
    if (!node || !node.compute) return node;
    if (!node.state) node.state = {};

    var keys = Object.keys(node.compute);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      try {
        var val = evalExpr(node.compute[key], node);
        _deepSet(node.state, key, val);
      } catch (e) {
        console.error('CardCompute.run error on "' + (node.id || '?') + '.' + key + '":', e);
      }
    }

    return node;
  }

  // ===========================================================================
  // registerFunction — extend the vocabulary
  // ===========================================================================

  function registerFunction(name, fn) {
    _customFns[name] = fn;
  }

  // ===========================================================================
  // validate — lightweight structural validator for LiveCards nodes
  // ===========================================================================

  var VALID_ELEMENT_KINDS = ['metric','table','chart','form','filter','list','notes','todo','alert','narrative','badge','text','markdown','custom'];
  var VALID_SOURCE_KINDS = ['api','websocket','static','llm'];
  var VALID_STATUSES = ['fresh','stale','loading','error'];
  var CARD_KEYS = ['id','type','meta','data','view','state','compute'];
  var SOURCE_KEYS = ['id','type','meta','data','source','state','compute'];

  function validateNode(node) {
    var errors = [];
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return { ok: false, errors: ['Node must be a non-null object'] };
    }

    if (typeof node.id !== 'string' || !node.id) errors.push('id: required, must be a non-empty string');

    if (node.type !== 'card' && node.type !== 'source') {
      errors.push('type: must be "card" or "source"');
      return { ok: false, errors: errors };
    }

    var allowed = node.type === 'card' ? CARD_KEYS : SOURCE_KEYS;
    Object.keys(node).forEach(function (k) {
      if (allowed.indexOf(k) === -1) errors.push('Unknown top-level key: "' + k + '"');
    });

    // state
    if (node.state == null || typeof node.state !== 'object' || Array.isArray(node.state)) {
      errors.push('state: required, must be an object');
    } else if (node.state.status != null && VALID_STATUSES.indexOf(node.state.status) === -1) {
      errors.push('state.status: must be one of: ' + VALID_STATUSES.join(', '));
    }

    // meta
    if (node.meta != null) {
      if (typeof node.meta !== 'object' || Array.isArray(node.meta)) errors.push('meta: must be an object');
      else {
        if (node.meta.title != null && typeof node.meta.title !== 'string') errors.push('meta.title: must be a string');
        if (node.meta.tags != null && !Array.isArray(node.meta.tags)) errors.push('meta.tags: must be an array');
      }
    }

    // data
    if (node.data != null) {
      if (typeof node.data !== 'object' || Array.isArray(node.data)) errors.push('data: must be an object');
      else {
        if (node.data.requires != null && !Array.isArray(node.data.requires)) errors.push('data.requires: must be an array');
        if (node.data.provides != null && (typeof node.data.provides !== 'object' || Array.isArray(node.data.provides))) errors.push('data.provides: must be an object');
      }
    }

    // compute
    if (node.compute != null) {
      if (typeof node.compute !== 'object' || Array.isArray(node.compute)) errors.push('compute: must be an object');
      else {
        Object.keys(node.compute).forEach(function (key) {
          var expr = node.compute[key];
          if (!expr || typeof expr !== 'object' || Array.isArray(expr)) errors.push('compute.' + key + ': must be a compute expression object');
          else if (!expr.fn) errors.push('compute.' + key + ': missing required "fn" property');
          else if (!_fns[expr.fn] && !_customFns[expr.fn]) errors.push('compute.' + key + ': unknown function "' + expr.fn + '"');
        });
      }
    }

    // Card-specific
    if (node.type === 'card') {
      if (node.source != null) errors.push('Card nodes must not have "source"');
      if (node.view == null || typeof node.view !== 'object' || Array.isArray(node.view)) {
        errors.push('view: required for card nodes, must be an object');
      } else {
        if (!Array.isArray(node.view.elements) || node.view.elements.length === 0) {
          errors.push('view.elements: required, must be a non-empty array');
        } else {
          node.view.elements.forEach(function (elem, i) {
            if (!elem || typeof elem !== 'object') { errors.push('view.elements[' + i + ']: must be an object'); return; }
            if (!elem.kind || typeof elem.kind !== 'string') errors.push('view.elements[' + i + '].kind: required');
            else if (VALID_ELEMENT_KINDS.indexOf(elem.kind) === -1) errors.push('view.elements[' + i + '].kind: unknown "' + elem.kind + '"');
          });
        }
      }
    }

    // Source-specific
    if (node.type === 'source') {
      if (node.view != null) errors.push('Source nodes must not have "view"');
      if (node.source == null || typeof node.source !== 'object' || Array.isArray(node.source)) {
        errors.push('source: required for source nodes, must be an object');
      } else {
        if (!node.source.kind || VALID_SOURCE_KINDS.indexOf(node.source.kind) === -1) errors.push('source.kind: required, must be one of: ' + VALID_SOURCE_KINDS.join(', '));
        if (typeof node.source.bindTo !== 'string' || !node.source.bindTo) errors.push('source.bindTo: required, must be a state path string');
        else if (node.source.bindTo.indexOf('state.') !== 0) errors.push('source.bindTo: must start with "state."');
      }
    }

    return { ok: errors.length === 0, errors: errors };
  }

  // ===========================================================================
  // Export
  // ===========================================================================

  return {
    run: run,
    eval: evalExpr,
    resolve: resolve,
    validate: validateNode,
    registerFunction: registerFunction,
    get functions() {
      var all = {};
      Object.keys(_fns).forEach(function (k) { all[k] = _fns[k]; });
      Object.keys(_customFns).forEach(function (k) { all[k] = _customFns[k]; });
      return all;
    }
  };

}));
