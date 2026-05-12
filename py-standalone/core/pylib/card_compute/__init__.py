"""
card-compute — JSONata-powered compute engine for LiveCards nodes.

Isomorphic: works in any Python runtime.
No DOM dependency. Compute expressions are JSONata strings.

Port of src/card-compute/index.ts

Uses python-jsonata for expression evaluation. Falls back to a no-op
evaluator if the package is not available.
"""
from __future__ import annotations

import json
from typing import Any


# ============================================================================
# JSONata integration — try import, fallback to no-op
# ============================================================================

# Ensure vendored packages are importable
try:
    from ..vendor import __path__ as _vendor_path  # triggers sys.path insert
except ImportError:
    pass

try:
    from jsonata import Jsonata as _Jsonata

    def _jsonata_evaluate(expr: str, context: dict) -> Any:
        """Evaluate a JSONata expression against a context dict."""
        return _Jsonata(expr).evaluate(context)

except ImportError:
    def _jsonata_evaluate(expr: str, context: dict) -> Any:
        """No-op fallback — returns None when no JSONata library is available."""
        return None


# ============================================================================
# Deep path utilities
# ============================================================================

def deep_get(obj: Any, path: str) -> Any:
    """Get a value from a nested dict using dot-separated path."""
    if not path or obj is None:
        return None
    parts = path.split(".")
    cur = obj
    for part in parts:
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            cur = getattr(cur, part, None)
    return cur


def deep_set(obj: dict, path: str, value: Any) -> None:
    """Set a value in a nested dict using dot-separated path."""
    parts = path.split(".")
    cur = obj
    for i in range(len(parts) - 1):
        key = parts[i]
        if cur.get(key) is None or not isinstance(cur.get(key), dict):
            cur[key] = {}
        cur = cur[key]
    cur[parts[-1]] = value


# ============================================================================
# CardCompute
# ============================================================================

class CardCompute:
    """
    JSONata-powered compute engine for LiveCards nodes.

    Static methods only — no instance state.
    """

    @staticmethod
    def run_sync(node: dict, options: dict | None = None) -> dict:
        """
        Run all compute steps on a node synchronously.

        Each step's expr is evaluated against:
            { ...vars, card_data, requires, fetched_sources, computed_values }

        Results are written to node["computed_values"][bindTo].

        options:
            sourcesData : pre-loaded source results (keyed by bindTo)
            vars        : extra top-level variables spread into the eval ctx
                          (used by callers like step-machine that want flat
                          inputs visible without nesting under requires).
                          Spread BEFORE structural keys so they cannot shadow
                          card_data / requires / fetched_sources / computed_values.

        Returns {"ok": True, "node": node, "errors"?: [{bindTo, error}, ...]}.
        """
        compute = node.get("compute")
        if not compute:
            return {"ok": True, "node": node}

        if not node.get("card_data"):
            node["card_data"] = {}

        node["computed_values"] = {}
        opts = options or {}
        sources_data = opts.get("sourcesData") or node.get("_sourcesData") or {}
        node["_sourcesData"] = sources_data

        _requires = node.get("requires") or {}
        _computed_values = node["computed_values"]
        ctx = {
            "card_data": node["card_data"],
            "requires": _requires,
            "expects_data": _requires,             # alias: same reference as requires
            "fetched_sources": sources_data,
            "data": _computed_values,              # alias: same reference as computed_values
            "computed_values": _computed_values,
        }

        errors: list[dict] = []
        for step in compute:
            bind_to = step.get("bindTo", "")
            expr = step.get("expr", "")
            if not bind_to or not expr:
                continue
            try:
                val = _jsonata_evaluate(expr, ctx)
                deep_set(node["computed_values"], bind_to, val)
                ctx["computed_values"] = node["computed_values"]
                # ctx["data"] is the same reference as node["computed_values"] — already in sync
            except Exception as ex:
                errors.append({"bindTo": bind_to, "error": str(ex)})

        out: dict = {"ok": True, "node": node}
        if errors:
            out["errors"] = errors
        return out

    @staticmethod
    def eval_expr(expr: str, ctx: dict) -> Any:
        """
        Evaluate a single JSONata expression against an arbitrary context dict.
        """
        return _jsonata_evaluate(expr, ctx)

    @staticmethod
    def run(node: dict, options: dict | None = None) -> dict:
        """
        Run all compute steps. Same as run_sync in synchronous Python.
        Returns the mutated node.
        """
        result = CardCompute.run_sync(node, options)
        return result["node"]

    @staticmethod
    def resolve(node: dict, ref: str) -> Any:
        """
        Synchronous deep-get from node.
        Handles 'fetched_sources.' prefix by reading from _sourcesData.
        """
        if ref.startswith("fetched_sources."):
            return deep_get(node.get("_sourcesData") or {}, ref[len("fetched_sources."):])
        return deep_get(node, ref)

    @staticmethod
    def validate(node: object) -> dict:
        """
        Lightweight structural validation — port of validateNode from index.ts.
        Returns {ok: bool, errors: list[str]}.
        """
        import re as _re
        errors: list[str] = []

        VALID_ELEMENT_KINDS = {
            'metric', 'table', 'editable-table', 'chart', 'form', 'filter', 'list',
            'notes', 'todo', 'alert', 'narrative', 'badge', 'text',
            'markdown', 'ref', 'custom', 'actions',
        }
        ALLOWED_KEYS = {'id', 'meta', 'requires', 'provides', 'view', 'card_data', 'compute', 'source_defs'}

        if not node or not isinstance(node, dict):
            return {'ok': False, 'errors': ['Node must be a non-null object']}

        n = node
        if not isinstance(n.get('id'), str) or not n.get('id'):
            errors.append('id: required, must be a non-empty string')

        for key in n:
            if key not in ALLOWED_KEYS:
                errors.append(f'Unknown top-level key: "{key}"')

        if n.get('card_data') is None or not isinstance(n.get('card_data'), dict):
            errors.append('card_data: required, must be an object')

        if n.get('meta') is not None:
            if not isinstance(n['meta'], dict):
                errors.append('meta: must be an object')
            else:
                meta = n['meta']
                if meta.get('title') is not None and not isinstance(meta['title'], str):
                    errors.append('meta.title: must be a string')
                if meta.get('tags') is not None and not isinstance(meta['tags'], list):
                    errors.append('meta.tags: must be an array')

        if n.get('requires') is not None and not isinstance(n['requires'], list):
            errors.append('requires: must be an array of strings')

        if n.get('provides') is not None:
            if not isinstance(n['provides'], list):
                errors.append('provides: must be an array of { bindTo, ref } bindings')
            else:
                for i, p in enumerate(n['provides']):
                    if not isinstance(p, dict):
                        errors.append(f'provides[{i}]: must be an object with bindTo and ref')
                    else:
                        if not isinstance(p.get('bindTo'), str) or not p.get('bindTo'):
                            errors.append(f'provides[{i}]: missing required "bindTo" string')
                        if not isinstance(p.get('ref'), str) or not p.get('ref'):
                            errors.append(f'provides[{i}]: missing required "ref" string')

        if n.get('compute') is not None:
            if not isinstance(n['compute'], list):
                errors.append('compute: must be an array of compute steps')
            else:
                for i, step in enumerate(n['compute']):
                    if not isinstance(step, dict):
                        errors.append(f'compute[{i}]: must be a compute step object')
                    else:
                        if not isinstance(step.get('bindTo'), str) or not step.get('bindTo'):
                            errors.append(f'compute[{i}]: missing required "bindTo" property')
                        if not isinstance(step.get('expr'), str) or not step.get('expr'):
                            errors.append(f'compute[{i}]: missing required "expr" string (JSONata expression)')

        if n.get('source_defs') is not None:
            if not isinstance(n['source_defs'], list):
                errors.append('source_defs: must be an array')
            else:
                bind_tos: set = set()
                output_files: set = set()
                for i, src in enumerate(n['source_defs']):
                    if not isinstance(src, dict):
                        errors.append(f'source_defs[{i}]: must be an object')
                        continue
                    if not isinstance(src.get('bindTo'), str) or not src.get('bindTo'):
                        errors.append(f'source_defs[{i}]: missing required "bindTo" property')
                    else:
                        if src['bindTo'] in bind_tos:
                            errors.append(f'source_defs[{i}]: bindTo "{src["bindTo"]}" is not unique across source_defs')
                        bind_tos.add(src['bindTo'])
                    if not isinstance(src.get('outputFile'), str) or not src.get('outputFile'):
                        errors.append(f'source_defs[{i}]: missing required "outputFile" property')
                    else:
                        if src['outputFile'] in output_files:
                            errors.append(f'source_defs[{i}]: outputFile "{src["outputFile"]}" is not unique across source_defs')
                        output_files.add(src['outputFile'])
                    if src.get('optionalForCompletionGating') is not None and not isinstance(src['optionalForCompletionGating'], bool):
                        errors.append(f'source_defs[{i}]: optionalForCompletionGating must be a boolean')

        if n.get('view') is not None:
            if not isinstance(n['view'], dict):
                errors.append('view: must be an object')
            else:
                view = n['view']
                if not isinstance(view.get('elements'), list) or len(view['elements']) == 0:
                    errors.append('view.elements: required, must be a non-empty array')
                else:
                    for i, elem in enumerate(view['elements']):
                        if not isinstance(elem, dict):
                            errors.append(f'view.elements[{i}]: must be an object')
                            continue
                        kind = elem.get('kind')
                        if not kind or not isinstance(kind, str):
                            errors.append(f'view.elements[{i}].kind: required, must be a string')
                        elif kind not in VALID_ELEMENT_KINDS:
                            errors.append(f'view.elements[{i}].kind: unknown kind "{kind}". Valid: {", ".join(sorted(VALID_ELEMENT_KINDS))}')
                        if elem.get('data') is not None and not isinstance(elem['data'], dict):
                            errors.append(f'view.elements[{i}].data: must be an object')
                if view.get('layout') is not None and not isinstance(view['layout'], dict):
                    errors.append('view.layout: must be an object')
                if view.get('features') is not None and not isinstance(view['features'], dict):
                    errors.append('view.features: must be an object')

        return {'ok': len(errors) == 0, 'errors': errors}

    @staticmethod
    def validate_live_card_runtime_expressions(node: object) -> dict:
        """
        Port of validateLiveCardRuntimeExpressions from schema-validator.ts.
        Validates namespace usage in compute[].expr, provides[].ref, view paths,
        and source_defs[].projections.
        Returns {ok: bool, errors: list[str]}.
        """
        import re as _re
        errors: list[str] = []

        KNOWN_NS = {'card_data', 'requires', 'fetched_sources', 'computed_values', 'source_defs'}
        NS_RE = _re.compile(r'\b(card_data|requires|fetched_sources|computed_values|source_defs)\b')
        ROOT_PATH_RE = _re.compile(r'^\s*(card_data|requires|fetched_sources|computed_values|source_defs)(\.|$)')

        def referenced_namespaces(expr: str) -> set:
            return set(NS_RE.findall(expr))

        def parse_root_namespace(path: str):
            m = ROOT_PATH_RE.match(path)
            return m.group(1) if m else None

        def check_expr(expr: str, path: str, allowed: set):
            try:
                _jsonata_evaluate(expr, {})  # parse check
            except Exception as ex:
                errors.append(f'{path}: invalid JSONata expression ({ex})')
                return
            for ns in referenced_namespaces(expr):
                if ns not in allowed:
                    errors.append(f'{path}: disallowed namespace "{ns}" in expression')

        def walk_view_refs(value: object, path: str):
            """Recurse into view structure checking path-string namespaces."""
            VALID_VIEW_NS = {'card_data', 'requires', 'computed_values'}  # fetched_sources NOT allowed
            if isinstance(value, list):
                for i, item in enumerate(value):
                    walk_view_refs(item, f'{path}/{i}')
                return
            if isinstance(value, str):
                root_ns = parse_root_namespace(value)
                if root_ns and root_ns not in VALID_VIEW_NS:
                    errors.append(f'{path}: disallowed namespace "{root_ns}" in view reference')
                return
            if isinstance(value, dict):
                for k, v in value.items():
                    walk_view_refs(v, f'{path}/{k}')

        if not node or not isinstance(node, dict):
            return {'ok': True, 'errors': []}

        n = node

        # compute[].expr — fetched_sources allowed
        VALID_COMPUTE_NS = {'card_data', 'requires', 'fetched_sources', 'computed_values'}
        compute = n.get('compute')
        if isinstance(compute, list):
            for i, step in enumerate(compute):
                if not isinstance(step, dict):
                    continue
                expr = step.get('expr', '')
                if not isinstance(expr, str) or not expr.strip():
                    continue
                check_expr(expr, f'/compute/{i}/expr', VALID_COMPUTE_NS)

        # provides[].ref — fetched_sources NOT allowed in view (but allowed here as it's raw data output)
        # Note: TS currently allows fetched_sources in provides[].ref — keeping parity
        VALID_PROVIDES_NS = {'card_data', 'requires', 'fetched_sources', 'computed_values'}
        provides = n.get('provides')
        if isinstance(provides, list):
            for i, entry in enumerate(provides):
                if not isinstance(entry, dict):
                    continue
                ref = entry.get('ref', '')
                if not isinstance(ref, str) or not ref.strip():
                    continue
                root_ns = parse_root_namespace(ref)
                if root_ns is None:
                    errors.append(f'/provides/{i}/ref: path "{ref}" must start with a valid namespace ({", ".join(sorted(VALID_PROVIDES_NS))})')
                elif root_ns not in VALID_PROVIDES_NS:
                    errors.append(f'/provides/{i}/ref: disallowed namespace "{root_ns}" in path "{ref}" (valid: {", ".join(sorted(VALID_PROVIDES_NS))})')

        # view — fetched_sources NOT allowed
        view = n.get('view')
        if isinstance(view, dict):
            walk_view_refs(view, '/view')

        # source_defs[].projections — only card_data, requires allowed
        VALID_PROJ_NS = {'card_data', 'requires'}
        source_defs = n.get('source_defs')
        if isinstance(source_defs, list):
            for i, src in enumerate(source_defs):
                if not isinstance(src, dict):
                    continue
                projections = src.get('projections')
                if not isinstance(projections, dict):
                    continue
                for key, expr_val in projections.items():
                    if not isinstance(expr_val, str) or not expr_val.strip():
                        continue
                    check_expr(expr_val, f'/source_defs/{i}/projections/{key}', VALID_PROJ_NS)

        return {'ok': len(errors) == 0, 'errors': errors}

    @staticmethod
    def validate_live_card_definition(node: object) -> dict:
        """
        Full validation: structural check + runtime expression check.
        Port of validateLiveCardDefinition from schema-validator.ts.
        """
        schema = CardCompute.validate(node)
        if not schema['ok']:
            return schema
        runtime = CardCompute.validate_live_card_runtime_expressions(node)
        combined = schema['errors'] + runtime['errors']
        return {'ok': len(combined) == 0, 'errors': combined}

    @staticmethod
    def enrich_sources_sync(
        source_defs: list[dict] | None,
        context: dict | None = None,
    ) -> list[dict]:
        """
        Evaluate projection expressions in source definitions.

        For each source_def with projections, evaluates the JSONata expressions
        against the provided context and attaches results as _projections.

        Returns enriched copy of source_defs.
        """
        if not source_defs:
            return []

        ctx = context or {}
        enriched = []
        for src in source_defs:
            src_copy = {**src}
            projections = src_copy.get("projections")
            if projections and isinstance(projections, dict):
                resolved: dict[str, Any] = {}
                for key, expr in projections.items():
                    try:
                        resolved[key] = _jsonata_evaluate(expr, ctx)
                    except Exception:
                        resolved[key] = None
                src_copy["_projections"] = resolved
            enriched.append(src_copy)
        return enriched
