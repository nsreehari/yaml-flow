#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import sys
from typing import Any, Dict

from board_live_cards_state_snapshot import commit_snapshot, read_snapshot


def _parse_json_file(file_path: str) -> Dict[str, Any]:
    with open(file_path, "r", encoding="utf-8") as f:
        value = json.load(f)
    if not isinstance(value, dict):
        raise ValueError(f"JSON root must be an object: {file_path}")
    return value


def cmd_read_snapshot(args: argparse.Namespace) -> int:
    view = read_snapshot(args.scope)
    print(
        json.dumps(
            {
                "version": view.version,
                "values": view.values,
            },
            indent=2,
            ensure_ascii=True,
        )
    )
    return 0


def cmd_commit_snapshot(args: argparse.Namespace) -> int:
    envelope = _parse_json_file(args.input)
    result = commit_snapshot(args.scope, envelope)
    if result.ok:
        print(
            json.dumps(
                {
                    "ok": True,
                    "newVersion": result.new_version,
                },
                indent=2,
                ensure_ascii=True,
            )
        )
        return 0

    print(
        json.dumps(
            {
                "ok": False,
                "reason": result.reason,
                "currentVersion": result.current_version,
            },
            indent=2,
            ensure_ascii=True,
        )
    )
    return 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="board-live-cards-pycli",
        description="Python host implementation for board-live-cards snapshot-store operations.",
    )

    sub = parser.add_subparsers(dest="command", required=True)

    read_cmd = sub.add_parser("read-snapshot", help="Read authoritative snapshot values")
    read_cmd.add_argument("--scope", required=True, help="Board directory")
    read_cmd.set_defaults(handler=cmd_read_snapshot)

    commit_cmd = sub.add_parser("commit-snapshot", help="Commit snapshot envelope")
    commit_cmd.add_argument("--scope", required=True, help="Board directory")
    commit_cmd.add_argument("--in", dest="input", required=True, help="Path to commit envelope JSON")
    commit_cmd.set_defaults(handler=cmd_commit_snapshot)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as err:  # pragma: no cover - CLI error path
        print(str(err), file=sys.stderr)
        raise SystemExit(1)
