"""
step_machine_public — declarative handler factory (Python).

Pure: no transport, no I/O.
Builds engine-facing step handlers from declarative HandlerSpec entries.

Mirrors src/step-machine-public/ in the TS tree.

Layering:

  step_machine (pure FSM)              — runs handlers, never builds them.
  step_machine_public (this lib)       — declarative spec → handler map.
  adapter (e.g. cli.execution_adapter) — invoke_ref implementation per transport.
  step_machine_pycli (thin shell)      — wires adapter + flow loader + run.
"""
from .handler_factory import (
    build_step_handlers_for_flow,
    create_compute_jsonata_handler,
    create_passthrough_handler,
    create_ref_step_handler,
    is_compute_jsonata_spec,
    is_ref_spec,
    resolve_step_handler,
)
from .result_utils import (
    filter_produced_data,
    normalize_handler_result,
    run_input_validations,
    wrap_with_input_validations,
    wrap_with_output_filtering,
)

__all__ = [
    "build_step_handlers_for_flow",
    "create_compute_jsonata_handler",
    "create_passthrough_handler",
    "create_ref_step_handler",
    "is_compute_jsonata_spec",
    "is_ref_spec",
    "resolve_step_handler",
    "filter_produced_data",
    "normalize_handler_result",
    "run_input_validations",
    "wrap_with_input_validations",
    "wrap_with_output_filtering",
]
