"""
step_machine_public — result utilities (Python).

Pure helpers — no transport, no I/O — that:
  * Normalize handler return shapes into NormalizedHandlerResult.
  * Filter `data` to keys declared in `produces_data`.
  * Wrap a handler with output filtering / input validation.

Mirror of src/step-machine-public/result-utils.ts.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from ..card_compute import CardCompute


# ============================================================================
# normalize_handler_result — accept legacy or strict shape
# ============================================================================

def normalize_handler_result(raw: Any, step_name: str) -> Dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError(
            f'[step-machine-public] Step "{step_name}" returned a non-dict result.'
        )

    result = raw.get("result")
    if result is None:
        result = raw.get("status")

    if isinstance(result, str) and result.strip():
        data_in = raw.get("data")
        data: Dict[str, Any] = (
            dict(data_in) if isinstance(data_in, dict) else {}
        )
        error = raw.get("error") if isinstance(raw.get("error"), str) else None
        if error and "error" not in data:
            data["error"] = error
        out: Dict[str, Any] = {"result": result, "data": data}
        if error:
            out["error"] = error
        return out

    # Bare object — treat the whole thing as data, intent = success.
    return {"result": "success", "data": dict(raw)}


# ============================================================================
# filter_produced_data — narrow data to declared produces_data keys
# ============================================================================

def filter_produced_data(
    data: Dict[str, Any],
    produces: Optional[List[str]],
) -> Dict[str, Any]:
    if not produces:
        return data
    return {k: data[k] for k in produces if k in data}


# ============================================================================
# wrap_with_output_filtering — compose normalization + produces_data filtering
# ============================================================================

def wrap_with_output_filtering(
    handler: Callable[..., Any],
    produces: Optional[List[str]],
) -> Callable[..., Dict[str, Any]]:
    def wrapped(input_data: Dict[str, Any], context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        raw = handler(input_data, context)
        step_name = (context or {}).get("stepName", "unknown") if isinstance(context, dict) else "unknown"
        normalized = normalize_handler_result(raw, step_name)
        out: Dict[str, Any] = {
            "result": normalized["result"],
            "data": filter_produced_data(normalized["data"], produces),
        }
        if normalized.get("error"):
            out["error"] = normalized["error"]
        return out
    return wrapped


# ============================================================================
# run_input_validations — evaluate JSONata validation expressions
# ============================================================================

def run_input_validations(
    input_data: Dict[str, Any],
    validations: Optional[List[str]],
    step_name: str,
) -> Optional[Dict[str, Any]]:
    if not validations:
        return None
    for expr in validations:
        try:
            val = CardCompute.eval_expr(expr, input_data)
        except Exception as ex:
            return {
                "result": "failure",
                "data": {
                    "error": f'[{step_name}] input validation error on "{expr}": {ex}',
                },
            }
        if not val:
            return {
                "result": "failure",
                "data": {"error": f"[{step_name}] input validation failed: {expr}"},
            }
    return None


# ============================================================================
# wrap_with_input_validations — short-circuit if any validation fails
# ============================================================================

def wrap_with_input_validations(
    handler: Callable[..., Any],
    validations: Optional[List[str]],
    step_name: str,
) -> Callable[..., Dict[str, Any]]:
    if not validations:
        return handler

    def wrapped(input_data: Dict[str, Any], context: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        failure = run_input_validations(input_data, validations, step_name)
        if failure is not None:
            return failure
        return handler(input_data, context)

    return wrapped
