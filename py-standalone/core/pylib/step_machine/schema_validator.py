"""
Step Machine — Schema Validator

Simplified port — no AJV. Delegates to validate_step_flow_config from loader.

Port of src/step-machine/schema-validator.ts
"""
from __future__ import annotations

from .loader import validate_step_flow_config


def validate_flow_schema(config: dict) -> dict:
    """
    Validate a flow configuration schema.

    Returns {"ok": True, "errors": []} on success,
    or {"ok": False, "errors": [...]} on failure.
    """
    errors = validate_step_flow_config(config)
    return {"ok": len(errors) == 0, "errors": errors}
