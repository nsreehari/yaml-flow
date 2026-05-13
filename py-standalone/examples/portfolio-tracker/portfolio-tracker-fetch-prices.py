#!/usr/bin/env python3
"""portfolio-tracker-fetch-prices.py

Task executor for the portfolio board demo.
Handles run-source-fetch requests for source_defs with kind: "mock-quotes".
Generates random prices (2dp, 10.00-999.99) for each projected ticker.

Subcommands:
  run-source-fetch      --in-ref <::kind::value> --out-ref <::kind::value> --err-ref <::kind::value>
  validate-source-def   --in <source.json>
  describe-capabilities

Uses the board worker adapter for all storage and callback operations.
The executor does NOT contain transport-specific callback logic.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from typing import Any

# Add pycli to path so we can import the board worker adapter.
_REPO_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'core'))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from sub.board_worker_adapter import (  # noqa: E402
    parse_ref,
    serialize_ref,
    blob_storage_for_ref,
    report_complete,
    report_failed,
    KindValueRef,
)


def _parse_ref_str(ref: str) -> KindValueRef:
    """Convenience: parse a CLI ref string."""
    return parse_ref(ref)


def validate_source_def(source_def: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []

    if source_def.get("kind") != "mock-quotes":
        errors.append(f"kind must be \"mock-quotes\"; got \"{source_def.get('kind')}\".")
    if not isinstance(source_def.get("bindTo"), str) or not source_def.get("bindTo"):
        errors.append("bindTo is required and must be a string.")
    if not isinstance(source_def.get("outputFile"), str) or not source_def.get("outputFile"):
        errors.append("outputFile is required and must be a string.")
    projections = source_def.get("projections")
    if not isinstance(projections, dict) or not isinstance(projections.get("tickers"), str):
        errors.append("projections.tickers is required and must be a JSONata expression string.")

    return {"ok": len(errors) == 0, "errors": errors}


def cmd_validate_source_def(args: argparse.Namespace) -> int:
    if not os.path.exists(args.input):
        print(json.dumps({"ok": False, "errors": [f"Input file not found: {args.input}"]}))
        return 1

    try:
        with open(args.input, "r", encoding="utf-8") as f:
            source_def = json.load(f)
    except Exception as e:
        print(json.dumps({"ok": False, "errors": [f"Cannot parse source file: {e}"]}))
        return 1

    result = validate_source_def(source_def if isinstance(source_def, dict) else {})
    print(json.dumps(result))
    return 0 if result["ok"] else 1


def cmd_describe_capabilities(_: argparse.Namespace) -> int:
    capabilities = {
        "version": "1.0",
        "executor": "portfolio-tracker-fetch-prices",
        "subcommands": ["run-source-fetch", "validate-source-def", "describe-capabilities"],
        "sourceKinds": {
            "mock-quotes": {
                "description": "Generates random mock market prices (10.00-999.99) for each ticker in _projections.tickers.",
                "inputSchema": {
                    "kind": {"type": "string", "required": True, "description": "Must be \"mock-quotes\"."},
                    "bindTo": {"type": "string", "required": True, "description": "Token name for the output binding."},
                    "outputFile": {"type": "string", "required": True, "description": "Relative path to write prices JSON."},
                    "projections": {
                        "type": "object",
                        "required": True,
                        "properties": {
                            "tickers": {
                                "type": "string",
                                "required": True,
                                "description": "JSONata expression resolving to a string[] of ticker symbols.",
                            }
                        },
                    },
                },
                "outputShape": "{ [ticker: string]: number }",
            }
        },
    }
    print(json.dumps(capabilities, indent=2, ensure_ascii=True))
    return 0


def cmd_run_source_fetch(args: argparse.Namespace) -> int:
    in_ref = _parse_ref_str(args.in_ref)
    out_ref = _parse_ref_str(args.out_ref)
    err_ref = _parse_ref_str(args.err_ref)

    in_storage = blob_storage_for_ref(in_ref)
    out_storage = blob_storage_for_ref(out_ref)
    err_storage = blob_storage_for_ref(err_ref)

    raw_in = in_storage.read(in_ref.value)
    if not raw_in:
        print(f"[portfolio-tracker-fetch-prices] input envelope not found at: {args.in_ref}", file=sys.stderr)
        return 1

    envelope = json.loads(raw_in)
    callback = envelope.get("callback") if isinstance(envelope, dict) else None

    def safe_fail(msg: str) -> int:
        try:
            err_storage.write(err_ref.value, msg)
        except Exception:
            pass
        if isinstance(callback, dict):
            try:
                report_failed(callback, msg)
                return 0
            except Exception as e:
                print(f"[portfolio-tracker-fetch-prices] callback fail: {e}", file=sys.stderr)
                return 1
        return 1

    try:
        source_def = envelope.get("source_def") if isinstance(envelope, dict) else None
        if not isinstance(source_def, dict):
            source_def = envelope if isinstance(envelope, dict) else {}

        if source_def.get("kind") != "mock-quotes":
            raise ValueError(f"Unsupported source kind: expected \"mock-quotes\", got \"{source_def.get('kind')}\"")

        projections = source_def.get("_projections")
        tickers = projections.get("tickers") if isinstance(projections, dict) else None
        if not isinstance(tickers, list):
            raise ValueError("sourceDef._projections.tickers is missing or not an array")

        time.sleep(0.2 + random.random() * 0.1)

        prices: dict[str, float] = {}
        for ticker in tickers:
            prices[str(ticker)] = round(10 + random.random() * 989.99, 2)

        out_storage.write(out_ref.value, json.dumps(prices, ensure_ascii=True))
        print(f"[portfolio-tracker-fetch-prices] wrote prices for: {', '.join([str(t) for t in tickers])}")

        if isinstance(callback, dict):
            report_complete(callback, out_ref)
        return 0
    except Exception as e:
        msg = str(e)
        print(f"[portfolio-tracker-fetch-prices] error: {msg}", file=sys.stderr)
        return safe_fail(msg)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="portfolio-tracker-fetch-prices")
    sub = parser.add_subparsers(dest="command", required=True)

    run_cmd = sub.add_parser("run-source-fetch")
    run_cmd.add_argument("--in-ref", required=True)
    run_cmd.add_argument("--out-ref", required=True)
    run_cmd.add_argument("--err-ref", required=True)
    run_cmd.set_defaults(handler=cmd_run_source_fetch)

    val_cmd = sub.add_parser("validate-source-def")
    val_cmd.add_argument("--in", dest="input", required=True)
    val_cmd.set_defaults(handler=cmd_validate_source_def)

    cap_cmd = sub.add_parser("describe-capabilities")
    cap_cmd.set_defaults(handler=cmd_describe_capabilities)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
