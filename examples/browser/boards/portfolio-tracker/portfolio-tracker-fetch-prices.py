#!/usr/bin/env python3
"""portfolio-tracker-fetch-prices.py

Task executor for the portfolio board demo.
Handles run-source-fetch requests for source_defs with kind: "mock-quotes".
Generates random prices (2dp, 10.00-999.99) for each projected ticker.

Subcommands:
  run-source-fetch      --in-ref <::kind::value> --out-ref <::kind::value> --err-ref <::kind::value>
  validate-source-def   --in <source.json>
  describe-capabilities
"""

from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import time
from typing import Any
from urllib import request


def parse_ref(ref: str) -> tuple[str, str]:
    if not ref.startswith("::"):
        raise ValueError(f"Invalid ref format (expected ::kind::value): {ref}")
    inner = ref[2:]
    idx = inner.find("::")
    if idx < 0:
        raise ValueError(f"Invalid ref format (expected ::kind::value): {ref}")
    return inner[:idx], inner[idx + 2 :]


def serialize_ref(kind: str, value: str) -> str:
    return f"::{kind}::{value}"


def read_blob_ref(ref: str) -> str | None:
    kind, value = parse_ref(ref)
    if kind != "fs-path":
        raise ValueError(f"Unsupported storage kind: {kind}")
    if not os.path.exists(value):
        return None
    with open(value, "r", encoding="utf-8") as f:
        return f.read()


def write_blob_ref(ref: str, content: str) -> None:
    kind, value = parse_ref(ref)
    if kind != "fs-path":
        raise ValueError(f"Unsupported storage kind: {kind}")
    os.makedirs(os.path.dirname(value), exist_ok=True)
    with open(value, "w", encoding="utf-8") as f:
        f.write(content)


def _what_to_run_value(what_to_run: str) -> str:
    try:
        return parse_ref(what_to_run)[1]
    except Exception:
        return what_to_run


def report_complete(callback: dict[str, Any], out_ref: str) -> None:
    token = callback.get("token")
    via = callback.get("via") or {}
    how = via.get("howToRun")
    what_to_run = str(via.get("whatToRun") or "")

    if not token or not how or not what_to_run:
        raise ValueError("Invalid callback object")

    if how in ("local-node", "local-process"):
        script_path = _what_to_run_value(what_to_run)
        cmd = ["node", script_path, "source-data-fetched", "--ref", out_ref, "--token", token]
        result = subprocess.run(cmd, shell=False, capture_output=True, text=True)
        if result.returncode != 0:
            msg = (result.stderr or result.stdout or "callback failed").strip()
            raise RuntimeError(f"report_complete failed: {msg}")
        return

    if how == "http:post":
        url = _what_to_run_value(what_to_run)
        payload = json.dumps({"status": "complete", "ref": out_ref, "token": token}).encode("utf-8")
        req = request.Request(url, method="POST", data=payload, headers={"Content-Type": "application/json"})
        with request.urlopen(req, timeout=30):
            return

    raise ValueError(f"Unsupported callback transport: {how}")


def report_failed(callback: dict[str, Any], reason: str) -> None:
    token = callback.get("token")
    via = callback.get("via") or {}
    how = via.get("howToRun")
    what_to_run = str(via.get("whatToRun") or "")

    if not token or not how or not what_to_run:
        raise ValueError("Invalid callback object")

    if how in ("local-node", "local-process"):
        script_path = _what_to_run_value(what_to_run)
        cmd = ["node", script_path, "source-data-fetch-failure", "--token", token, "--reason", reason]
        result = subprocess.run(cmd, shell=False, capture_output=True, text=True)
        if result.returncode != 0:
            msg = (result.stderr or result.stdout or "callback failed").strip()
            raise RuntimeError(f"report_failed failed: {msg}")
        return

    if how == "http:post":
        url = _what_to_run_value(what_to_run)
        payload = json.dumps({"status": "failed", "reason": reason, "token": token}).encode("utf-8")
        req = request.Request(url, method="POST", data=payload, headers={"Content-Type": "application/json"})
        with request.urlopen(req, timeout=30):
            return

    raise ValueError(f"Unsupported callback transport: {how}")


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
    raw_in = read_blob_ref(args.in_ref)
    if not raw_in:
        print(f"[portfolio-tracker-fetch-prices] input envelope not found at: {args.in_ref}", file=sys.stderr)
        return 1

    envelope = json.loads(raw_in)
    callback = envelope.get("callback") if isinstance(envelope, dict) else None

    def safe_fail(msg: str) -> int:
        try:
            write_blob_ref(args.err_ref, msg)
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

        write_blob_ref(args.out_ref, json.dumps(prices, ensure_ascii=True))
        print(f"[portfolio-tracker-fetch-prices] wrote prices for: {', '.join([str(t) for t in tickers])}")

        if isinstance(callback, dict):
            report_complete(callback, args.out_ref)
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
