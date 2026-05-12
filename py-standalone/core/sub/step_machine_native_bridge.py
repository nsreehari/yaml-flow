"""
step_machine_native_bridge.py

Thin orchestration layer that wires together:
  * pylib.step_machine            — pure FSM
  * pylib.step_machine_public     — declarative handler factory
  * pylib.cli.execution_adapter   — local-process invoke_ref_sync

Equivalent of `step-machine-cli.js` in the TS tree (slimmed in Phase 3).

Only the declarative handler model is supported. Inline-handler injection
was removed when the TS handler model became fully declarative.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, Optional

_PYCLI_ROOT = os.path.normpath(
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
)
if _PYCLI_ROOT not in sys.path:
    sys.path.insert(0, _PYCLI_ROOT)

from pylib.cli.execution_adapter import invoke_ref_sync
from pylib.step_machine.step_machine import StepMachine
from pylib.step_machine.loader import validate_step_flow_config
from pylib.step_machine_public import build_step_handlers_for_flow
from pylib.stores.memory import MemoryStore


class _FileStore:
    """File-based persistent store for step machine state."""

    def __init__(self, directory: str):
        self._dir = directory
        os.makedirs(directory, exist_ok=True)

    def _run_path(self, run_id: str) -> str:
        return os.path.join(self._dir, f"{run_id}.run.json")

    def _data_path(self, run_id: str) -> str:
        return os.path.join(self._dir, f"{run_id}.data.json")

    def save_run_state(self, run_id: str, state: dict) -> None:
        p = self._run_path(run_id)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2, ensure_ascii=True)

    def load_run_state(self, run_id: str) -> Optional[dict]:
        p = self._run_path(run_id)
        if not os.path.exists(p):
            return None
        with open(p, "r", encoding="utf-8") as f:
            loaded = json.load(f)
        return loaded if isinstance(loaded, dict) else None

    def delete_run_state(self, run_id: str) -> None:
        for p in (self._run_path(run_id), self._data_path(run_id)):
            try:
                os.remove(p)
            except FileNotFoundError:
                pass

    def _load_data(self, run_id: str) -> dict[str, Any]:
        p = self._data_path(run_id)
        if not os.path.exists(p):
            return {}
        try:
            with open(p, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                return loaded
        except Exception:
            return {}
        return {}

    def _save_data(self, run_id: str, data: dict[str, Any]) -> None:
        p = self._data_path(run_id)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=True)

    def set_data(self, run_id: str, key: str, value: Any) -> None:
        data = self._load_data(run_id)
        data[key] = value
        self._save_data(run_id, data)

    def get_data(self, run_id: str, key: str) -> Any:
        return self._load_data(run_id).get(key)

    def get_all_data(self, run_id: str) -> dict[str, Any]:
        return dict(self._load_data(run_id))

    def clear_data(self, run_id: str) -> None:
        try:
            os.remove(self._data_path(run_id))
        except FileNotFoundError:
            pass

    def list_runs(self) -> list:
        p = Path(self._dir)
        if not p.exists():
            return []
        return [f.stem.replace(".run", "") for f in p.glob("*.run.json")]


def invoke_step_machine_native(*, payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Run a flow declared in `payload['flow']` using the declarative
    handler factory + local-process invoke_ref_sync adapter.

    Payload keys:
      mode         : 'run' | 'resume'              (default 'run')
      flow         : StepFlowConfig dict           (required)
      flowDir      : str — flow's directory        (default '.')
      store        : { type: 'memory' | 'file', directory? }
      runId        : str — required for 'resume'
      initialData  : dict
      pauseFilePath: str — optional, file-store mode
    """
    mode = payload.get("mode", "run")
    flow = payload.get("flow", {})
    flow_dir = payload.get("flowDir", ".")
    store_spec = payload.get("store", {"type": "memory"})
    run_id = payload.get("runId")
    initial_data = payload.get("initialData")

    errors = validate_step_flow_config(flow)
    if errors:
        return {"status": "failed", "error": f"Invalid flow: {'; '.join(errors)}"}

    if store_spec.get("type") == "file":
        store = _FileStore(store_spec["directory"])
    else:
        store = MemoryStore()

    def invoke(ref: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        return invoke_ref_sync(ref, args, {"cliDir": flow_dir, "cwd": flow_dir})

    handlers = build_step_handlers_for_flow(flow, invoke)

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
