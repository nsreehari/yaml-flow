"""
step_machine_native_bridge.py

Drop-in replacement for step_machine_quickjs_bridge.py.
Instead of executing a JS bundle via QuickJS, this module calls
the Python-native port of the step-machine directly.

Same payload shape as the QuickJS invoke path.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional

# Ensure pylib is importable
_PYCLI_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
if _PYCLI_ROOT not in sys.path:
    sys.path.insert(0, _PYCLI_ROOT)

from pylib.step_machine.step_machine import StepMachine
from pylib.step_machine.loader import validate_step_flow_config
from pylib.stores.memory import MemoryStore


class _FileStore:
    """File-based store matching the QuickJS HostFileStore pattern."""

    def __init__(self, directory: str):
        self._dir = directory
        os.makedirs(directory, exist_ok=True)

    def _run_path(self, run_id: str) -> Path:
        return Path(self._dir) / f"{run_id}.run.json"

    def _data_path(self, run_id: str) -> Path:
        return Path(self._dir) / f"{run_id}.data.json"

    def save_run_state(self, run_id: str, state: dict) -> None:
        self._run_path(run_id).write_text(
            json.dumps(state, ensure_ascii=True), encoding="utf-8"
        )

    def load_run_state(self, run_id: str) -> Optional[dict]:
        p = self._run_path(run_id)
        if not p.exists():
            return None
        return json.loads(p.read_text(encoding="utf-8"))

    def delete_run_state(self, run_id: str) -> None:
        p = self._run_path(run_id)
        if p.exists():
            p.unlink()
        dp = self._data_path(run_id)
        if dp.exists():
            dp.unlink()

    def set_data(self, run_id: str, key: str, value: Any) -> None:
        dp = self._data_path(run_id)
        data = {}
        if dp.exists():
            data = json.loads(dp.read_text(encoding="utf-8"))
        data[key] = value
        dp.write_text(json.dumps(data, ensure_ascii=True), encoding="utf-8")

    def get_data(self, run_id: str, key: str) -> Any:
        dp = self._data_path(run_id)
        if not dp.exists():
            return None
        data = json.loads(dp.read_text(encoding="utf-8"))
        return data.get(key)

    def get_all_data(self, run_id: str) -> dict:
        dp = self._data_path(run_id)
        if not dp.exists():
            return {}
        return json.loads(dp.read_text(encoding="utf-8"))

    def clear_data(self, run_id: str) -> None:
        dp = self._data_path(run_id)
        if dp.exists():
            dp.unlink()

    def list_runs(self) -> list:
        p = Path(self._dir)
        if not p.exists():
            return []
        return [f.stem.replace(".run", "") for f in p.glob("*.run.json")]


def _create_cli_handler(
    spec: dict,
    flow_dir: str,
    handler_vars: Optional[Dict[str, Any]] = None,
):
    """Create a handler that executes a CLI command (matching QuickJS behavior)."""
    cli_cmd = spec.get("cli", "")
    input_transforms = spec.get("input-transforms", {})
    output_transforms = spec.get("output-transforms", {})
    result_mode = spec.get("result-mode", "json")

    def handler(input_data: dict, context: dict) -> dict:
        # Build command
        cmd = cli_cmd
        # Simple variable substitution in CLI command
        if handler_vars:
            for k, v in handler_vars.items():
                cmd = cmd.replace(f"${{{k}}}", str(v))

        try:
            proc = subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                cwd=flow_dir,
                timeout=300,
                input=json.dumps(input_data) if input_data else None,
            )
            stdout = proc.stdout.strip()
            stderr = proc.stderr.strip()

            if proc.returncode != 0:
                return {
                    "result": "failure",
                    "data": {"error": stderr or f"Exit code {proc.returncode}", "stdout": stdout},
                }

            # Parse output
            if result_mode == "json" and stdout:
                try:
                    parsed = json.loads(stdout)
                    if isinstance(parsed, dict):
                        result_key = parsed.get("result", parsed.get("status", "success"))
                        data = parsed.get("data", parsed)
                        if isinstance(data, dict):
                            return {"result": str(result_key), "data": data}
                        return {"result": str(result_key), "data": {"output": data}}
                except json.JSONDecodeError:
                    pass
            
            return {"result": "success", "data": {"stdout": stdout}}

        except subprocess.TimeoutExpired:
            return {"result": "failure", "data": {"error": "Command timed out"}}
        except Exception as e:
            return {"result": "failure", "data": {"error": str(e)}}

    return handler


def _is_cli_spec(spec: Any) -> bool:
    return (
        isinstance(spec, dict)
        and isinstance(spec.get("cli"), str)
        and len(spec["cli"].strip()) > 0
    )


def _is_inline_spec(spec: Any) -> bool:
    return (
        isinstance(spec, dict)
        and isinstance(spec.get("inline"), str)
        and len(spec["inline"].strip()) > 0
    )


def _normalize_handler_result(raw: Any, step_name: str) -> dict:
    if not isinstance(raw, dict):
        raise ValueError(
            f'[step-machine-pycli] Step "{step_name}" returned a non-dict result.'
        )
    result = raw.get("result") or raw.get("status")
    if not isinstance(result, str) or not result.strip():
        raise ValueError(
            f'[step-machine-pycli] Step "{step_name}" result must include a non-empty "result" string.'
        )
    data = raw.get("data", {})
    if not isinstance(data, dict):
        data = {}
    error = raw.get("error")
    if isinstance(error, str) and "error" not in data:
        data["error"] = error
    return {"result": result, "data": data}


def _filter_produced_data(data: Optional[dict], produces: Optional[list]) -> dict:
    src = data or {}
    if not produces:
        return src
    return {k: src[k] for k in produces if k in src}


def invoke_step_machine_native(
    *,
    payload: Dict[str, Any],
    inline_handlers: Optional[Dict[str, Callable[..., Any]]] = None,
) -> Dict[str, Any]:
    """
    Native Python replacement for invoke_step_machine_bundle.

    Accepts the same StepMachineInvokePayload shape and returns
    the same StepMachineInvokeResult shape.
    """
    mode = payload.get("mode", "run")
    flow = payload.get("flow", {})
    flow_dir = payload.get("flowDir", ".")
    store_spec = payload.get("store", {"type": "memory"})
    run_id = payload.get("runId")
    initial_data = payload.get("initialData")
    inline_handler_names = payload.get("inlineHandlerNames", [])
    pause_file_path = payload.get("pauseFilePath")
    handler_vars = payload.get("handlerVars", {})

    # Validate flow
    errors = validate_step_flow_config(flow)
    if errors:
        return {"status": "failed", "error": f"Invalid flow: {'; '.join(errors)}"}

    # Create store
    if store_spec.get("type") == "file":
        store = _FileStore(store_spec["directory"])
    else:
        store = MemoryStore()

    # Build handlers
    handlers: Dict[str, Callable] = {}
    steps = flow.get("steps", {})
    for step_name, step_config in steps.items():
        handler_spec = step_config.get("handler")

        if _is_inline_spec(handler_spec):
            inline_name = handler_spec["inline"]
            if inline_handlers and inline_name in inline_handlers:
                _fn = inline_handlers[inline_name]
                produces = step_config.get("produces_data")

                def _make_inline_handler(fn, prod, sname):
                    def _h(input_data, context):
                        raw = fn(input_data, context)
                        normalized = _normalize_handler_result(raw, sname)
                        normalized["data"] = _filter_produced_data(
                            normalized.get("data"), prod
                        )
                        return normalized
                    return _h

                handlers[step_name] = _make_inline_handler(_fn, produces, step_name)
            else:
                def _missing_handler(input_data, context, _name=inline_name):
                    return {
                        "result": "failure",
                        "data": {"error": f"Inline handler '{_name}' not provided"},
                    }
                handlers[step_name] = _missing_handler

        elif _is_cli_spec(handler_spec):
            produces = step_config.get("produces_data")
            cli_handler = _create_cli_handler(handler_spec, flow_dir, handler_vars)

            def _make_cli_handler(ch, prod, sname):
                def _h(input_data, context):
                    raw = ch(input_data, context)
                    normalized = _normalize_handler_result(raw, sname)
                    normalized["data"] = _filter_produced_data(
                        normalized.get("data"), prod
                    )
                    return normalized
                return _h

            handlers[step_name] = _make_cli_handler(cli_handler, produces, step_name)
        else:
            # Default pass-through handler
            def _default_handler(input_data, context, _name=step_name):
                return {"result": "success", "data": {}}
            handlers[step_name] = _default_handler

    # Create and run step machine
    try:
        machine = StepMachine(flow, handlers, options={"store": store})

        if mode == "resume":
            if not run_id:
                return {"status": "noop", "reason": "no-run-id"}
            result = machine.resume(run_id)
        else:
            result = machine.run(initial_data)

        return {
            "status": result.get("status", "completed"),
            "runId": result.get("runId"),
            "intent": result.get("intent"),
            "finalStep": result.get("finalStep"),
            "stepHistory": result.get("stepHistory", []),
            "data": result.get("data", {}),
            "currentStep": result.get("finalStep"),
            "error": str(result["error"]) if result.get("error") else None,
        }
    except Exception as e:
        return {"status": "failed", "error": str(e)}
