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
    """File-based store matching the QuickJS HostFileStore pattern."""

    def __init__(self, directory: str):
        self._dir = directory
        os.makedirs(directory, exist_ok=True)

    def get(self, run_id: str) -> Optional[dict]:
        p = os.path.join(self._dir, f"{run_id}.json")
        if not os.path.exists(p):
            return None
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)

    def put(self, run_id: str, state: dict) -> None:
        p = os.path.join(self._dir, f"{run_id}.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=2)

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
