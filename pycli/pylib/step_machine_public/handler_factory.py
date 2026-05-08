"""
step_machine_public — handler factory (Python).

Builds engine-facing step handlers from declarative HandlerSpec entries.
Pure: no subprocess, no HTTP. Refs are dispatched through the caller-supplied
`invoke` callable, which is the single boundary between this lib and any
transport (subprocess spawn, HTTP, Azure Function, etc.).

Mirror of src/step-machine-public/handler-factory.ts.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from .result_utils import (
    _jsonata_evaluate,  # type: ignore[attr-defined]
    wrap_with_input_validations,
    wrap_with_output_filtering,
)

# ============================================================================
# Discriminators
# ============================================================================

def is_compute_jsonata_spec(spec: Any) -> bool:
    return (
        isinstance(spec, dict)
        and spec.get("type") == "compute-jsonata"
        and isinstance(spec.get("expr"), list)
        and len(spec["expr"]) > 0
    )


def is_ref_spec(spec: Any) -> bool:
    return (
        isinstance(spec, dict)
        and spec.get("type") == "ref"
        and isinstance(spec.get("howToRun"), str)
        and isinstance(spec.get("whatToRun"), str)
    )


# ============================================================================
# Compute-jsonata handler
# ============================================================================

def _normalize_compute_step(item: Any) -> Dict[str, str]:
    if isinstance(item, str):
        eq = item.find("=")
        if eq < 1:
            raise ValueError(
                f'[step-machine-public] Invalid compute expression (missing "="): "{item}"'
            )
        return {"bindTo": item[:eq].strip(), "expr": item[eq + 1:].strip()}
    if (
        isinstance(item, dict)
        and isinstance(item.get("bindTo"), str)
        and isinstance(item.get("expr"), str)
    ):
        return {"bindTo": item["bindTo"], "expr": item["expr"]}
    raise ValueError(f"[step-machine-public] Invalid compute step: {item!r}")


def create_compute_jsonata_handler(
    spec: Dict[str, Any],
    step_name: str,
    config: Optional[Dict[str, Any]] = None,
) -> Callable[..., Dict[str, Any]]:
    steps = [_normalize_compute_step(item) for item in spec["expr"]]

    def handler(input_data: Dict[str, Any], context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        ctx: Dict[str, Any] = (
            dict(input_data) if isinstance(input_data, dict) else {}
        )
        if config is not None:
            ctx["config"] = config

        computed: Dict[str, Any] = {}
        for step in steps:
            try:
                eval_ctx = {**ctx, **computed}
                computed[step["bindTo"]] = _jsonata_evaluate(step["expr"], eval_ctx)
            except Exception as ex:
                return {
                    "result": "failure",
                    "data": {"error": f'[{step_name}] compute "{step["bindTo"]}" failed: {ex}'},
                }
        return {"result": "success", "data": computed}

    return handler


# ============================================================================
# Ref handler — dispatches via invoke callable
# ============================================================================

def create_ref_step_handler(
    spec: Dict[str, Any],
    step_name: str,
    invoke: Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]],
    config: Optional[Dict[str, Any]] = None,
) -> Callable[..., Dict[str, Any]]:
    # Spec is a superset of ExecutionRef (has type: 'ref'). Strip discriminator.
    ref = {k: v for k, v in spec.items() if k != "type"}

    def handler(input_data: Dict[str, Any], context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        step_input: Dict[str, Any] = (
            dict(input_data) if isinstance(input_data, dict) else {}
        )
        if config is not None:
            step_input["config"] = config
        try:
            return invoke(ref, step_input)
        except Exception as ex:
            return {
                "result": "failure",
                "data": {"error": f'[step-machine-public] step "{step_name}" invoke threw: {ex}'},
            }

    return handler


# ============================================================================
# Passthrough handler
# ============================================================================

def create_passthrough_handler() -> Callable[..., Dict[str, Any]]:
    def handler(input_data: Dict[str, Any], context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        data = dict(input_data) if isinstance(input_data, dict) else {}
        return {"result": "success", "data": data}
    return handler


# ============================================================================
# resolve_step_handler — pick + decorate the right handler for a step
# ============================================================================

def resolve_step_handler(
    step_name: str,
    step_config: Optional[Dict[str, Any]],
    invoke: Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]],
) -> Callable[..., Dict[str, Any]]:
    step_config = step_config or {}
    produces_raw = step_config.get("produces_data")
    produces: Optional[List[str]] = produces_raw if isinstance(produces_raw, list) else None
    validations_raw = step_config.get("input_validations")
    validations: Optional[List[str]] = validations_raw if isinstance(validations_raw, list) else None
    config = step_config.get("config")
    spec = step_config.get("handler")

    if is_compute_jsonata_spec(spec):
        base = create_compute_jsonata_handler(spec, step_name, config)
    elif is_ref_spec(spec):
        base = create_ref_step_handler(spec, step_name, invoke, config)
    else:
        base = create_passthrough_handler()

    return wrap_with_input_validations(
        wrap_with_output_filtering(base, produces),
        validations,
        step_name,
    )


# ============================================================================
# build_step_handlers_for_flow — produce the dict[step_name, handler] map
# ============================================================================

def build_step_handlers_for_flow(
    flow: Dict[str, Any],
    invoke: Callable[[Dict[str, Any], Dict[str, Any]], Dict[str, Any]],
) -> Dict[str, Callable[..., Dict[str, Any]]]:
    handlers: Dict[str, Callable[..., Dict[str, Any]]] = {}
    for step_name, step_config in (flow.get("steps") or {}).items():
        handlers[step_name] = resolve_step_handler(step_name, step_config, invoke)
    return handlers
