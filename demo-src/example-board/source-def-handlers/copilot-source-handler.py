#!/usr/bin/env python3
"""
copilot-source-handler.py — Python port of copilot-source-handler.js.

Handles 'copilot' source kind for the demo board.
Called by demo-task-executor.py via the step machine (demo-local-module).

Interface:
  execute(context) -> {"result": "success"|"failure", "data": {...}}

  context keys:
    sourceDef    : dict — source definition from the card
    executorDir  : str  — directory of demo-task-executor.py
    extra        : dict — board topology context (boardSetupRoot, etc.)
    promptContext: dict — reusable prompt fragments (view_kind_guidance, card_layout_guidance)
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import uuid
from typing import Any, Dict, Optional

_DEFAULT_PROMPT_CONTEXT = {
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


def _interpolate(template: str, args: Dict[str, Any]) -> str:
    out = str(template)
    for key, value in args.items():
        needle = "{{" + str(key) + "}}"
        if needle in out:
            out = out.replace(needle, value if isinstance(value, str) else json.dumps(value, ensure_ascii=True))
    return out


def _resolve_copilot_prompt(source_def: Dict[str, Any], prompt_context: Dict[str, Any]) -> Optional[str]:
    cfg = source_def.get("copilot") if isinstance(source_def.get("copilot"), dict) else {}
    template = cfg.get("prompt_template") or source_def.get("prompt_template")
    if not isinstance(template, str) or not template:
        return None
    args: Dict[str, Any] = {}
    args.update(prompt_context or {})
    args.update(source_def.get("_projections") or {})
    args.update(cfg.get("args") or source_def.get("args") or {})
    return _interpolate(template, args)


def execute(context: Dict[str, Any]) -> Dict[str, Any]:
    """Handler entry point — called by demo-task-executor via step machine."""
    source_def = context.get("sourceDef") or {}
    extra = context.get("extra") or {}
    executor_dir = context.get("executorDir") or os.path.dirname(os.path.abspath(__file__))
    prompt_context = context.get("promptContext") or _DEFAULT_PROMPT_CONTEXT

    prompt = _resolve_copilot_prompt(source_def, prompt_context)
    if not prompt:
        return {
            "result": "failure",
            "data": {"error": "Source definition missing copilot.prompt_template (or prompt_template)"},
            "error": "missing prompt_template",
        }

    copilot_cwd: Optional[str] = extra.get("boardSetupRoot") or None
    scripts_dir = os.path.join(executor_dir, "scripts")
    wrapper_path = os.path.join(scripts_dir, "copilot_wrapper.bat")
    use_wrapper = os.name == "nt" and os.path.isfile(wrapper_path)

    try:
        run_id = uuid.uuid4().hex
        tmp_base = os.path.join(tempfile.gettempdir(), f"copilot-handler-{run_id}")

        if use_wrapper:
            session_dir = os.path.join(
                extra.get("boardSetupRoot") or tempfile.gettempdir(),
                "copilot-sessions",
                re.sub(r"[^a-zA-Z0-9_-]", "_", str(source_def.get("bindTo") or "default")),
            )
            os.makedirs(session_dir, exist_ok=True)
            wrapper_out_file = tmp_base + ".out.json"
            prompt_file = tmp_base + ".prompt.txt"
            shape = (source_def.get("copilot") or {}).get("result_shape") or source_def.get("result_shape")
            shape_file = ""
            if shape and isinstance(shape, dict):
                shape_file = tmp_base + ".shape.json"
                with open(shape_file, "w", encoding="utf-8") as f:
                    json.dump(shape, f)
            with open(prompt_file, "w", encoding="utf-8") as f:
                f.write(prompt)
            try:
                subprocess.run(
                    [
                        "cmd.exe", "/d", "/c", wrapper_path,
                        wrapper_out_file,
                        session_dir,
                        copilot_cwd or os.getcwd(),
                        "@" + prompt_file,
                        "json",
                        str(source_def.get("bindTo") or "executor"),
                        "",
                        shape_file,
                    ],
                    check=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                with open(wrapper_out_file, "r", encoding="utf-8-sig") as f:
                    result_value = json.load(f)
                return {"result": "success", "data": {"resultValue": result_value}}
            finally:
                for p in (prompt_file, wrapper_out_file):
                    try:
                        os.remove(p)
                    except OSError:
                        pass
                if shape_file:
                    try:
                        os.remove(shape_file)
                    except OSError:
                        pass

        # Fallback: copilot --allow-all via stdin
        proc = subprocess.run(
            ["copilot", "--allow-all"],
            input=prompt,
            capture_output=True,
            text=True,
            timeout=120,
            cwd=copilot_cwd or None,
        )
        raw_output = proc.stdout
        first_brace = raw_output.find("{")
        first_bracket = raw_output.find("[")
        if first_brace == -1:
            json_start = first_bracket
        elif first_bracket == -1:
            json_start = first_brace
        else:
            json_start = min(first_brace, first_bracket)

        if json_start != -1:
            try:
                parsed = json.loads(raw_output[json_start:])
                result_value = parsed if isinstance(parsed, (dict, list)) else raw_output
            except json.JSONDecodeError:
                result_value = raw_output
        else:
            result_value = raw_output

        return {"result": "success", "data": {"resultValue": result_value}}

    except Exception as exc:
        msg = str(exc)
        return {"result": "failure", "data": {"error": f"copilot invocation failed: {msg}"}, "error": msg}
