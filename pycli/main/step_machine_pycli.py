#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, Optional

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYCLI_ROOT = os.path.normpath(os.path.join(_HERE, ".."))
if _PYCLI_ROOT not in sys.path:
    sys.path.insert(0, _PYCLI_ROOT)

from sub.step_machine_quickjs_bridge import QuickJsUnavailableError, invoke_step_machine_bundle

DEFAULT_QUICKJS_BUNDLE = "dist/pycli/quickjs-step-machine-runtime.global.js"
PAUSE_FILE_NAME = ".pause"


def _print_json(value: Any) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=True))


def _resolve_bundle_path(bundle_arg: str | None) -> str:
    bundle = bundle_arg or DEFAULT_QUICKJS_BUNDLE
    if os.path.exists(bundle):
        return bundle
    here = os.path.dirname(os.path.abspath(__file__))
    alt = os.path.normpath(os.path.join(here, "..", "..", bundle))
    return alt


def _resolve_input_path(input_path: str) -> str:
    p = Path(input_path)
    return str(p if p.is_absolute() else Path.cwd() / p)


def _load_flow(flow_path: str) -> Dict[str, Any]:
    path = Path(flow_path)
    if not path.exists():
        raise FileNotFoundError(f"[step-machine-pycli] Flow file not found: {flow_path}")
    text = path.read_text(encoding="utf-8")
    if flow_path.endswith(".json"):
        value = json.loads(text)
    else:
        try:
            import yaml  # type: ignore
        except Exception as ex:
            raise RuntimeError(
                "[step-machine-pycli] YAML support requires pyyaml. Run: python -m pip install -r pycli/requirements.txt"
            ) from ex
        value = yaml.safe_load(text)

    if not isinstance(value, dict):
        raise ValueError(f"[step-machine-pycli] Flow root must be an object: {flow_path}")
    return value


def _load_inline_handlers(module_path: str | None) -> Dict[str, Callable[..., Any]]:
    if not module_path:
        return {}

    resolved = _resolve_input_path(module_path)
    spec = importlib.util.spec_from_file_location("step_machine_pycli_handlers", resolved)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"[step-machine-pycli] Failed to load handlers module: {resolved}")

    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    candidate = getattr(module, "handlers", None)
    if candidate is None:
        candidate = getattr(module, "__dict__", {})

    if not isinstance(candidate, dict):
        raise RuntimeError("[step-machine-pycli] Handlers module must provide a dict map (e.g. `handlers = {...}`)")

    handlers: Dict[str, Callable[..., Any]] = {}
    for name, fn in candidate.items():
        if not isinstance(name, str):
            continue
        if not callable(fn):
            continue
        handlers[name] = fn

    return handlers


def _parse_initial_data(data_arg: str | None) -> Optional[Dict[str, Any]]:
    if not data_arg:
        return None
    parsed = json.loads(data_arg)
    if not isinstance(parsed, dict):
        raise ValueError("[step-machine-pycli] --initial-data must be a JSON object")
    return parsed


def _create_store_context(store_type: str, store_dir_arg: str | None) -> Dict[str, Any]:
    st = store_type.lower()
    if st not in {"memory", "file"}:
        raise ValueError(f"[step-machine-pycli] Invalid --store value \"{store_type}\". Expected \"memory\" or \"file\".")

    if st == "memory":
        return {
            "storeType": "memory",
            "store": {"type": "memory"},
            "storeDir": None,
            "pauseFilePath": None,
        }

    if not store_dir_arg or not store_dir_arg.strip():
        raise ValueError("[step-machine-pycli] --store file requires --store-dir <directory>.")

    store_dir = _resolve_input_path(store_dir_arg)
    return {
        "storeType": "file",
        "store": {"type": "file", "directory": store_dir},
        "storeDir": store_dir,
        "pauseFilePath": str(Path(store_dir) / PAUSE_FILE_NAME),
    }


def _list_run_states(store_dir: str) -> list[Dict[str, Any]]:
    p = Path(store_dir)
    if not p.exists():
        return []
    states: list[Dict[str, Any]] = []
    for run_file in p.glob("*.run.json"):
        try:
            value = json.loads(run_file.read_text(encoding="utf-8"))
            if isinstance(value, dict):
                states.append(value)
        except Exception:
            continue

    def _sort_key(state: Dict[str, Any]) -> int:
        updated = state.get("updatedAt")
        started = state.get("startedAt")
        if isinstance(updated, int):
            return updated
        if isinstance(started, int):
            return started
        return 0

    states.sort(key=_sort_key, reverse=True)
    return states


def _resolve_run_id_to_resume(store_context: Dict[str, Any]) -> Optional[str]:
    if store_context.get("storeType") != "file":
        return None
    store_dir = store_context.get("storeDir")
    if not isinstance(store_dir, str):
        return None
    states = _list_run_states(store_dir)
    paused = [s for s in states if s.get("status") == "paused"]
    if not paused:
        return None
    return paused[0].get("runId") if isinstance(paused[0].get("runId"), str) else None


def _request_pause(store_context: Dict[str, Any]) -> Dict[str, Any]:
    if store_context.get("storeType") != "file":
        raise ValueError("[step-machine-pycli] --pause requires --store file --store-dir <directory>.")

    store_dir = store_context.get("storeDir")
    if not isinstance(store_dir, str):
        raise ValueError("[step-machine-pycli] Missing store directory.")

    states = _list_run_states(store_dir)
    if len(states) == 0:
        return {"status": "noop", "reason": "no-runs"}

    running = next((s for s in states if s.get("status") == "running"), None)
    if running is None:
        return {"status": "noop", "reason": "no-running-run"}

    pause_file = Path(store_context["pauseFilePath"])
    pause_file.parent.mkdir(parents=True, exist_ok=True)
    pause_file.write_text(json.dumps({"requestedAt": int(time.time() * 1000)}, ensure_ascii=True), encoding="utf-8")
    return {"status": "pause-requested", "storeDir": store_dir}


def _print_store_status(store_context: Dict[str, Any]) -> Dict[str, Any]:
    if store_context.get("storeType") != "file":
        raise ValueError("[step-machine-pycli] --status requires --store file --store-dir <directory>.")

    store_dir = store_context.get("storeDir")
    if not isinstance(store_dir, str):
        raise ValueError("[step-machine-pycli] Missing store directory.")

    pause_file = store_context.get("pauseFilePath")
    pause_requested = isinstance(pause_file, str) and Path(pause_file).exists()
    states = _list_run_states(store_dir)
    return {
        "store": "file",
        "storeDir": store_dir,
        "pauseRequested": pause_requested,
        "totalRuns": len(states),
        "runs": [
            {
                "runId": s.get("runId"),
                "status": s.get("status"),
                "currentStep": s.get("currentStep"),
                "startedAt": s.get("startedAt"),
                "updatedAt": s.get("updatedAt"),
                "pausedAt": s.get("pausedAt"),
            }
            for s in states
        ],
    }


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="step-machine-pycli",
        description="Python host + QuickJS runtime for step-machine CLI flows.",
    )
    parser.add_argument("flow", nargs="?", help="Path to step flow file (.yaml/.json)")
    parser.add_argument("--handlers", help="Python handlers module path (supports inline handler names)")
    parser.add_argument("--initial-data", help="Initial data JSON object string")
    parser.add_argument("--store", default="memory", choices=["memory", "file"], help="Store backend")
    parser.add_argument("--store-dir", help="Directory for file store")
    parser.add_argument("--resume", action="store_true", help="Resume most recent paused run")
    parser.add_argument("--pause", action="store_true", help="Request pause for active file-store run")
    parser.add_argument("--status", action="store_true", help="Show file-store run status")
    parser.add_argument("--bundle", help="QuickJS bundle path")
    return parser


def main() -> int:
    parser = _build_parser()
    args = parser.parse_args()

    if (args.pause or args.status) and (args.handlers or args.initial_data or args.resume or args.flow):
        raise ValueError("[step-machine-pycli] --pause and --status are store-level operations. Do not provide flow, handlers, data, or --resume.")

    if args.resume and args.initial_data:
        raise ValueError("[step-machine-pycli] --initial-data cannot be combined with --resume.")

    if sum(1 for f in (args.resume, args.pause, args.status) if f) > 1:
        raise ValueError("[step-machine-pycli] Use only one of --resume, --pause, or --status at a time.")

    store_context = _create_store_context(args.store, args.store_dir)

    if args.status:
        _print_json(_print_store_status(store_context))
        return 0

    if args.pause:
        _print_json(_request_pause(store_context))
        return 0

    if not args.flow:
        parser.print_help(sys.stderr)
        return 1

    flow_path = _resolve_input_path(args.flow)
    flow = _load_flow(flow_path)
    flow_dir = str(Path(flow_path).parent)
    initial_data = _parse_initial_data(args.initial_data)
    inline_handlers = _load_inline_handlers(args.handlers)

    run_id_to_resume: Optional[str] = None
    if args.resume:
        run_id_to_resume = _resolve_run_id_to_resume(store_context)
        if not run_id_to_resume:
            _print_json({"status": "noop", "reason": "no-paused-run"})
            return 0
    elif store_context["storeType"] == "file" and initial_data is None:
        run_id_to_resume = _resolve_run_id_to_resume(store_context)

    payload: Dict[str, Any] = {
        "mode": "resume" if run_id_to_resume else "run",
        "flow": flow,
        "flowDir": flow_dir,
        "store": store_context["store"],
        "inlineHandlerNames": sorted(inline_handlers.keys()),
        "handlerVars": flow.get("handler_vars", {}),
    }
    if run_id_to_resume:
        payload["runId"] = run_id_to_resume
    if initial_data is not None:
        payload["initialData"] = initial_data
    if store_context.get("pauseFilePath"):
        payload["pauseFilePath"] = store_context["pauseFilePath"]

    try:
        result_raw = invoke_step_machine_bundle(
            bundle_path=_resolve_bundle_path(args.bundle),
            function_name="pycliStepMachineInvoke",
            function_arg=payload,
            inline_handlers=inline_handlers,
        )
    except QuickJsUnavailableError as e:
        _print_json({"status": "error", "error": str(e)})
        return 2

    result: Any = result_raw
    if isinstance(result_raw, str):
        try:
            result = json.loads(result_raw)
        except Exception:
            _print_json({"status": "error", "error": str(result_raw)})
            return 2

    if not isinstance(result, dict):
        _print_json({"status": "error", "error": "Unexpected non-object result from QuickJS runtime"})
        return 2

    _print_json(result)

    status = result.get("status")
    if status in {"completed", "paused", "noop"}:
        return 0
    return 2


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as e:
        print(f"[step-machine-pycli] {e}", file=sys.stderr)
        raise SystemExit(1)
