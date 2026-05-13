#!/usr/bin/env python3
"""demo-http-test.py

HTTP+SSE regression test for standalone py-demo-server.

Scenarios:
  T0 - init, swait(30s), wait(notification 2s)
  T1 - patch holdings with one additional ticker, then wait for completion

Assertions:
  - wait-for-completed-all times out only in notification wait helper
  - T1: holdings row count increases by 1 from T0 baseline
  - T1: portfolio-value positions row count increases by 1 from T0 baseline

Usage:
  python demo-http-test.py [--port 7804] [--board-id demo-http-test]
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path


HERE = Path(__file__).resolve().parent
SERVER_DIR = HERE.parent
SERVER_SCRIPT = SERVER_DIR / "py-demo-server.py"


class TestFailure(RuntimeError):
    pass


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise TestFailure(message)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=7804)
    parser.add_argument("--board-id", default="demo-http-test")
    parser.add_argument("--testing-pattern", default="cardT*.json")
    return parser.parse_args()


ARGS = parse_args()
BASE = f"http://127.0.0.1:{ARGS.port}/api/boards/{ARGS.board_id}"
BOARDS_BASE = f"http://127.0.0.1:{ARGS.port}/api/boards"


NS_LOCK = threading.Lock()
NS = {
    "status_summary": None,
    "status_generation": 0,
}


def apply_frame(payload: dict) -> None:
    with NS_LOCK:
        if isinstance(payload, dict) and isinstance(payload.get("statusSnapshot"), dict):
            summary = (payload.get("statusSnapshot") or {}).get("summary")
            if isinstance(summary, dict):
                NS["status_summary"] = summary
                NS["status_generation"] += 1
            return

        if (
            isinstance(payload, dict)
            and payload.get("kind") == "notification-batch"
            and isinstance(payload.get("notifications"), list)
        ):
            for note in payload["notifications"]:
                if not isinstance(note, dict):
                    continue
                if note.get("kind") == "status":
                    summary = (note.get("status") or {}).get("summary")
                    if isinstance(summary, dict):
                        NS["status_summary"] = summary
                        NS["status_generation"] += 1


def ns_snapshot() -> dict:
    with NS_LOCK:
        return {
            "status_summary": NS["status_summary"],
            "status_generation": NS["status_generation"],
        }


def http_json(method: str, url: str, payload: dict | None = None) -> tuple[int, object]:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Content-Length": str(len(data)),
        }

    req = urllib.request.Request(url, data=data, method=method.upper(), headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
            try:
                body = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                body = raw
            return resp.status, body
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            body = json.loads(raw)
        except json.JSONDecodeError:
            body = raw
        return e.code, body


def start_sse_consumer(stop_event: threading.Event) -> threading.Thread:
    def _run() -> None:
        req = urllib.request.Request(f"{BASE}/sse", headers={"Accept": "text/event-stream"})
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                block_lines: list[str] = []
                while not stop_event.is_set():
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
                        apply_frame(payload)
                    else:
                        block_lines.append(line)
        except Exception:
            if not stop_event.is_set():
                return

    th = threading.Thread(target=_run, daemon=True)
    th.start()
    return th


def reset_server_state_dirs() -> None:
    for dirname in (".demo-setup", ".server-meta"):
        shutil.rmtree(SERVER_DIR / dirname, ignore_errors=True)


def start_demo_server() -> subprocess.Popen:
    env = os.environ.copy()
    env["DEMO_SERVER_PORT"] = str(ARGS.port)
    env["PYTHONUNBUFFERED"] = "1"

    proc = subprocess.Popen(
        [
            sys.executable,
            str(SERVER_SCRIPT),
            "--board-id",
            ARGS.board_id,
            "--testing-pattern",
            ARGS.testing_pattern,
        ],
        cwd=str(SERVER_DIR),
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    def _pump_stdout() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            print(f"[server] {line}", end="")

    def _pump_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            print(f"[server:err] {line}", end="")

    threading.Thread(target=_pump_stdout, daemon=True).start()
    threading.Thread(target=_pump_stderr, daemon=True).start()

    deadline = time.monotonic() + 20.0
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            break
        try:
            with socket.create_connection(("127.0.0.1", ARGS.port), timeout=0.5):
                return proc
        except OSError:
            time.sleep(0.2)

    proc.terminate()
    raise TestFailure(f"Server startup timeout on port {ARGS.port}")


def stop_demo_server(proc: subprocess.Popen) -> None:
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def wait_for_status_completed_all(timeout_seconds: float, label: str) -> dict:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        snap = ns_snapshot()
        summary = snap["status_summary"]
        if isinstance(summary, dict):
            card_count = int(summary.get("card_count") or 0)
            completed = int(summary.get("completed") or 0)
            if card_count > 0 and completed == card_count:
                return summary
        time.sleep(0.15)

    snap = ns_snapshot()
    raise TestFailure(
        f"Timeout ({timeout_seconds}s) waiting for completed-all: {label}\n"
        f"  last status generation={snap['status_generation']}\n"
        f"  last status summary={json.dumps(snap['status_summary'])}"
    )


def swait_for_completion(timeout_seconds: float, label: str) -> dict:
    deadline = time.monotonic() + timeout_seconds
    last_summary = None
    last_printed = None

    while time.monotonic() < deadline:
        status, body = http_json("GET", f"{BASE}/board-status")
        if status == 200 and isinstance(body, dict):
            summary = ((body.get("statusSnapshot") or {}).get("summary"))
            if isinstance(summary, dict):
                last_summary = summary
                card_count = int(summary.get("card_count") or 0)
                completed = int(summary.get("completed") or 0)
                failed = int(summary.get("failed") or 0)
                summary_json = json.dumps(summary, sort_keys=True)
                if summary_json != last_printed:
                    print(
                        f"[swait] {label}: completed={completed}/{card_count}, failed={failed}, "
                        f"summary={summary_json}"
                    )
                    last_printed = summary_json
                if card_count > 0 and completed == card_count:
                    return summary
        time.sleep(1.0)

    raise TestFailure(
        f"Timeout ({timeout_seconds}s) in swait_for_completion: {label}\n"
        f"  last status summary={json.dumps(last_summary)}"
    )


def get_holdings_and_positions_counts() -> tuple[int, int]:
    status, body = http_json("GET", f"{BASE}/board-status")
    assert_true(status == 200, f"board-status returned {status}")
    assert_true(isinstance(body, dict), "board-status body is not JSON")

    runtime = body.get("cardRuntimeById") if isinstance(body.get("cardRuntimeById"), dict) else {}

    portfolio_rt = runtime.get("card-portfolio") if isinstance(runtime.get("card-portfolio"), dict) else {}
    holdings = (portfolio_rt.get("card_data") or {}).get("holdings")
    holdings_count = len(holdings) if isinstance(holdings, list) else 0

    value_rt = runtime.get("card-portfolio-value") if isinstance(runtime.get("card-portfolio-value"), dict) else {}
    positions = (value_rt.get("computed_values") or {}).get("positions")
    positions_count = len(positions) if isinstance(positions, list) else 0

    return holdings_count, positions_count


def kill_stale_listener(port: int) -> None:
    """If anything is already listening on `port`, try to connect and close it."""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            pass
    except OSError:
        return  # nothing listening — good
    # Something is listening; on Windows use netstat+taskkill, on Unix use fuser/lsof
    import platform
    if platform.system() == "Windows":
        import re
        out = subprocess.check_output(
            ["netstat", "-ano", "-p", "TCP"], text=True, stderr=subprocess.DEVNULL
        )
        for line in out.splitlines():
            if f":{port}" in line and "LISTENING" in line:
                parts = line.split()
                pid = parts[-1]
                if pid.isdigit() and int(pid) != os.getpid():
                    print(f"[setup] killing stale process on port {port} (PID {pid})")
                    subprocess.run(["taskkill", "/F", "/PID", pid],
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    time.sleep(0.5)
    else:
        subprocess.run(["fuser", "-k", f"{port}/tcp"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.5)


def run() -> None:
    print("\n=== demo HTTP+SSE test (standalone) ===")
    print(f"target: {BASE}")

    print("[setup] removing server state dirs: .demo-setup, .server-meta")
    reset_server_state_dirs()

    kill_stale_listener(ARGS.port)

    print(f"[setup] starting demo server on port {ARGS.port}")
    server_proc = start_demo_server()
    sse_stop = threading.Event()

    try:
        status, _ = http_json("POST", BOARDS_BASE, {"id": ARGS.board_id, "label": "Demo HTTP Test"})
        assert_true(status in (200, 409), f"board register returned {status}")

        start_sse_consumer(sse_stop)

        print("\n=== T0: init/bootstrap ===")
        status, _ = http_json("GET", f"{BASE}/init-board")
        assert_true(status == 200, f"init-board returned {status}")

        swait_for_completion(30.0, "T0 init/bootstrap")
        t0_summary = wait_for_status_completed_all(2.0, "T0 init/bootstrap")
        print(f"[T0] ok: completed-all, card_count={t0_summary.get('card_count')}")

        # Allow card_data to settle before reading T0 baseline
        time.sleep(1.0)
        t0_holdings_count, t0_positions_count = get_holdings_and_positions_counts()

        print("\n=== T1: patch holdings (+1 row) ===")
        status, body = http_json("GET", f"{BASE}/board-status")
        assert_true(status == 200 and isinstance(body, dict), "Cannot read board-status for patch baseline")

        runtime = body.get("cardRuntimeById") if isinstance(body.get("cardRuntimeById"), dict) else {}
        portfolio_rt = runtime.get("card-portfolio") if isinstance(runtime.get("card-portfolio"), dict) else {}
        existing_holdings = (portfolio_rt.get("card_data") or {}).get("holdings")
        if not isinstance(existing_holdings, list):
            print(f"[debug] card-portfolio runtime keys: {list(portfolio_rt.keys())}")
            print(f"[debug] card_data: {json.dumps(portfolio_rt.get('card_data'))[:500]}")
        assert_true(isinstance(existing_holdings, list), "card-portfolio.card_data.holdings missing")

        existing_tickers = {
            str(row.get("ticker"))
            for row in existing_holdings
            if isinstance(row, dict) and isinstance(row.get("ticker"), str)
        }

        candidates = [
            "AAPL", "MSFT", "AMZN", "TSLA", "META",
            "GOOG", "NVDA", "NFLX", "INTC", "AMD",
            "IBM", "ORCL", "ADBE", "CRM", "QCOM",
        ]
        available = [t for t in candidates if t not in existing_tickers]
        assert_true(len(available) > 0, "No available ticker left to add; all candidate symbols already exist")
        new_ticker = random.choice(available)

        new_holdings = list(existing_holdings)
        new_holdings.append({"ticker": new_ticker, "quantity": 1, "cost_basis": 100})

        status, _ = http_json(
            "PATCH",
            f"{BASE}/cards/card-portfolio",
            {"card_data": {"holdings": new_holdings}},
        )
        assert_true(status == 200, f"PATCH card-portfolio returned {status}")

        time.sleep(4.0)
        t1_summary = wait_for_status_completed_all(30.0, "T1 holdings patch")
        assert_true(int(t1_summary.get("failed") or 0) == 0, f"T1 failed={t1_summary.get('failed')}")

        after_holdings, after_positions = get_holdings_and_positions_counts()
        assert_true(
            after_holdings == t0_holdings_count + 1,
            f"Expected holdings rows +1 from T0 baseline (before={t0_holdings_count}, after={after_holdings})",
        )
        assert_true(
            after_positions == t0_positions_count + 1,
            f"Expected portfolio value rows +1 from T0 baseline (before={t0_positions_count}, after={after_positions})",
        )

        print(
            f"[T1] ok: holdings_rows {t0_holdings_count}->{after_holdings}, "
            f"portfolio_value_rows {t0_positions_count}->{after_positions}, "
            f"added_ticker={new_ticker}"
        )
        print("\n=== all assertions passed ===\n")

    finally:
        sse_stop.set()
        stop_demo_server(server_proc)


if __name__ == "__main__":
    try:
        run()
    except TestFailure as err:
        print(f"\n[ASSERT FAILED] {err}")
        raise SystemExit(1)
