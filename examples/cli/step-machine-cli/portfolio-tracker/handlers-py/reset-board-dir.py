#!/usr/bin/env python3
"""Reset (rm -rf) the board runtime directory."""
from __future__ import annotations

import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _board_pycli import read_stdin_json, write_failure, write_result  # noqa: E402


def main() -> int:
    try:
        payload = read_stdin_json()
        board_dir_input = str(payload.get("BOARD_DIR", "")).strip()
        if not board_dir_input:
            write_failure("BOARD_DIR is required")
            return 0

        board_dir = Path(board_dir_input).resolve()
        if board_dir.exists():
            shutil.rmtree(board_dir, ignore_errors=True)

        write_result({
            "result": "success",
            "data": {"board_dir": str(board_dir), "reset": True},
        })
        return 0
    except Exception as exc:
        write_failure(str(exc))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
