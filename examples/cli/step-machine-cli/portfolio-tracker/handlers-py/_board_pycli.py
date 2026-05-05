"""Shared helpers for step-machine portfolio-tracker pycli handlers.

Each handler reads a JSON object from stdin and writes a JSON object to stdout.
Result schema: {"result": "success" | "failure" | "timeout", "data"?: {...}, "error"?: "..."}
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

# Repo root layout (standalone or source tree):
#   <root>/pycli/main/board_live_cards_pycli.py
#   <root>/pycli/main/card_store_pycli.py
#   <root>/dist/pycli/quickjs-board-runtime.global.js
_HERE = Path(__file__).resolve().parent
_REPO_ROOT = _HERE.parents[4]

BOARD_PYCLI = _REPO_ROOT / "pycli" / "main" / "board_live_cards_pycli.py"
CARD_STORE_PYCLI = _REPO_ROOT / "pycli" / "main" / "card_store_pycli.py"
QUICKJS_BUNDLE = _REPO_ROOT / "dist" / "pycli" / "quickjs-board-runtime.global.js"


def read_stdin_json() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        return {}
    return json.loads(raw)


def write_result(payload: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True))
    sys.stdout.flush()


def write_failure(message: str) -> None:
    write_result({"result": "failure", "error": message})


def _hidden_kwargs() -> dict[str, Any]:
    kwargs: dict[str, Any] = {}
    if os.name == "nt":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        kwargs["startupinfo"] = startupinfo
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    return kwargs


def run_board_pycli(args: list[str], *, capture: bool = False) -> str:
    cmd = [sys.executable, str(BOARD_PYCLI), *args, "--bundle", str(QUICKJS_BUNDLE)]
    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        check=False,
        **_hidden_kwargs(),
    )
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or "no output").strip()
        raise RuntimeError(f"board_live_cards_pycli failed ({proc.returncode}): {msg}")
    return proc.stdout if capture else ""


def run_board_pycli_with_input(args: list[str], input_json: str) -> str:
    cmd = [sys.executable, str(BOARD_PYCLI), *args, "--bundle", str(QUICKJS_BUNDLE)]
    proc = subprocess.run(
        cmd,
        input=input_json,
        capture_output=True,
        text=True,
        check=False,
        **_hidden_kwargs(),
    )
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or "no output").strip()
        raise RuntimeError(f"board_live_cards_pycli failed ({proc.returncode}): {msg}")
    return proc.stdout


def run_card_store_pycli_with_input(args: list[str], input_json: str) -> str:
    cmd = [sys.executable, str(CARD_STORE_PYCLI), *args]
    proc = subprocess.run(
        cmd,
        input=input_json,
        capture_output=True,
        text=True,
        check=False,
        **_hidden_kwargs(),
    )
    if proc.returncode != 0:
        msg = (proc.stderr or proc.stdout or "no output").strip()
        raise RuntimeError(f"card_store_pycli failed ({proc.returncode}): {msg}")
    return proc.stdout
