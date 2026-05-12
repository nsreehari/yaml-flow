"""
Execution Interface

Pure module — no platform imports. Safe for any runtime.

Defines the portable descriptor types for invoking any executable target,
regardless of transport (local process, HTTP endpoint, cloud function, etc.).

Port of src/cli/common/execution-interface.ts
"""
from __future__ import annotations

import json
from typing import Any

from .storage_interface import serialize_ref


# ============================================================================
# ExecutionRef helpers
# ============================================================================

# ExecutionRef is a dict:
# {
#   "howToRun": str,     # 'local-node' | 'local-python' | 'local-process' | 'http:post' | 'http:get' | 'built-in'
#   "whatToRun": str,     # KindValueRef wire form (b64:<base64url(json)>)
#   "meta": str | None,   # optional label
#   "argsMassaging": dict | None,  # optional JSONata mapping
#   "extra": dict | None,  # optional opaque executor config
# }

# ExecutionResult is a dict:
# {
#   "status": str,  # 'success' | 'fail' | 'error'
#   "data": str | None,  # KindValueRef wire form on success
#   "error": str | None,  # message on fail/error
# }


def serialize_execution_ref(ref: dict) -> str:
    """Serialize an ExecutionRef to a JSON string for storage."""
    return json.dumps(ref)


def parse_execution_ref(s: str) -> dict:
    """
    Parse a JSON string back into an ExecutionRef.
    Raises if the string is not valid JSON or is missing required fields.
    """
    try:
        parsed = json.loads(s)
    except (json.JSONDecodeError, TypeError) as exc:
        raise ValueError(f"parseExecutionRef: invalid JSON — {s}") from exc

    if (
        not isinstance(parsed, dict)
        or not isinstance(parsed.get("howToRun"), str)
        or not isinstance(parsed.get("whatToRun"), str)
    ):
        raise ValueError(f"parseExecutionRef: missing required fields howToRun/whatToRun — {s}")

    return parsed


def execution_ref_from_script_path(
    script_path: str,
    extra: dict | None = None,
) -> dict:
    """
    Create an ExecutionRef from a script path string.
    File extension determines howToRun:
      .js / .mjs -> 'local-node'
      .py        -> 'local-python'
      other      -> 'local-process'
    """
    lower = script_path.lower()
    if lower.endswith(".js") or lower.endswith(".mjs"):
        how_to_run = "local-node"
    elif lower.endswith(".py"):
        how_to_run = "local-python"
    else:
        how_to_run = "local-process"

    ref: dict[str, Any] = {
        "meta": "task-executor",
        "howToRun": how_to_run,
        "whatToRun": serialize_ref({"kind": "fs-path", "value": script_path}),
    }
    if extra:
        ref["extra"] = extra
    return ref
