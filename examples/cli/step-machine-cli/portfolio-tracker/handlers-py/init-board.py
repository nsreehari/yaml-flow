#!/usr/bin/env python3
"""Initialize the board with card-store and outputs-store refs (pycli)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _board_pycli import (  # noqa: E402
    read_stdin_json,
    run_board_pycli,
    to_fs_ref,
    write_failure,
    write_result,
)


def main() -> int:
    try:
        payload = read_stdin_json()
        board_dir = str(payload.get("BOARD_DIR", "")).strip()
        if not board_dir:
            write_failure("BOARD_DIR is required")
            return 0

        base_ref = to_fs_ref(board_dir)
        run_board_pycli([
            "init",
            "--base-ref", base_ref,
            "--card-store-ref", base_ref,
            "--outputs-store-ref", base_ref,
        ])

        write_result({
            "result": "success",
            "data": {"board_dir": board_dir, "message": f"initialized {board_dir}"},
        })
        return 0
    except Exception as exc:
        write_failure(str(exc))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
