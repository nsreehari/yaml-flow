"""
args_massaging.py

JSONata-based mapping from logical args to transport-specific shape.

`argsMassaging` is a property of `ExecutionRef`, so honoring it is the job
of every adapter (subprocess, HTTP, Azure Function, etc.). This helper is
the shared pure-JSONata implementation reused by all adapters.

Mirror of src/cli/common/args-massaging.ts.
"""
from __future__ import annotations

from typing import Any, Dict, Optional

# Ensure vendored packages are importable
try:
    from ..vendor import __path__ as _vendor_path  # noqa: F401
except ImportError:
    pass

try:
    from jsonata import Jsonata as _Jsonata
    _JSONATA_AVAILABLE = True
except Exception:
    _JSONATA_AVAILABLE = False


def _jsonata_evaluate(expr: str, context: Dict[str, Any]) -> Any:
    if not _JSONATA_AVAILABLE:
        raise RuntimeError(
            "[args-massaging] jsonata package not installed. "
            "Run: python -m pip install -r standalone/requirements.txt"
        )
    return _Jsonata(expr).evaluate(context)


def resolve_args_massaging(
    args_massaging: Optional[Dict[str, Any]],
    context: Dict[str, Any],
    label: str,
) -> Dict[str, Any]:
    """
    Evaluate `argsMassaging` against the supplied context.

    Returns a dict with optional keys:
      cmdArgs: list[str]  — argv tail (local transports)
      body:    Any        — request body (HTTP) / stdin payload (local)
      url:     str        — final URL (HTTP transports)

    Raises ValueError with a label-tagged message if any expression fails.
    Adapters should catch and convert to a normalized failure result.
    """
    if not args_massaging or not isinstance(args_massaging, dict):
        return {}

    out: Dict[str, Any] = {}

    cmd_template = args_massaging.get("cmdTemplate")
    if isinstance(cmd_template, list):
        resolved = []
        for expr in cmd_template:
            try:
                resolved.append(str(_jsonata_evaluate(expr, context)))
            except Exception as ex:
                raise ValueError(
                    f'[{label}] argsMassaging.cmdTemplate failed on "{expr}": {ex}'
                ) from ex
        out["cmdArgs"] = resolved

    body_template = args_massaging.get("bodyTemplate")
    if isinstance(body_template, str):
        try:
            out["body"] = _jsonata_evaluate(body_template, context)
        except Exception as ex:
            raise ValueError(
                f'[{label}] argsMassaging.bodyTemplate failed: {ex}'
            ) from ex

    url_template = args_massaging.get("urlTemplate")
    if isinstance(url_template, str):
        try:
            out["url"] = str(_jsonata_evaluate(url_template, context))
        except Exception as ex:
            raise ValueError(
                f'[{label}] argsMassaging.urlTemplate failed: {ex}'
            ) from ex

    return out
