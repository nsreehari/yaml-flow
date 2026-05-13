#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import os
import sys
import time
import urllib.error
import urllib.request
from typing import Any, Dict, Optional, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYCLI_ROOT = os.path.normpath(os.path.join(_HERE, "..", "..", "..", "..", "core"))
if _PYCLI_ROOT not in sys.path:
    sys.path.insert(0, _PYCLI_ROOT)
_PYCLI_SUB = os.path.join(_PYCLI_ROOT, "sub")

from pylib.cli.storage_interface import parse_ref
from pylib.cli.execution_adapter import invoke_ref_sync
from pylib.step_machine.loader import load_step_flow


def _board_worker_adapter():
    """Lazy-load board_worker_adapter (sub/ in source, adapters/ in standalone)."""
    mod_name = "_demo_bwa"
    if mod_name in sys.modules:
        return sys.modules[mod_name]
    spec = importlib.util.spec_from_file_location(
        mod_name, os.path.join(_PYCLI_SUB, "board_worker_adapter.py")
    )
    mod = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
    sys.modules[mod_name] = mod  # register before exec so @dataclass can resolve __module__
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod

COPILOT_PROMPT_CONTEXT: Dict[str, Any] = {
    "view_kind_guidance": "\n".join([
        "VIEW KIND GUIDANCE (for dynamic ref rendering):",
        "- Return a _view object whenever your output data is meant for a ref element.",
        "- Allowed _view.kind values only: table, editable-table, chart, metric, list, badge, text, narrative, markdown, form, filter, todo, alert.",
        '- If uncertain, use "table".',
        '- For array rows that users should edit, prefer "editable-table" and set _view.data.writeTo to a card_data path.',
        "- For chart, set _view.data.chartType and _view.data.columns with [labelField, valueField].",
        "- Keep _view.data minimal and valid JSON (no comments, no trailing text).",
    ]),
    "card_layout_guidance": "\n".join([
        "CARD LAYOUT GUIDANCE:",
        "- Prefer compact outputs that fit a card: one primary structure plus concise rationale text.",
        "- Avoid repeating values already present in upstream inputs.",
        "- If you produce both machine-readable and human-readable content, keep machine-readable fields top-level and concise prose in a separate field.",
    ]),
}

MOCK_DB: Dict[str, Any] = {
    "quotes": {
        "quoteResponse": {
            "result": [
                {"symbol": "AAPL", "shortName": "Apple Inc.", "regularMarketPrice": 198.15, "regularMarketChange": 2.15, "regularMarketChangePercent": 1.10},
                {"symbol": "MSFT", "shortName": "Microsoft Corp.", "regularMarketPrice": 415.32, "regularMarketChange": -1.23, "regularMarketChangePercent": -0.30},
                {"symbol": "GOOGL", "shortName": "Alphabet Inc.", "regularMarketPrice": 174.89, "regularMarketChange": 0.89, "regularMarketChangePercent": 0.51},
                {"symbol": "TSLA", "shortName": "Tesla Inc.", "regularMarketPrice": 247.12, "regularMarketChange": 5.43, "regularMarketChangePercent": 2.25},
            ],
            "error": None,
        },
    },
}

def _read_json_file_psa(psa: Any, ref: str) -> Dict[str, Any]:
    parsed_ref = psa.parse_ref(ref)
    storage = psa.blob_storage_for_ref(parsed_ref)
    raw = storage.read(parsed_ref.value)
    if not raw:
        raise ValueError(f"Input envelope not found at: {ref}")
    data = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("Input JSON root must be an object")
    return data


def _write_json_file_psa(psa: Any, ref: str, payload: Any) -> None:
    parsed_ref = psa.parse_ref(ref)
    storage = psa.blob_storage_for_ref(parsed_ref)
    storage.write(parsed_ref.value, json.dumps(payload, indent=2, ensure_ascii=True))


def _write_err_psa(psa: Any, err_ref: Optional[str], msg: str) -> None:
    if not err_ref:
        return
    try:
        parsed_ref = psa.parse_ref(err_ref)
        storage = psa.blob_storage_for_ref(parsed_ref)
        storage.write(parsed_ref.value, msg)
    except Exception:
        pass


def _interpolate(template: str, args: Dict[str, Any]) -> str:
    out = template
    for key, value in args.items():
        needle = "{{" + str(key) + "}}"
        if needle in out:
            out = out.replace(needle, value if isinstance(value, str) else json.dumps(value, ensure_ascii=True))
    return out


def _load_registry() -> Dict[str, Any]:
    """Load source_def_flows.json registry."""
    registry_path = os.path.join(_HERE, "source_def_flows.json")
    with open(registry_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _matches_detect_rule(source_def: Dict[str, Any], detect: Any) -> bool:
    """Check if a source def matches a kind's detect rule."""
    if not detect or not isinstance(detect, dict):
        return False
    if isinstance(detect.get("field"), str):
        return detect["field"] in source_def
    any_of = detect.get("anyOfFields")
    if isinstance(any_of, list):
        return any(f in source_def for f in any_of)
    return False


def _resolve_source_kind(source_def: Dict[str, Any], registry: Optional[Dict[str, Any]] = None) -> str:
    """Registry-driven kind detection — mirrors resolveSourceKind in JS."""
    if registry is None:
        registry = _load_registry()
    kinds = registry.get("kinds") or {}
    order = registry.get("resolveOrder") or list(kinds.keys())
    matched = []
    for kind in order:
        spec = kinds.get(kind)
        if not spec:
            continue
        if _matches_detect_rule(source_def, spec.get("detect")):
            matched.append(kind)
    if len(matched) == 0:
        known = list(kinds.keys())
        raise ValueError(f"No recognised source kind. Known kinds: {', '.join(known)}")
    if len(matched) > 1:
        raise ValueError(f"Multiple source kinds specified: [{', '.join(matched)}]. Use exactly one.")
    return matched[0]


def _execute_via_step_machine_flow(
    kind: str,
    registry: Dict[str, Any],
    source_def: Dict[str, Any],
    out_ref: Optional[str],
    extra: Optional[Dict[str, Any]],
) -> Tuple[Any, bool]:
    """Run source def through the Python step machine using flow files + Python handler modules.

    Mirrors executeStepMachineSourceFlow in demo-task-executor.js.
    Supports howToRun='demo-local-module' by dynamically importing .py handler files.
    """
    from pylib.step_machine.step_machine import StepMachine
    from pylib.step_machine_public import build_step_handlers_for_flow
    from pylib.stores.memory import MemoryStore

    spec = (registry.get("kinds") or {}).get(kind)
    if not spec:
        raise ValueError(f"Missing flow registration for kind: {kind}")

    flow_ref = spec.get("flow")
    if not isinstance(flow_ref, str) or not flow_ref:
        raise ValueError(f"Invalid or missing flow for kind: {kind}")

    flow_path = os.path.normpath(os.path.join(_HERE, flow_ref))
    flow = load_step_flow(flow_path)

    def invoke(ref: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        how = ref.get("howToRun", "")
        what = ref.get("whatToRun", "")

        if how in ("http:post", "http:get"):
            raw_url = what.get("value") if isinstance(what, dict) else parse_ref(what).get("value", what)
            server_url = str((args.get("extra") or {}).get("serverUrl") or "http://127.0.0.1:7799").rstrip("/")
            if not (raw_url.startswith("http://") or raw_url.startswith("https://")):
                resolved_url = server_url + ("" if raw_url.startswith("/") else "/") + raw_url
            else:
                resolved_url = raw_url
            body: Any = args
            workiq_cfg = (args.get("sourceDef") or {}).get("workiq")
            timeout_sec = 90
            if isinstance(workiq_cfg, dict) and isinstance(workiq_cfg.get("query_template"), str):
                interp_ctx = {
                    **((args.get("sourceDef") or {}).get("_projections") or {}),
                    **(workiq_cfg.get("args") or {}),
                }
                body = {"query": _interpolate(workiq_cfg["query_template"], interp_ctx)}
            if how == "http:get":
                req = urllib.request.Request(url=resolved_url, method="GET")
            else:
                req = urllib.request.Request(
                    url=resolved_url,
                    data=json.dumps(body, ensure_ascii=True).encode("utf-8"),
                    method="POST",
                    headers={"Content-Type": "application/json"},
                )
            try:
                with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
                    text = resp.read().decode("utf-8")
            except urllib.error.HTTPError as exc:
                err_text = ""
                try:
                    err_text = exc.read().decode("utf-8")
                except Exception:
                    err_text = ""
                err_msg = f"HTTP {exc.code} calling {resolved_url}"
                if err_text:
                    try:
                        err_json = json.loads(err_text)
                        if isinstance(err_json, dict) and isinstance(err_json.get("error"), str):
                            err_msg = f"{err_msg}: {err_json['error']}"
                        else:
                            err_msg = f"{err_msg}: {err_text}"
                    except Exception:
                        err_msg = f"{err_msg}: {err_text}"
                return {"result": "failure", "data": {"error": err_msg}, "error": err_msg}
            except Exception as exc:
                err_msg = str(exc)
                return {"result": "failure", "data": {"error": err_msg}, "error": err_msg}
            try:
                parsed = json.loads(text) if text else {}
            except Exception:
                parsed = {"response": text}
            if isinstance(parsed.get("error"), str):
                err_msg = parsed["error"]
                return {"result": "failure", "data": {"error": err_msg}, "error": err_msg}
            result_value = parsed.get("response") if "response" in parsed else parsed
            return {"result": "success", "data": {"resultValue": result_value}}

        if how == "demo-local-module":
            # whatToRun must be a b64 wire string or { kind, value } object
            if isinstance(what, dict):
                what_value = str(what.get("value") or "")
            else:
                try:
                    parsed_what = parse_ref(what)
                    what_value = str(parsed_what.get("value") or "")
                except Exception:
                    what_value = str(what)
            # For Python standalone, fall back from .js to .py automatically
            py_what = what_value[:-3] + ".py" if what_value.endswith(".js") else what_value
            module_path = os.path.normpath(os.path.join(_HERE, py_what))
            if not os.path.isfile(module_path):
                raise FileNotFoundError(f"Handler module not found: {py_what}")
            mod_spec = importlib.util.spec_from_file_location("_handler_mod", module_path)
            mod = importlib.util.module_from_spec(mod_spec)  # type: ignore[arg-type]
            mod_spec.loader.exec_module(mod)  # type: ignore[union-attr]
            if not callable(getattr(mod, "execute", None)):
                raise ValueError(f"Handler module {py_what} must define execute(context)")
            return mod.execute(args)

        # JS parity: delegate all other transports to invokeRefSync.
        return invoke_ref_sync(ref, args, {"cliDir": _HERE, "cwd": os.getcwd()})

    handlers = build_step_handlers_for_flow(flow, invoke)
    machine = StepMachine(flow, handlers, options={"store": MemoryStore()})

    run = machine.run({
        "kind": kind,
        "sourceDef": source_def,
        "extra": extra or {},
        "executorDir": _HERE,
        "outRef": out_ref,
        "promptContext": COPILOT_PROMPT_CONTEXT,
        "mockDb": MOCK_DB,
    })

    if run.get("status") != "completed":
        reason = str(run.get("error") or run.get("intent") or run.get("status"))
        raise RuntimeError(f"flow execution failed: {reason}")

    if run.get("intent") != "success":
        data = run.get("data") or {}
        error_msg = data.get("error") or f"flow returned intent: {run.get('intent')}"
        raise RuntimeError(str(error_msg))

    data = run.get("data") or {}
    return data.get("resultValue"), bool(data.get("wroteOutputDirectly"))


def _run_source_fetch(
    in_ref: str,
    out_ref: str,
    err_ref: Optional[str],
    extra: Optional[Dict[str, Any]] = None,
) -> int:
    psa = _board_worker_adapter()

    # Read envelope via PSA storage and enforce envelope protocol.
    try:
        envelope = _read_json_file_psa(psa, in_ref)
    except Exception as err:
        _write_err_psa(psa, err_ref, str(err))
        print(f"[demo-task-executor.py] Cannot read input: {err}", file=sys.stderr)
        return 1

    # JS parity: accept both new envelope protocol and legacy raw source-def input.
    callback = envelope.get("callback") if isinstance(envelope.get("source_def"), dict) else None
    source_def = envelope.get("source_def") if isinstance(envelope.get("source_def"), dict) else envelope
    if not isinstance(source_def, dict):
        msg = "Input must be a source definition object or an envelope with object field 'source_def'"
        _write_err_psa(psa, err_ref, msg)
        print(f"[demo-task-executor.py] {msg}", file=sys.stderr)
        return 1

    def _write_out(payload: Any) -> None:
        _write_json_file_psa(psa, out_ref, payload)

    def _write_fail(msg: str) -> None:
        _write_err_psa(psa, err_ref, msg)

    def _fail_ref(msg: str) -> int:
        _write_fail(msg)
        print(f"[demo-task-executor.py] {msg}", file=sys.stderr)
        if callback:
            try:
                psa.report_failed(callback, msg)
            except Exception:
                pass
        return 1

    registry = _load_registry()
    try:
        kind = _resolve_source_kind(source_def, registry)
    except ValueError as err:
        return _fail_ref(str(err))

    try:
        result_value, wrote_directly = _execute_via_step_machine_flow(kind, registry, source_def, out_ref, extra)
        if not wrote_directly:
            _write_out(result_value)
    except Exception as err:
        return _fail_ref(str(err))

    if callback:
        try:
            out_ref_parsed = psa.parse_ref(out_ref)
            psa.report_complete(callback, out_ref_parsed)
        except Exception as err:
            print(f"[demo-task-executor.py] reportComplete failed: {err}", file=sys.stderr)
            return 1

    return 0


def _describe_capabilities() -> int:
    registry = _load_registry()
    source_kinds = {}
    for kind, spec in (registry.get("kinds") or {}).items():
        manifest = spec.get("manifest") or {}
        source_kinds[kind] = manifest
    payload = {
        "version": registry.get("version", "1.0"),
        "executor": registry.get("executor", "demo-task-executor.py"),
        "subcommands": registry.get("subcommands", []),
        "sourceKinds": source_kinds,
        "extraSchema": registry.get("extraSchema", {}),
    }
    print(json.dumps(payload, indent=2, ensure_ascii=True))
    return 0


def _validate_source_def_from_stdin() -> int:
    """Structural validation of a source definition — data-driven from registry."""
    raw = sys.stdin.read().strip() if not sys.stdin.isatty() else ""
    if not raw:
        print(json.dumps({"ok": False, "errors": ["No input provided on stdin"]}))
        return 1

    try:
        source_def = json.loads(raw)
    except Exception as exc:
        print(json.dumps({"ok": False, "errors": [f"Cannot parse input: {exc}"]}))
        return 1

    if not isinstance(source_def, dict):
        print(json.dumps({"ok": False, "errors": ["Input must be a JSON object"]}))
        return 1

    errors: list[str] = []
    registry = _load_registry()

    kind = ""
    try:
        kind = _resolve_source_kind(source_def, registry)
    except ValueError as exc:
        errors.append(str(exc))

    # Data-driven validation: rules come from source_def_flows.json "validate" array
    if kind:
        spec = (registry.get("kinds") or {}).get(kind) or {}
        rules = spec.get("validate") or []
        for rule in rules:
            if rule.get("condition") == "copilot-or-prompt":
                has_copilot_obj = isinstance(source_def.get("copilot"), dict)
                has_top_level_template = isinstance(source_def.get("prompt_template"), str)
                has_nested_template = has_copilot_obj and isinstance(source_def["copilot"].get("prompt_template"), str)
                if not has_copilot_obj and not has_top_level_template:
                    errors.append(rule.get("message", ""))
                elif has_copilot_obj and not has_nested_template and not has_top_level_template:
                    errors.append("copilot.prompt_template is required (or use top-level prompt_template).")
            elif rule.get("field"):
                # Dot-path field check: e.g. "url.url" → source_def["url"]["url"]
                parts = rule["field"].split(".")
                val: Any = source_def
                for p in parts:
                    val = val.get(p) if isinstance(val, dict) else None
                expected_type = rule.get("type", "string")
                type_map = {"string": str, "object": dict, "number": (int, float), "boolean": bool}
                expected = type_map.get(expected_type, str)
                if val is None or not isinstance(val, expected):
                    errors.append(rule.get("message", ""))

    result = {"ok": len(errors) == 0, "errors": errors}
    print(json.dumps(result, ensure_ascii=True))
    return 0 if not errors else 1


def _validate_card_preflight_from_stdin() -> int:
    """Validate a card JSON object passed via stdin.

    Returns JSON: { ok: boolean, errors: string[] }
    Mirrors the executor-side hook called by board-live-cards-public
    validateCardPreflight.
    """
    raw = sys.stdin.read().strip() if not sys.stdin.isatty() else ""
    if not raw:
        print(json.dumps({"ok": True, "errors": []}))
        return 0

    try:
        card = json.loads(raw)
    except Exception as exc:
        print(json.dumps({"ok": False, "errors": [f"Cannot parse card JSON: {exc}"]}))
        return 1

    if not isinstance(card, dict):
        print(json.dumps({"ok": False, "errors": ["Card must be a JSON object"]}))
        return 1

    errors: list[str] = []

    # Validate source_defs structurally (each must be a recognised kind).
    source_defs = card.get("source_defs")
    if isinstance(source_defs, list):
        for idx, sd in enumerate(source_defs):
            if not isinstance(sd, dict):
                errors.append(f"source_defs[{idx}]: must be an object")
                continue
            bind_to = sd.get("bindTo", "(unknown)")
            try:
                _resolve_source_kind(sd)
            except ValueError as exc:
                errors.append(f'source "{bind_to}": {exc}')

    result = {"ok": len(errors) == 0, "errors": errors}
    print(json.dumps(result, ensure_ascii=True))
    return 0 if not errors else 1


def _resolve_dot_path(obj: Any, path_str: str) -> Any:
    """Resolve a dot-path like 'url.url' or '_projections.url_list[0]' from an object."""
    if not path_str:
        return None
    parts = path_str.replace("[", ".[").split(".")
    val = obj
    for part in parts:
        if val is None:
            return None
        if part.startswith("[") and part.endswith("]"):
            idx_str = part[1:-1]
            if isinstance(val, list):
                try:
                    val = val[int(idx_str)]
                except (IndexError, ValueError):
                    return None
            else:
                return None
        elif isinstance(val, dict):
            val = val.get(part)
        else:
            return None
    return val


def _probe_source_preflight_from_stdin(extra: Optional[Dict[str, Any]] = None) -> int:
    """Preflight probe using the same flow execution path as run-source-fetch.

    Input (stdin JSON): source def object with optional _projections.
    Output: { ok, reachable, latencyMs, error? }
    Always exits 0 (matches JS demo-task-executor behavior).
    """
    raw = sys.stdin.read().strip() if not sys.stdin.isatty() else ""
    started_at_ms = int(time.time() * 1000)
    if not raw:
        print(json.dumps({
            "ok": False,
            "reachable": False,
            "latencyMs": int(time.time() * 1000) - started_at_ms,
            "error": "Missing probe input JSON on stdin",
        }, ensure_ascii=True))
        return 0

    try:
        source_def = json.loads(raw)
    except Exception as exc:
        print(json.dumps({
            "ok": False,
            "reachable": False,
            "latencyMs": int(time.time() * 1000) - started_at_ms,
            "error": f"Invalid probe JSON: {exc}",
        }, ensure_ascii=True))
        return 0

    if not isinstance(source_def, dict):
        print(json.dumps({
            "ok": False,
            "reachable": False,
            "latencyMs": int(time.time() * 1000) - started_at_ms,
            "error": "Invalid probe JSON: input must be a JSON object",
        }, ensure_ascii=True))
        return 0

    try:
        registry = _load_registry()
        kind = _resolve_source_kind(source_def, registry)
        _execute_via_step_machine_flow(kind, registry, source_def, None, extra)
        print(json.dumps({
            "ok": True,
            "reachable": True,
            "latencyMs": int(time.time() * 1000) - started_at_ms,
        }, ensure_ascii=True))
        return 0
    except Exception as exc:
        detail = ""
        stderr_val = getattr(exc, "stderr", None)
        stdout_val = getattr(exc, "stdout", None)
        if stderr_val or stdout_val:
            detail = f"\n{str(stderr_val or stdout_val).rstrip()}"
        print(json.dumps({
            "ok": False,
            "reachable": False,
            "latencyMs": int(time.time() * 1000) - started_at_ms,
            "error": f"source invocation failed: {str(exc)}{detail}",
        }, ensure_ascii=True))
        return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Python demo task executor")
    parser.add_argument(
        "subcommand",
        choices=[
            "run-source-fetch",
            "describe-capabilities",
            "validate-source-def",
            "validate-card-preflight",
            "probe-source-preflight",
        ],
    )
    parser.add_argument("--in-ref", dest="in_ref")
    parser.add_argument("--out-ref", dest="out_ref")
    parser.add_argument("--err-ref", dest="err_ref")
    parser.add_argument("--extra", dest="extra", required=False)
    args = parser.parse_args()

    if args.subcommand == "describe-capabilities":
        return _describe_capabilities()
    if args.subcommand == "validate-source-def":
        return _validate_source_def_from_stdin()
    if args.subcommand == "validate-card-preflight":
        return _validate_card_preflight_from_stdin()
    if args.subcommand == "probe-source-preflight":
        extra: Optional[Dict[str, Any]] = None
        if args.extra:
            try:
                extra = json.loads(base64.b64decode(args.extra).decode("utf-8"))
            except Exception:
                extra = None
        return _probe_source_preflight_from_stdin(extra)
    if not args.in_ref or not args.out_ref:
        print("run-source-fetch requires --in-ref and --out-ref", file=sys.stderr)
        return 2
    extra: Optional[Dict[str, Any]] = None
    if args.extra:
        try:
            extra = json.loads(base64.b64decode(args.extra).decode("utf-8"))
        except Exception:
            pass
    return _run_source_fetch(args.in_ref, args.out_ref, args.err_ref, extra)


if __name__ == "__main__":
    raise SystemExit(main())
