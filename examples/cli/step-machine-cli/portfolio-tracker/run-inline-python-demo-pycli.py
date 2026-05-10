#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def main() -> int:
    here = Path(__file__).resolve().parent
    repo_root = here.parents[3]

    pycli = repo_root / "pycli" / "main" / "step_machine_pycli.py"
    flow = here / "inline-python-demo.flow.yaml"

    initial_data = {
        "name": "Ada",
        "a": 7,
        "b": 5,
    }

    cmd = [
        sys.executable,
        str(pycli),
        str(flow),
        "--initial-data",
        json.dumps(initial_data, ensure_ascii=True),
        "--store",
        "memory",
    ]

    proc = subprocess.run(
        cmd,
        cwd=str(here),
        shell=False,
        check=False,
    )
    return proc.returncode


if __name__ == "__main__":
    raise SystemExit(main())
