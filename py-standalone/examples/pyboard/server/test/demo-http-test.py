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
import base64
import json
import os
import random
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path


HERE = Path(__file__).resolve().parent
SERVER_DIR = HERE.parent
SERVER_SCRIPT = SERVER_DIR / "py-demo-server.py"
SSE_WORKER_SCRIPT = HERE / "demo-sse-worker.py"


class TestFailure(RuntimeError):
    pass


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise TestFailure(message)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--board-id", default="demo-http-test")
    parser.add_argument("--testing-pattern", default="cardT*.json")
    return parser.parse_args()


ARGS = parse_args()
RUN_ID = f"run-{int(time.time() * 1000)}-{os.getpid()}-{uuid.uuid4().hex[:6]}"


def pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return int(sock.getsockname()[1])


def serialize_ref(ref: dict[str, str]) -> str:
    payload = json.dumps({"kind": ref["kind"], "value": ref["value"]}, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    encoded = base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")
    return f"b64:{encoded}"


RUN_ROOT_DIR = Path(tempfile.gettempdir()) / "py-demo-http-test" / RUN_ID
DEMO_SETUP_DIR = RUN_ROOT_DIR / "setup"
DEMO_SERVER_META_DIR = RUN_ROOT_DIR / "server-meta"
ARGS.port = ARGS.port if ARGS.port is not None else pick_free_port()
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


def start_sse_worker() -> subprocess.Popen:
    proc = subprocess.Popen(
        [sys.executable, str(SSE_WORKER_SCRIPT), "--sse-url", f"{BASE}/sse"],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    def _pump_stdout() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            text = line.strip()
            if not text:
                continue
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                continue
            msg_type = msg.get("type")
            if msg_type == "frame" and isinstance(msg.get("payload"), dict):
                apply_frame(msg["payload"])
            elif msg_type == "error":
                print(f"[sse-worker] {msg.get('message')}", file=sys.stderr)
            elif msg_type == "closed":
                print("[sse-worker] SSE stream closed by server")

    def _pump_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            print(f"[sse-worker:err] {line}", end="", file=sys.stderr)

    threading.Thread(target=_pump_stdout, daemon=True).start()
    threading.Thread(target=_pump_stderr, daemon=True).start()
    return proc


def reset_server_state_dirs() -> None:
    shutil.rmtree(RUN_ROOT_DIR, ignore_errors=True)


def start_demo_server() -> subprocess.Popen:
    env = os.environ.copy()
    env["DEMO_SERVER_PORT"] = str(ARGS.port)
    env["DEMO_SETUP_DIR"] = str(DEMO_SETUP_DIR)
    env["DEMO_SERVER_META_STORE_REF"] = serialize_ref({"kind": "fs-path", "value": str(DEMO_SERVER_META_DIR)})
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


def get_positions_count() -> int:
    status, body = http_json("GET", f"{BASE}/board-status")
    assert_true(status == 200, f"board-status returned {status}")
    assert_true(isinstance(body, dict), "board-status body is not JSON")

    runtime = body.get("cardRuntimeById") if isinstance(body.get("cardRuntimeById"), dict) else {}

    value_rt = runtime.get("card-portfolio-value") if isinstance(runtime.get("card-portfolio-value"), dict) else {}
    positions = (value_rt.get("computed_values") or {}).get("positions")
    return len(positions) if isinstance(positions, list) else 0


def get_holdings_count_from_card() -> int:
    status, body = http_json("GET", f"{BASE}/cards/card-portfolio")
    assert_true(status == 200, f"GET card-portfolio returned {status}")
    assert_true(isinstance(body, dict), "card-portfolio response is not JSON")

    holdings = (body.get("card_data") or {}).get("holdings")
    assert_true(isinstance(holdings, list), "card-portfolio.card_data.holdings missing")
    return len(holdings)


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
    sse_worker_proc = None

    try:
        status, _ = http_json("POST", BOARDS_BASE, {"id": ARGS.board_id, "label": "Demo HTTP Test"})
        assert_true(status in (200, 409), f"board register returned {status}")

        sse_worker_proc = start_sse_worker()

        print("\n=== T0: init/bootstrap ===")
        status, _ = http_json("GET", f"{BASE}/init-board")
        assert_true(status == 200, f"init-board returned {status}")

        swait_for_completion(30.0, "T0 init/bootstrap")
        t0_summary = wait_for_status_completed_all(2.0, "T0 init/bootstrap")
        print(f"[T0] ok: completed-all, card_count={t0_summary.get('card_count')}")

        # Allow state to settle before reading T0 baseline
        time.sleep(1.0)
        t0_holdings_count = get_holdings_count_from_card()
        t0_positions_count = get_positions_count()

        print("\n=== T1: patch holdings (+1 row) ===")
        status, body = http_json("GET", f"{BASE}/cards/card-portfolio")
        assert_true(status == 200 and isinstance(body, dict), "Cannot read card-portfolio for patch baseline")
        existing_holdings = (body.get("card_data") or {}).get("holdings")
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

        after_holdings = get_holdings_count_from_card()
        after_positions = get_positions_count()
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
        if sse_worker_proc is not None:
            sse_worker_proc.terminate()
            try:
                sse_worker_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                sse_worker_proc.kill()
                sse_worker_proc.wait(timeout=5)
        stop_demo_server(server_proc)


if __name__ == "__main__":
    try:
        run()
    except TestFailure as err:
        print(f"\n[ASSERT FAILED] {err}")
        raise SystemExit(1)
