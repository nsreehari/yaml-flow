"""
step_machine_public — types (Python).

Plain dict-based shapes, mirroring src/step-machine-public/types.ts.

NormalizedHandlerResult:
  {
    "result": str,
    "data": dict[str, Any],
    "error": Optional[str],
  }

ComputeJsonataSpec:
  {
    "type": "compute-jsonata",
    "expr": list[str | {"bindTo": str, "expr": str}],
  }

RefSpec (= ExecutionRef + discriminator):
  {
    "type": "ref",
    "howToRun": str,
    "whatToRun": str,
    "argsMassaging": Optional[dict],
    "extra": Optional[dict],
    "meta": Optional[str],
  }

InvokeRefFn:
  Callable[[ExecutionRef, dict[str, Any]], NormalizedHandlerResult]
  May raise; framework converts throws to failure envelopes.

StepHandler:
  Callable[[dict[str, Any], Optional[dict]], NormalizedHandlerResult]
  context dict supplies stepName / runId when invoked by the engine.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, Optional

# Type aliases (documentation only; not enforced at runtime).
NormalizedHandlerResult = Dict[str, Any]
HandlerSpec = Dict[str, Any]
ExecutionRef = Dict[str, Any]
InvokeRefFn = Callable[[ExecutionRef, Dict[str, Any]], NormalizedHandlerResult]
StepHandler = Callable[..., NormalizedHandlerResult]
