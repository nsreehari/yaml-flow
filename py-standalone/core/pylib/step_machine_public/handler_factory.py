"""
step_machine_public — handler factory (Python).

Builds engine-facing step handlers from declarative HandlerSpec entries.
Pure: no subprocess, no HTTP. Refs are dispatched through the caller-supplied
`invoke` callable, which is the single boundary between this lib and any
transport (subprocess spawn, HTTP, Azure Function, etc.).

Mirror of src/step-machine-public/handler-factory.ts.
"""
from __future__ import annotations

import concurrent.futures
from typing import Any, Callable, Dict, List, Optional

from ..card_compute import CardCompute, deep_set
from .result_utils import (
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
    if not isinstance(spec, dict):
        return False
    if spec.get("type") != "ref" or not isinstance(spec.get("howToRun"), str):
        return False
    wtr = spec.get("whatToRun")
    if isinstance(wtr, str):
        return True
    if isinstance(wtr, dict):
        return isinstance(wtr.get("kind"), str) and isinstance(wtr.get("value"), str)
    return False


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
        expects_data: Dict[str, Any] = (
            dict(input_data) if isinstance(input_data, dict) else {}
        )

        # `data` accumulates computed outputs by reference so subsequent
        # expressions can read `data.x` after earlier steps set it.
        data: Dict[str, Any] = {}

        # Context shape:
        #   expects_data — named namespace for declared step inputs (from flow state)
        #   data         — accumulating output namespace (mutated by reference)
        #   config       — optional step-level config
        ctx: Dict[str, Any] = {"expects_data": expects_data, "data": data}
        if config is not None:
            ctx["config"] = config

        transition_result: Optional[str] = None
        transition_error: Optional[str] = None

        for step in steps:
            try:
                val = CardCompute.eval_expr(step["expr"], ctx)
                if step["bindTo"] == "result":
                    transition_result = str(val) if val is not None else "success"
                elif step["bindTo"] == "error":
                    transition_error = str(val) if val is not None else None
                elif step["bindTo"].startswith("data."):
                    deep_set(data, step["bindTo"][len("data."):], val)
                else:
                    return {
                        "result": "failure",
                        "data": {},
                        "error": (
                            f'[{step_name}] invalid bindTo "{step["bindTo"]}": '
                            'must be "result", "error", or start with "data."'
                        ),
                    }
            except Exception as ex:
                return {
                    "result": "failure",
                    "data": {},
                    "error": f'[{step_name}] compute "{step["bindTo"]}" failed: {ex}',
                }

        if transition_result is None:
            return {
                "result": "failure",
                "data": {},
                "error": (
                    f'[{step_name}] compute-jsonata: no "result" binding declared '
                    '— add \'- result = "success"\' to expr'
                ),
            }
        if transition_error is not None:
            return {"result": transition_result, "data": data, "error": transition_error}
        return {"result": transition_result, "data": data}

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
    # Normalize whatToRun: object form { kind, value } stays as dict (invoke handles both forms).
    ref = {k: v for k, v in spec.items() if k != "type"}

    def handler(input_data: Dict[str, Any], context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        step_input: Dict[str, Any] = (
            dict(input_data) if isinstance(input_data, dict) else {}
        )
        if config is not None:
            step_input["config"] = config
        try:
            raw = invoke(ref, step_input)
        except Exception as ex:
            return {
                "result": "failure",
                "data": {"error": f'[step-machine-public] step "{step_name}" invoke threw: {ex}'},
            }
        output_transforms = spec.get("outputTransforms")
        if not output_transforms:
            return raw
        try:
            return resolve_output_transforms(output_transforms, raw, step_name)
        except Exception as ex:
            return {"result": "failure", "data": {}, "error": str(ex)}

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
# forEach wrapper — iterates a handler over an array with concurrency control
# ============================================================================

def wrap_with_for_each(
    handler: Callable[..., Dict[str, Any]],
    for_each: Dict[str, Any],
    step_name: str,
) -> Callable[..., Dict[str, Any]]:
    """
    Wraps a handler to iterate over an array field with optional concurrency.

    for_each dict keys:
      items       — name of the input key holding the array
      as          — name to bind each element under
      concurrency — max parallel invocations (default 1)
      collectAs   — output key for collected results (default: <items>_results)
    """
    items_key = for_each["items"]
    as_key = for_each["as"]
    concurrency = max(1, for_each.get("concurrency", 1))
    collect_as = for_each.get("collectAs", f"{items_key}_results")

    def wrapped(input_data: Dict[str, Any], context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        arr = (input_data or {}).get(items_key)
        if not isinstance(arr, list):
            return {
                "result": "failure",
                "data": {},
                "error": f'[{step_name}] forEach: "{items_key}" is not an array (got {type(arr).__name__})',
            }

        if len(arr) == 0:
            return {"result": "success", "data": {collect_as: []}}

        rest_input = {k: v for k, v in (input_data or {}).items() if k != items_key}
        results: List[Dict[str, Any]] = [{}] * len(arr)

        def run_item(idx: int) -> Dict[str, Any]:
            item_input = {**rest_input, as_key: arr[idx]}
            try:
                return handler(item_input, context)
            except Exception as ex:
                return {"result": "failure", "data": {}, "error": str(ex)}

        if concurrency == 1:
            for i in range(len(arr)):
                results[i] = run_item(i)
        else:
            with concurrent.futures.ThreadPoolExecutor(max_workers=concurrency) as pool:
                futures = {pool.submit(run_item, i): i for i in range(len(arr))}
                for future in concurrent.futures.as_completed(futures):
                    idx = futures[future]
                    results[idx] = future.result()

        failures = [r for r in results if r.get("result") == "failure"]
        if failures:
            errors = [r.get("error", "unknown") for r in failures]
            return {
                "result": "failure",
                "data": {"errors": errors},
                "error": f"[{step_name}] forEach: {len(failures)}/{len(arr)} items failed",
            }

        return {
            "result": "success",
            "data": {collect_as: [r.get("data", {}) for r in results]},
        }

    return wrapped


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

    # forEach wraps before output filtering so collected results flow through produces_data
    for_each = step_config.get("forEach")
    if isinstance(for_each, dict) and "items" in for_each and "as" in for_each:
        base = wrap_with_for_each(base, for_each, step_name)

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
