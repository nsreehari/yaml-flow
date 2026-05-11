#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request
from typing import Any, Dict, Optional, Tuple

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYCLI_ROOT = os.path.normpath(os.path.join(_HERE, "..", "..", "pycli"))
if _PYCLI_ROOT not in sys.path:
    sys.path.insert(0, _PYCLI_ROOT)

from pylib.cli.storage_interface import parse_ref

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

CACHE_DIR = os.path.join(tempfile.gettempdir(), "demo-executor-cache")
DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000


def _resolve_ref_to_path(ref: str) -> str:
    if ref.startswith("b64:"):
        parsed = parse_ref(ref)
        if parsed.get("kind") != "fs-path":
            raise ValueError(f"Unsupported ref kind for file IO: {parsed.get('kind')}")
        return str(parsed.get("value") or "")
    return ref


def _read_json_file(ref: str) -> Dict[str, Any]:
    path = _resolve_ref_to_path(ref)
    with open(path, "r", encoding="utf-8") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("Input JSON root must be an object")
    return data


def _write_json_file(ref: str, payload: Any) -> None:
    path = _resolve_ref_to_path(ref)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=True)


def _write_err(err_ref: Optional[str], msg: str) -> None:
    if not err_ref:
        return
    try:
        path = _resolve_ref_to_path(err_ref)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(msg)
    except Exception:
        pass


def _interpolate(template: str, args: Dict[str, Any]) -> str:
    out = template
    for key, value in args.items():
        needle = "{{" + str(key) + "}}"
        if needle in out:
            out = out.replace(needle, value if isinstance(value, str) else json.dumps(value, ensure_ascii=True))
    return out


def _detect_kind(source_def: Dict[str, Any]) -> str:
    if "url" in source_def:
        return "url"
    if "url-list" in source_def:
        return "url-list"
    if "copilot" in source_def or "prompt_template" in source_def:
        return "copilot"
    if "workiq" in source_def:
        return "workiq"
    if "mock" in source_def:
        return "mock"
    raise ValueError("No recognised source kind")


def _cache_key(seed: str) -> str:
    return hashlib.sha1(seed.encode("utf-8")).hexdigest()


def _read_cache(key: str, ttl_ms: int) -> Any:
    path = os.path.join(CACHE_DIR, f"{key}.json")
    try:
        st = os.stat(path)
        age_ms = int(time.time() * 1000) - int(st.st_mtime * 1000)
        if age_ms > ttl_ms:
            return None
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _write_cache(key: str, value: Any) -> None:
    os.makedirs(CACHE_DIR, exist_ok=True)
    with open(os.path.join(CACHE_DIR, f"{key}.json"), "w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=True)


def _fetch_json(url: str, method: str, headers: Dict[str, str]) -> Any:
    req = urllib.request.Request(url=url, method=method.upper())
    for k, v in headers.items():
        req.add_header(str(k), str(v))
    with urllib.request.urlopen(req, timeout=10) as resp:
        raw = resp.read().decode("utf-8")
    return json.loads(raw)


def _resolve_tickers_arg(source_def: Dict[str, Any], fetch_args: Dict[str, Any]) -> None:
    tickers_from = source_def.get("tickersFrom")
    if not isinstance(tickers_from, str) or "." not in tickers_from:
        return
    ref_key, field_name = tickers_from.split(".", 1)
    arr = (source_def.get("_projections") or {}).get(ref_key)
    if not isinstance(arr, list):
        return
    vals = [row.get(field_name) for row in arr if isinstance(row, dict) and row.get(field_name)]
    if vals:
        fetch_args["tickers"] = ",".join(str(v) for v in vals)


def _execute_url(source_def: Dict[str, Any]) -> Any:
    cfg = source_def.get("url")
    if not isinstance(cfg, dict):
        raise ValueError("url source requires object config")
    method = str(cfg.get("method") or "GET").upper()
    headers = dict(cfg.get("headers") or {})
    cache_timeout = cfg.get("cacheTimeout")
    ttl_ms = int(cache_timeout * 1000) if isinstance(cache_timeout, (int, float)) else DEFAULT_CACHE_TTL_MS
    fetch_args = dict(cfg.get("args") or {})

    _resolve_tickers_arg(source_def, fetch_args)
    context = {}
    context.update(source_def.get("_projections") or {})
    context.update(fetch_args)
    url_tpl = cfg.get("url")
    if not isinstance(url_tpl, str):
        raise ValueError("url source missing url template")
    url = _interpolate(url_tpl, context)

    key = _cache_key(f"url:{method}:{url}")
    cached = _read_cache(key, ttl_ms)
    if cached is not None:
        return cached

    data = _fetch_json(url, method, headers)
    _write_cache(key, data)
    return data


def _execute_url_list(source_def: Dict[str, Any]) -> Any:
    cfg = source_def.get("url-list")
    if not isinstance(cfg, dict):
        raise ValueError("url-list source requires object config")
    method = str(cfg.get("method") or "GET").upper()
    headers = dict(cfg.get("headers") or {})
    cache_timeout = cfg.get("cacheTimeout")
    ttl_ms = int(cache_timeout * 1000) if isinstance(cache_timeout, (int, float)) else DEFAULT_CACHE_TTL_MS
    url_list = (source_def.get("_projections") or {}).get("url_list")
    if not isinstance(url_list, list) or not url_list:
        raise ValueError("url-list source requires _projections.url_list as non-empty array")

    out = []
    for item in url_list:
        url = str(item)
        key = _cache_key(f"url-list:{method}:{url}")
        cached = _read_cache(key, ttl_ms)
        if cached is not None:
            out.append(cached)
            continue
        data = _fetch_json(url, method, headers)
        _write_cache(key, data)
        out.append(data)
    return out


def _execute_copilot(source_def: Dict[str, Any], out_ref: str) -> Any:
    cfg = source_def.get("copilot") if isinstance(source_def.get("copilot"), dict) else {}
    template = cfg.get("prompt_template") or source_def.get("prompt_template")
    if not isinstance(template, str) or not template:
        raise ValueError("copilot source missing prompt_template")

    args = {}
    args.update(source_def.get("_projections") or {})
    args.update(cfg.get("args") or source_def.get("args") or {})
    prompt = _interpolate(template, args)

    wrapper = os.path.join(_HERE, "scripts", "copilot_wrapper.bat")
    if os.name != "nt" or not os.path.isfile(wrapper):
        raise RuntimeError("copilot wrapper is unavailable in this environment")

    out_file = _resolve_ref_to_path(out_ref) + ".copilot.json"
    prompt_file = out_file + ".prompt.txt"
    with open(prompt_file, "w", encoding="utf-8") as f:
        f.write(prompt)
    try:
        subprocess.run(
            [
                "cmd.exe", "/d", "/c", wrapper,
                out_file,
                os.path.join(tempfile.gettempdir(), "demo-task-executor-copilot"),
                os.getcwd(),
                "@" + prompt_file,
                "json",
                str(source_def.get("bindTo") or "executor"),
                "",
                "",
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        with open(out_file, "r", encoding="utf-8") as f:
            return json.load(f)
    finally:
        for p in (prompt_file, out_file):
            try:
                os.remove(p)
            except OSError:
                pass


def _execute_via_step_machine_flow(
    source_def: Dict[str, Any],
    out_ref: str,
    extra: Optional[Dict[str, Any]],
) -> Tuple[Any, bool]:
    """Run source def through the Python step machine using flow files + Python handler modules.

    Mirrors executeStepMachineSourceFlow in demo-task-executor.js.
    Supports howToRun='demo-local-module' by dynamically importing .py handler files.
    """
    from pylib.step_machine.step_machine import StepMachine
    from pylib.step_machine_public import build_step_handlers_for_flow
    from pylib.stores.memory import MemoryStore

    registry_path = os.path.join(_HERE, "source_def_flows.json")
    with open(registry_path, "r", encoding="utf-8") as f:
        registry = json.load(f)

    kind = _detect_kind(source_def)
    spec = (registry.get("kinds") or {}).get(kind)
    if not spec:
        raise ValueError(f"Missing flow registration for kind: {kind}")

    flow_ref = spec.get("flow")
    if not isinstance(flow_ref, str) or not flow_ref:
        raise ValueError(f"Invalid or missing flow for kind: {kind}")

    flow_path = os.path.normpath(os.path.join(_HERE, flow_ref))
    with open(flow_path, "r", encoding="utf-8") as f:
        flow = json.load(f)

    def invoke(ref: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        how = ref.get("howToRun", "")
        what = ref.get("whatToRun", "")

        if how == "demo-local-module":
            # whatToRun must be a b64 wire string or { kind, value } object
            if isinstance(what, dict):
                what_value = str(what.get("value") or "")
            else:
                parsed_what = parse_ref(what)
                what_value = str(parsed_what.get("value") or "")
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

        raise ValueError(f"[demo-task-executor.py] Unsupported howToRun for Python executor: {how!r}")

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
    try:
        source_def = _read_json_file(in_ref)
        result_value, wrote_directly = _execute_via_step_machine_flow(source_def, out_ref, extra)
        if not wrote_directly:
            _write_json_file(out_ref, result_value)
        return 0
    except Exception as err:
        _write_err(err_ref, str(err))
        print(f"[demo-task-executor.py] {err}", file=sys.stderr)
        return 1


def _describe_capabilities() -> int:
    payload = {
        "ok": True,
        "kinds": ["url", "url-list", "copilot", "workiq", "mock"],
        "python_only": True,
    }
    print(json.dumps(payload, ensure_ascii=True))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Python demo task executor")
    parser.add_argument("subcommand", choices=["run-source-fetch", "describe-capabilities"])
    parser.add_argument("--in-ref", dest="in_ref")
    parser.add_argument("--out-ref", dest="out_ref")
    parser.add_argument("--err-ref", dest="err_ref")
    parser.add_argument("--extra", dest="extra", required=False)
    args = parser.parse_args()

    if args.subcommand == "describe-capabilities":
        return _describe_capabilities()
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
