"""
execution_adapter.py

Python-side adapter that resolves an ExecutionRef + logical args into a
physical invocation (subprocess for local transports). Mirrors the
sync request/reply slice of src/cli/node/execution-adapter.ts.

Provides:
  - invoke_ref_sync(ref, args, opts?) -> {result, data, error?}
    Generic ref invocation used by step-machine ref steps (and any utility
    needing sync request/reply against an ExecutionRef).

The framework (engine) never inspects payload shape; it only routes on
`result`. Transport outcome (exit code) drives the envelope:
   exit 0  -> { result: 'success', data: parsed-stdout-or-{stdout: raw} }
   non-0   -> { result: 'failure', data: { error: stderr-or-exit-detail } }
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any, Dict, Optional

from .args_massaging import resolve_args_massaging
from .storage_interface import parse_ref


# ============================================================================
# Resolve ExecutionRef -> (cmd, baseArgs, cwd) for local transports
# ============================================================================

def _resolve_local_base_spec(ref: Dict[str, Any], cwd: str) -> Dict[str, Any]:
    how_to_run = ref.get("howToRun")
    what_to_run = ref.get("whatToRun", "")

    # Try to parse as KindValueRef; fall back to bare path.
    try:
        parsed = parse_ref(what_to_run)
        script_path = parsed.get("value", what_to_run)
    except Exception:
        script_path = what_to_run

    if not os.path.isabs(script_path):
        script_path = os.path.normpath(os.path.join(cwd, script_path))

    if how_to_run == "local-node":
        return {"command": "node", "baseArgs": [script_path], "cwd": cwd}
    if how_to_run == "local-python":
        python = "python" if sys.platform == "win32" else "python3"
        return {"command": python, "baseArgs": [script_path], "cwd": cwd}
    if how_to_run == "local-process":
        return {"command": script_path, "baseArgs": [], "cwd": cwd}
    raise ValueError(
        f'[invoke_ref_sync] howToRun "{how_to_run}" is not a local transport'
    )


# ============================================================================
# Stdout JSON parsing — tolerant of trailing log lines
# ============================================================================

def _parse_stdout_as_json(stdout: str) -> Any:
    trimmed = stdout.strip()
    if not trimmed:
        raise ValueError("empty stdout")
    try:
        return json.loads(trimmed)
    except json.JSONDecodeError:
        lines = [ln for ln in trimmed.splitlines() if ln]
        return json.loads(lines[-1])


# ============================================================================
# invoke_ref_sync — synchronous request/reply for ref-based invocations
# ============================================================================

def invoke_ref_sync(
    ref: Dict[str, Any],
    args: Dict[str, Any],
    opts: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Invoke an ExecutionRef synchronously with a request/reply contract.

    Behavior mirrors src/cli/node/execution-adapter.ts:invokeRefSync:
      1. Resolve ref.argsMassaging against args -> cmdArgs / body.
      2. Build the local base spec (node/python/process + script path).
      3. Spawn synchronously with json(body or args) on stdin.
      4. Map exit code into the normalized envelope.

    opts (all optional):
      cwd:       working directory (default: process cwd)
      cliDir:    directory used to resolve relative fs-path refs
                 (defaults to cwd)
      timeoutMs: int seconds*1000 (default: 30_000)
      label:     used in error messages (default: 'invoke_ref_sync')
    """
    opts = opts or {}
    label = opts.get("label", "invoke_ref_sync")
    cwd = opts.get("cwd") or os.getcwd()
    cli_dir = opts.get("cliDir") or cwd
    timeout_ms = opts.get("timeoutMs", 30_000)

    # Step 1: argsMassaging
    try:
        massaged = resolve_args_massaging(ref.get("argsMassaging"), args, label)
    except Exception as ex:
        return {"result": "failure", "data": {"error": str(ex)}}

    # Step 2: build base spec
    try:
        base_spec = _resolve_local_base_spec(ref, cli_dir)
    except Exception as ex:
        return {
            "result": "failure",
            "data": {"error": f"[{label}] ref resolution failed: {ex}"},
        }

    argv = list(base_spec["baseArgs"]) + list(massaged.get("cmdArgs") or [])
    stdin_payload = json.dumps(
        massaged["body"] if "body" in massaged else args,
        ensure_ascii=True,
    )

    # Step 3: spawn
    try:
        proc = subprocess.run(
            [base_spec["command"], *argv],
            cwd=cwd,
            input=stdin_payload,
            capture_output=True,
            text=True,
            timeout=max(1, timeout_ms // 1000),
            check=False,
        )
    except FileNotFoundError as ex:
        return {
            "result": "failure",
            "data": {"error": f"[{label}] ref failed to start: {ex}"},
        }
    except subprocess.TimeoutExpired as ex:
        return {
            "result": "failure",
            "data": {"error": f"[{label}] ref timed out after {timeout_ms}ms: {ex}"},
        }

    stdout = proc.stdout or ""
    stderr = (proc.stderr or "").strip()

    if proc.returncode != 0:
        detail = stderr or f"exit code {proc.returncode}"
        return {
            "result": "failure",
            "data": {
                "error": f"[{label}] ref exited with status {proc.returncode}: {detail}",
            },
        }

    # Step 4: transport succeeded — wrap stdout as data unconditionally.
    try:
        parsed = _parse_stdout_as_json(stdout)
        if isinstance(parsed, dict):
            return {"result": "success", "data": parsed}
        return {"result": "success", "data": {"stdout": parsed}}
    except Exception:
        return {"result": "success", "data": {"stdout": stdout.strip()}}
