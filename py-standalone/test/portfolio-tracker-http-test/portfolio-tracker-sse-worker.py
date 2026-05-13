#!/usr/bin/env python3
"""portfolio-tracker-sse-worker.py

Dedicated SSE worker process for portfolio-tracker HTTP tests.
Reads SSE frames from --sse-url and emits JSON lines to stdout:
  {"type":"frame","payload":...}
  {"type":"error","message":"..."}
  {"type":"closed"}
"""

from __future__ import annotations

import argparse
import json
import urllib.request


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sse-url", required=True)
    return parser.parse_args()


def emit(message: dict) -> None:
    print(json.dumps(message, ensure_ascii=True), flush=True)


def main() -> int:
    args = parse_args()
    req = urllib.request.Request(args.sse_url, headers={"Accept": "text/event-stream"})
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            block_lines: list[str] = []
            while True:
                raw = resp.readline()
                if not raw:
                    break
                line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
                if line == "":
                    data_lines = [l[6:] for l in block_lines if l.startswith("data: ")]
                    block_lines = []
                    if not data_lines:
                        continue
                    data_text = "\n".join(data_lines)
                    try:
                        payload = json.loads(data_text)
                    except json.JSONDecodeError:
                        continue
                    emit({"type": "frame", "payload": payload})
                else:
                    block_lines.append(line)
        emit({"type": "closed"})
        return 0
    except Exception as exc:
        emit({"type": "error", "message": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
