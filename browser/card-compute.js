// card-compute.js — JSONata-powered compute engine for LiveCards (browser build)
//
// Requires JSONata to be loaded first:
//   <script src="https://cdn.jsdelivr.net/npm/jsonata/jsonata.min.js"></script>
//
// API (all async where noted):
//   CardCompute.run(node, options)         → Promise<node>  — eval all compute steps → computed_values
//   CardCompute.eval(expr, node)           → Promise<value> — eval single JSONata expression
//   CardCompute.resolve(node, path)        → value          — sync deep-get "card_data.foo" or "fetched_sources.foo"
//   CardCompute.validate(node)             → { ok, errors } — sync structural validator
//
// Compute steps shape: { bindTo: string, expr: string }
//   expr is a JSONata expression evaluated against { card_data, requires, fetched_sources, computed_values }
//   computed_values and _sourcesData are ephemeral — reset on each run(), never persisted.
//
// Sequential steps: later steps see earlier results via computed_values.*
// options.sourcesData: pre-loaded { [bindTo]: data } map for the fetched_sources.* namespace

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();        // Node / CommonJS
  } else if (typeof define === 'function' && define.amd) {
    define(factory);                   // AMD
  } else {
    root.CardCompute = factory();      // Browser global
  }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ===========================================================================
  // Deep path utilities
  // ===========================================================================

  function _deepGet(obj, path) {
    if (!path || obj == null) return undefined;
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function _deepSet(obj, path, value) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  // ===========================================================================
  // run — evaluate all compute steps on a node (async, returns Promise<node>)
  // ===========================================================================

  function run(node, options) {
    if (!node || !node.compute || !node.compute.length) return Promise.resolve(node);

    if (!node.card_data) node.card_data = {};
    node.computed_values = {};
    node._sourcesData = (options && options.sourcesData) || {};

    if (typeof jsonata === 'undefined') {
      console.error('CardCompute: JSONata not loaded. Add <script src="https://cdn.jsdelivr.net/npm/jsonata/jsonata.min.js"></script> before card-compute.js');
      return Promise.resolve(node);
    }

    var ctx = {
      card_data: node.card_data,
      requires: node.requires || {},
      fetched_sources: node._sourcesData,
      computed_values: node.computed_values,
    };

    var chain = Promise.resolve();
    node.compute.forEach(function (step) {
      chain = chain.then(function () {
        if (!step || typeof step.expr !== 'string') return;
        return jsonata(step.expr).evaluate(ctx).then(function (val) {
          _deepSet(node.computed_values, step.bindTo, val);
          ctx.computed_values = node.computed_values; // subsequent steps see earlier results
        }).catch(function (e) {
          console.error('CardCompute.run error on "' + (node.id || '?') + '.' + step.bindTo + '":', e);
        });
      });
    });

    return chain.then(function () { return node; });
  }

  // ===========================================================================
  // eval — evaluate a single JSONata expression (async, returns Promise<value>)
  // ===========================================================================

  function evalExpr(expr, node) {
    if (typeof jsonata === 'undefined') {
      console.error('CardCompute: JSONata not loaded.');
      return Promise.resolve(undefined);
    }
    var ctx = {
      card_data: (node && node.card_data) || {},
      requires: (node && node.requires) || {},
      fetched_sources: (node && node._sourcesData) || {},
      computed_values: (node && node.computed_values) || {},
    };
    return jsonata(expr).evaluate(ctx);
  }

  // ===========================================================================
  // resolve — synchronous deep-get from a node
  // ===========================================================================

  function resolve(node, path) {
    if (path && path.indexOf('fetched_sources.') === 0) {
      return _deepGet((node && node._sourcesData) || {}, path.slice('fetched_sources.'.length));
    }
    return _deepGet(node, path);
  }

  // ===========================================================================
  // validate — lightweight structural validator (sync)
  // ===========================================================================

  var VALID_ELEMENT_KINDS = ['metric','table','chart','form','filter','list','notes','todo','alert','narrative','badge','text','markdown','custom'];
  var VALID_STATUSES = ['fresh','stale','loading','error'];
  var ALLOWED_KEYS = ['id','meta','requires','provides','view','card_data','compute','sources'];

  function validateNode(node) {
    var errors = [];

    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      return { ok: false, errors: ['Node must be a non-null object'] };
    }

    if (typeof node.id !== 'string' || !node.id) errors.push('id: required, must be a non-empty string');

    Object.keys(node).forEach(function (k) {
      if (ALLOWED_KEYS.indexOf(k) === -1) errors.push('Unknown top-level key: "' + k + '"');
    });

    // card_data
    if (node.card_data == null || typeof node.card_data !== 'object' || Array.isArray(node.card_data)) {
      errors.push('card_data: required, must be an object');
    }

    // meta
    if (node.meta != null) {
      if (typeof node.meta !== 'object' || Array.isArray(node.meta)) {
        errors.push('meta: must be an object');
      } else {
        if (node.meta.title != null && typeof node.meta.title !== 'string') errors.push('meta.title: must be a string');
        if (node.meta.tags != null && !Array.isArray(node.meta.tags)) errors.push('meta.tags: must be an array');
      }
    }

    // requires
    if (node.requires != null && !Array.isArray(node.requires)) errors.push('requires: must be an array of strings');

    // provides
    if (node.provides != null) {
      if (!Array.isArray(node.provides)) {
        errors.push('provides: must be an array of { bindTo, src } bindings');
      } else {
        node.provides.forEach(function (p, i) {
          if (!p || typeof p !== 'object' || Array.isArray(p)) {
            errors.push('provides[' + i + ']: must be an object with bindTo and src');
          } else {
            if (typeof p.bindTo !== 'string' || !p.bindTo) errors.push('provides[' + i + ']: missing required "bindTo" string');
            if (typeof p.src !== 'string' || !p.src) errors.push('provides[' + i + ']: missing required "src" string');
          }
        });
      }
    }

    // compute — ordered array of { bindTo, expr } steps
    if (node.compute != null) {
      if (!Array.isArray(node.compute)) {
        errors.push('compute: must be an array of compute steps');
      } else {
        node.compute.forEach(function (step, i) {
          if (!step || typeof step !== 'object' || Array.isArray(step)) {
            errors.push('compute[' + i + ']: must be a compute step object');
          } else {
            if (typeof step.bindTo !== 'string' || !step.bindTo) errors.push('compute[' + i + ']: missing required "bindTo" property');
            if (typeof step.expr !== 'string' || !step.expr) errors.push('compute[' + i + ']: missing required "expr" string (JSONata expression)');
          }
        });
      }
    }

    // sources
    if (node.sources != null) {
      if (!Array.isArray(node.sources)) {
        errors.push('sources: must be an array');
      } else {
        node.sources.forEach(function (src, i) {
          if (!src || typeof src !== 'object' || Array.isArray(src)) errors.push('sources[' + i + ']: must be an object');
          else if (typeof src.bindTo !== 'string' || !src.bindTo) errors.push('sources[' + i + ']: missing required "bindTo" property');
          else {
            if (src.outputFile != null && typeof src.outputFile !== 'string') errors.push('sources[' + i + ']: outputFile must be a string');
            if (src.optional != null && typeof src.optional !== 'boolean') errors.push('sources[' + i + ']: optional must be a boolean');
          }
        });
      }
    }

    // view
    if (node.view != null) {
      if (typeof node.view !== 'object' || Array.isArray(node.view)) {
        errors.push('view: must be an object');
      } else {
        if (!Array.isArray(node.view.elements) || node.view.elements.length === 0) {
          errors.push('view.elements: required, must be a non-empty array');
        } else {
          node.view.elements.forEach(function (elem, i) {
            if (!elem || typeof elem !== 'object') { errors.push('view.elements[' + i + ']: must be an object'); return; }
            if (!elem.kind || typeof elem.kind !== 'string') {
              errors.push('view.elements[' + i + '].kind: required, must be a string');
            } else if (VALID_ELEMENT_KINDS.indexOf(elem.kind) === -1) {
              errors.push('view.elements[' + i + '].kind: unknown kind "' + elem.kind + '". Valid: ' + VALID_ELEMENT_KINDS.join(', '));
            }
          });
        }
      }
    }

    return { ok: errors.length === 0, errors: errors };
  }

  /**
   * Enrich sources with execution context for template interpolation and prompt rendering.
   * Pure function: no side effects, returns new enriched sources array.
   * 
   * @param {Array} sources - Array of source definitions
   * @param {Object} context - Execution context containing requires, sourcesData, computed_values
   * @returns {Array} New array of sources with _requires, _sourcesData, _computed_values attached
   */
  function enrichSources(sources, context) {
    if (!sources || sources.length === 0) return [];
    context = context || {};
    
    return sources.map(function (src) {
      return Object.assign({}, src, {
        _requires: context.requires || {},
        _sourcesData: context.sourcesData || {},
        _computed_values: context.computed_values || {},
      });
    });
  }

  // ===========================================================================
  // Export
  // ===========================================================================

  return {
    run: run,
    eval: evalExpr,
    resolve: resolve,
    validate: validateNode,
    enrichSources: enrichSources,
  };

}));
