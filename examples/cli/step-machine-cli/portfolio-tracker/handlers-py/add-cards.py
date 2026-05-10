#!/usr/bin/env python3
"""Write all cards to card-store and upsert them onto the board (pycli)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _board_pycli import (  # noqa: E402
    read_stdin_json,
    run_board_pycli,
    run_card_store_pycli_with_input,
    to_fs_ref,
    write_failure,
    write_result,
)


def main() -> int:
    try:
        payload = read_stdin_json()
        board_dir = str(payload.get("BOARD_DIR", "")).strip()
        cards = payload.get("CARDS")
        if not isinstance(cards, list):
            cards = []

        if not board_dir or not cards:
            write_failure("BOARD_DIR and CARDS (array) are required")
            return 0

        base_ref = to_fs_ref(board_dir)

        run_card_store_pycli_with_input(
            ["set", "--store-ref", base_ref],
            json.dumps(cards, ensure_ascii=True),
        )
        run_board_pycli(["upsert-card", "--base-ref", base_ref, "--all"])

        write_result({
            "result": "success",
            "data": {"board_dir": board_dir, "count": len(cards)},
        })
        return 0
    except Exception as exc:
        write_failure(str(exc))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
