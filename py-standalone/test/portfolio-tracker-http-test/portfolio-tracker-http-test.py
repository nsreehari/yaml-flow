#!/usr/bin/env python3
"""portfolio-tracker-http-test.py

E2E test for the portfolio-tracker board via HTTP + SSE.

Architecture mirrors portfolio-tracker-http-test.js:
  - background SSE consumer thread accumulates NotificationState (NS)
  - main thread drives HTTP PATCH/GET and polls NS for waits

Usage:
    python portfolio-tracker-http-test.py [--port PORT] [--server node|py]
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import subprocess
import sys
import threading
import time
import uuid
import urllib.error
import urllib.request
from pathlib import Path


HERE = Path(__file__).resolve().parent
SERVER_SCRIPT = HERE / "portfolio-tracker-server.js"
PY_SERVER_SCRIPT = HERE / "portfolio-tracker-server.py"
SSE_WORKER_SCRIPT = HERE / "portfolio-tracker-sse-worker.py"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--server", choices=["node", "py"], default="py")
    return parser.parse_args()


ARGS = parse_args()


def pick_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        return int(sock.getsockname()[1])


PORT = ARGS.port if ARGS.port is not None else pick_free_port()
RUN_ID = f"run-{int(time.time() * 1000)}-{os.getpid()}-{uuid.uuid4().hex[:6]}"
BASE = f"http://127.0.0.1:{PORT}/api/board"


class TestFailure(RuntimeError):
    pass


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise TestFailure(message)


NS_LOCK = threading.Lock()
NS = {
    "initialPayload": None,
    "statusSummary": None,
    "statusGeneration": 0,
    "dataObjects": {},
    "computedValues": {},
    "cardRefreshedCount": 0,
    "cardRefreshedByCardId": {},
}


def apply_frame(payload: dict) -> None:
    with NS_LOCK:
        if isinstance(payload, dict) and payload.get("cardDefinitions") is not None:
            NS["initialPayload"] = payload
            status = payload.get("statusSnapshot") or {}
            if isinstance(status, dict) and isinstance(status.get("summary"), dict):
                NS["statusSummary"] = status["summary"]
                NS["statusGeneration"] += 1

            dot = payload.get("dataObjectsByToken")
            if isinstance(dot, dict):
                NS["dataObjects"].update(dot)

            runtimes = payload.get("cardRuntimeById")
            if isinstance(runtimes, dict):
                for card_id, runtime in runtimes.items():
                    if not isinstance(runtime, dict):
                        continue
                    cv = runtime.get("computed_values")
                    if isinstance(cv, dict) and cv:
                        NS["computedValues"][card_id] = cv
            return

        if (
            isinstance(payload, dict)
            and payload.get("kind") == "notification-batch"
            and isinstance(payload.get("notifications"), list)
        ):
            for note in payload["notifications"]:
                if not isinstance(note, dict):
                    continue
                kind = note.get("kind")
                if kind == "status" and isinstance((note.get("status") or {}).get("summary"), dict):
                    NS["statusSummary"] = note["status"]["summary"]
                    NS["statusGeneration"] += 1
                elif kind == "data_object" and isinstance(note.get("key"), str):
                    NS["dataObjects"][note["key"]] = note.get("payload")
                elif kind == "computed_values" and isinstance(note.get("cardId"), str):
                    NS["computedValues"][note["cardId"]] = note.get("values")
                elif kind == "card_refreshed":
                    NS["cardRefreshedCount"] += 1
                    card_id = note.get("cardId")
                    if isinstance(card_id, str) and card_id:
                        NS["cardRefreshedByCardId"][card_id] = NS["cardRefreshedByCardId"].get(card_id, 0) + 1


def get_ns_snapshot() -> dict:
    with NS_LOCK:
        return {
            "initialPayload": NS["initialPayload"],
            "statusSummary": NS["statusSummary"],
            "statusGeneration": NS["statusGeneration"],
            "dataObjects": dict(NS["dataObjects"]),
            "computedValues": dict(NS["computedValues"]),
            "cardRefreshedCount": NS["cardRefreshedCount"],
            "cardRefreshedByCardId": dict(NS["cardRefreshedByCardId"]),
        }


def wait_until(predicate, timeout_s: float, label: str):
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        try:
            result = predicate()
        except Exception:
            result = None
        if result not in (None, False):
            return result
        time.sleep(0.15)

    snap = get_ns_snapshot()
    raise TestFailure(
        f"Timeout ({timeout_s}s) waiting for: {label}\n"
        f"  NS.statusSummary={json.dumps(snap['statusSummary'])}\n"
        f"  dataObjects={json.dumps(sorted(snap['dataObjects'].keys()))}"
    )


def wait_for_initial_payload(timeout_s: float = 15.0):
    return wait_until(lambda: get_ns_snapshot()["initialPayload"], timeout_s, "initial SSE payload")


def wait_for_all_completed(timeout_s: float = 60.0, label: str = "all completed"):
    def _pred():
        s = get_ns_snapshot()["statusSummary"]
        if isinstance(s, dict) and s.get("card_count", 0) > 0 and s.get("completed") == s.get("card_count"):
            return s
        return False

    return wait_until(_pred, timeout_s, label)


def wait_for_price_symbols(expected_symbols: list[str], timeout_s: float = 30.0, label: str = "price symbols"):
    expected = ",".join(sorted(expected_symbols))

    def _pred():
        prices = get_ns_snapshot()["dataObjects"].get("prices")
        if not isinstance(prices, dict):
            return False
        actual = ",".join(sorted(prices.keys()))
        return prices if actual == expected else False

    return wait_until(_pred, timeout_s, f"{label}: expected [{expected}]")


def http_json(method: str, path: str, payload: dict | None = None) -> tuple[int, object]:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers = {
            "Content-Type": "application/json",
            "Content-Length": str(len(data)),
        }

    req = urllib.request.Request(f"{BASE}{path}", data=data, method=method.upper(), headers=headers)
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


def make_holdings_patch(holdings_map: dict[str, int]) -> dict:
    return {
        "card_data": {
            "holdings": [{"symbol": symbol, "qty": qty} for symbol, qty in holdings_map.items()]
        }
    }


def start_server() -> subprocess.Popen:
    if ARGS.server == "py":
        python = sys.executable or "python"
        cmd = [python, str(PY_SERVER_SCRIPT), "--port", str(PORT), "--run-id", RUN_ID, "--reset"]
    else:
        cmd = ["node", str(SERVER_SCRIPT), "--port", str(PORT), "--reset"]

    proc = subprocess.Popen(
        cmd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    def _pump_stdout():
        assert proc.stdout is not None
        for line in proc.stdout:
            print(f"[server] {line}", end="")

    def _pump_stderr():
        assert proc.stderr is not None
        for line in proc.stderr:
            print(f"[server:err] {line}", end="", file=sys.stderr)

    threading.Thread(target=_pump_stdout, daemon=True).start()
    threading.Thread(target=_pump_stderr, daemon=True).start()

    deadline = time.monotonic() + 15
    ready = False
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            break
        try:
            with socket.create_connection(("127.0.0.1", PORT), timeout=0.5):
                ready = True
                break
        except OSError:
            time.sleep(0.2)

    if not ready:
        proc.terminate()
        raise TestFailure("Server startup timeout (15s)")

    return proc


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


def run() -> None:
    print("\n=== portfolio-tracker HTTP E2E test (python) ===")
    print(f"target: {BASE}  [server: {ARGS.server}]")
    print("architecture: main-thread (driver) + worker-process (SSE consumer)\n")

    server_proc = start_server()
    time.sleep(0.3)

    sse_worker_proc = None
    try:
        print("\n=== Step 1: init-board ===")
        status, _ = http_json("GET", "/init-board")
        assert_true(status == 200, f"init-board returned {status}")
        print("[step1] ok")

        print("\n=== Step 2: Start SSE consumer worker ===")
        sse_worker_proc = start_sse_worker()
        initial_payload = wait_for_initial_payload(15.0)
        snap = get_ns_snapshot()
        print(f"[step2] SSE online — initial payload ({len(initial_payload.get('cardDefinitions', []))} cards)")
        print(f"        statusGen={snap['statusGeneration']}, dataObjects={json.dumps(sorted(snap['dataObjects'].keys()))}")

        print("\n=== T1: Wait for initial completion ===")
        t1_summary = wait_for_all_completed(60.0, "T1 initial drain")
        print(f"[T1] board completed — {json.dumps(t1_summary)}")

        t1_prices = wait_for_price_symbols(["AAPL", "MSFT"], 30.0, "T1 prices")
        assert_true(all(isinstance(v, (int, float)) for v in t1_prices.values()), "T1: all prices must be numbers")
        t1_table = (get_ns_snapshot()["computedValues"].get("holdings-table") or {}).get("table")
        assert_true(isinstance(t1_table, dict) and isinstance(t1_table.get("rows"), list) and len(t1_table["rows"]) == 2,
                    f"T1: expected 2 rows, got {len(t1_table.get('rows', [])) if isinstance(t1_table, dict) else 'n/a'}")
        t1_total = (get_ns_snapshot()["computedValues"].get("portfolio-value") or {}).get("totalValue")
        assert_true(isinstance(t1_total, (int, float)) and t1_total > 0, f"T1: totalValue must be positive, got {t1_total}")
        print(f"[T1] passed: prices=[AAPL,MSFT], rows=2, totalValue={float(t1_total):.2f}")

        print("\n=== T2a: Update holdings — add GOOG ===")
        t2_card_refreshed_before = get_ns_snapshot()["cardRefreshedCount"]
        status, _ = http_json("PATCH", "/cards/portfolio-form", make_holdings_patch({"AAPL": 50, "MSFT": 30, "GOOG": 100}))
        assert_true(status == 200, f"PATCH portfolio-form returned {status}")
        print("[T2a] PATCH ok — consumer will receive SSE notifications")

        print("\n=== T2b: Wait for 3-ticker completion ===")
        t2_summary = wait_for_all_completed(60.0, "T2b 3-ticker drain")
        print(f"[T2b] completed — {json.dumps(t2_summary)}")

        wait_for_price_symbols(["AAPL", "GOOG", "MSFT"], 30.0, "T2b prices")
        t2_card_refreshed_after = get_ns_snapshot()["cardRefreshedCount"]
        assert_true(
            t2_card_refreshed_after > t2_card_refreshed_before,
            (
                "T2b: expected at least one card_refreshed notification after PATCH "
                f"(before={t2_card_refreshed_before}, after={t2_card_refreshed_after})"
            ),
        )
        t2_table = (get_ns_snapshot()["computedValues"].get("holdings-table") or {}).get("table")
        assert_true(isinstance(t2_table, dict) and isinstance(t2_table.get("rows"), list) and len(t2_table["rows"]) == 3,
                    f"T2b: expected 3 rows, got {len(t2_table.get('rows', [])) if isinstance(t2_table, dict) else 'n/a'}")
        t2_total = (get_ns_snapshot()["computedValues"].get("portfolio-value") or {}).get("totalValue")
        assert_true(isinstance(t2_total, (int, float)) and t2_total > 0, "T2b: totalValue must be positive")
        print(f"[T2b] passed: prices=[AAPL,GOOG,MSFT], rows=3, totalValue={float(t2_total):.2f}")

        print("\n=== T3: Rapid 3x holdings updates ===")
        rapid_updates = [
            {"AAPL": 45, "MSFT": 30, "GOOG": 110, "TSLA": 60},
            {"AAPL": 45, "MSFT": 30, "GOOG": 110, "AMZN": 100},
            {"AAPL": 40, "MSFT": 35, "GOOG": 120, "TSLA": 70},
        ]
        for holdings in rapid_updates:
            http_json("PATCH", "/cards/portfolio-form", make_holdings_patch(holdings))
        print("[T3] rapid PATCHes sent — SSE state continues to accumulate")

        wait_for_all_completed(60.0, "T3 rapid-update drain")
        t3_prices = wait_for_price_symbols(["AAPL", "GOOG", "MSFT", "TSLA"], 30.0, "T3 final prices")
        t3_table = (get_ns_snapshot()["computedValues"].get("holdings-table") or {}).get("table")
        assert_true(isinstance(t3_table, dict) and isinstance(t3_table.get("rows"), list) and len(t3_table["rows"]) == 4,
                    f"T3: expected 4 rows, got {len(t3_table.get('rows', [])) if isinstance(t3_table, dict) else 'n/a'}")
        assert_true("AMZN" not in t3_prices, f"T3: AMZN must not be present (got {json.dumps(sorted(t3_prices.keys()))})")
        print(f"[T3] passed: prices={json.dumps(sorted(t3_prices.keys()))}, rows=4, AMZN absent")

        print("\n=== T4: Cross-verify totalValue ===")
        t4_total = (get_ns_snapshot()["computedValues"].get("portfolio-value") or {}).get("totalValue")
        assert_true(isinstance(t4_total, (int, float)) and t4_total > 0, f"T4: totalValue must be positive, got {t4_total}")
        sum_rows = sum(float(r.get("value", 0)) for r in t3_table["rows"])
        assert_true(abs(sum_rows - float(t4_total)) < 0.01, f"T4: mismatch: sumRows={sum_rows}, totalValue={t4_total}")
        print(f"[T4] passed: totalValue={float(t4_total):.2f}, sumRows={sum_rows:.2f}")

        print("\n=== T5: board-status HTTP cross-check ===")
        status, t5_body = http_json("GET", "/board-status")
        assert_true(status == 200, f"board-status returned {status}")
        assert_true(isinstance(t5_body, dict), "T5: board-status body is not JSON object")
        t5_summary = ((t5_body.get("statusSnapshot") or {}).get("summary") if isinstance(t5_body, dict) else None)
        assert_true(isinstance(t5_summary, dict), "T5: statusSnapshot.summary missing from board-status")
        assert_true(t5_summary.get("completed") == t5_summary.get("card_count"),
                    f"T5: completed={t5_summary.get('completed')} != card_count={t5_summary.get('card_count')}")
        assert_true(t5_summary.get("failed") == 0, f"T5: failed={t5_summary.get('failed')} (expected 0)")

        http_keys = sorted(((t5_body.get("dataObjectsByToken") or {}).keys()))
        worker_keys = sorted(get_ns_snapshot()["dataObjects"].keys())
        assert_true(http_keys == worker_keys,
                    f"T5: HTTP dataObjects keys {http_keys} differ from SSE-accumulated {worker_keys}")

        print(f"[T5] summary: {json.dumps(t5_summary)}")
        print(f"[T5] HTTP vs SSE dataObjects agree: {json.dumps(worker_keys)}")
        print(f"[T5] statusGen at end: {get_ns_snapshot()['statusGeneration']}")
        print("[T5] all assertions passed")

        print("\n=== All tests passed ===\n")

    finally:
        if sse_worker_proc is not None:
            sse_worker_proc.terminate()
            try:
                sse_worker_proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                sse_worker_proc.kill()
                sse_worker_proc.wait(timeout=5)
        server_proc.terminate()
        try:
            server_proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            server_proc.kill()
            server_proc.wait(timeout=5)
        print(f"[portfolio-tracker-http-test.py] server stopped ({ARGS.server})")


if __name__ == "__main__":
    try:
        run()
    except TestFailure as e:
        print(f"\n[ASSERT FAILED] {e}", file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        sys.exit(130)