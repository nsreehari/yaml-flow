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
