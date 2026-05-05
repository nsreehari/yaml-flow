#!/usr/bin/env python3
"""Poll board status until all expected cards reach `completed` (pycli)."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _board_pycli import (  # noqa: E402
    read_stdin_json,
    run_board_pycli,
    write_failure,
    write_result,
)


def main() -> int:
    try:
        payload = read_stdin_json()
        board_dir = str(payload.get("BOARD_DIR", "")).strip()
        expected = int(payload.get("EXPECTED_CARD_COUNT") or 0)
        timeout_ms = int(payload.get("TIMEOUT_MS") or 30_000)
        poll_ms = int(payload.get("POLL_MS") or 500)

        if not board_dir or expected <= 0:
            write_failure("BOARD_DIR and EXPECTED_CARD_COUNT are required")
            return 0

        base_ref = f"::fs-path::{board_dir}"
        deadline = time.monotonic() + (timeout_ms / 1000)

        while time.monotonic() < deadline:
            raw = run_board_pycli(["status", "--base-ref", base_ref], capture=True)
            cards = []
            try:
                cards = json.loads(raw).get("data", {}).get("cards", []) or []
            except Exception:
                cards = []

            completed = [c for c in cards if c.get("status") == "completed"]
            if len(cards) >= expected and len(completed) >= expected:
                write_result({
                    "result": "success",
                    "data": {
                        "completed": True,
                        "card_count": len(cards),
                        "completed_count": len(completed),
                    },
                })
                return 0

            time.sleep(poll_ms / 1000)

        write_result({
            "result": "timeout",
            "data": {
                "completed": False,
                "error": f"timed out waiting for {expected} cards to complete",
            },
        })
        return 0
    except Exception as exc:
        write_failure(str(exc))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
