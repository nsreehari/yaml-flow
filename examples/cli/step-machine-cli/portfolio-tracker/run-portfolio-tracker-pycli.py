#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run the step-machine portfolio tracker example via step_machine_pycli.py",
    )
    parser.add_argument(
        "action",
        nargs="?",
        choices=["run", "pause", "resume", "status"],
        default="run",
        help="Operation to perform (default: run)",
    )
    return parser


def main() -> int:
    args = _build_parser().parse_args()

    here = Path(__file__).resolve().parent
    repo_root = here.parents[3]
    pycli = repo_root / "pycli" / "main" / "step_machine_pycli.py"
    flow = here / "portfolio-tracker-pycli.flow.yaml"
    input_json = here / "portfolio-tracker.input.json"

    temp_root = Path(tempfile.gettempdir()) / "yaml-flow-step-machine-portfolio-tracker"
    store_dir = temp_root / "store"
    runtime_root = temp_root / "runtime"

    cmd = [
        sys.executable,
        str(pycli),
        "--store",
        "file",
        "--store-dir",
        str(store_dir),
    ]

    if args.action in ("run", "resume"):
        cmd.insert(2, str(flow))

    if args.action == "run":
        payload = json.loads(input_json.read_text(encoding="utf-8"))
        payload["runtime_root"] = runtime_root.as_posix()
        cmd.extend(["--initial-data", json.dumps(payload, ensure_ascii=True)])
    elif args.action == "resume":
        cmd.append("--resume")
    elif args.action == "pause":
        cmd.append("--pause")
    elif args.action == "status":
        cmd.append("--status")

    proc = subprocess.run(
        cmd,
        cwd=str(here),
        shell=False,
        check=False,
        env={
            **os.environ,
            "PATH": str(Path(sys.executable).parent) + os.pathsep + os.environ.get("PATH", ""),
        },
    )
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
