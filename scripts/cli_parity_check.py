#!/usr/bin/env python3
from __future__ import annotations

import base64
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Tuple


@dataclass
class CmdResult:
    code: int
    stdout: str
    stderr: str


def _run(
    cmd: List[str],
    *,
    stdin_text: str | None = None,
    cwd: Path,
    timeout_s: float | None = None,
) -> CmdResult:
    proc = subprocess.run(
        cmd,
        cwd=str(cwd),
        input=stdin_text,
        text=True,
        capture_output=True,
        shell=False,
        timeout=timeout_s,
    )
    return CmdResult(proc.returncode, proc.stdout, proc.stderr)


def _assert_equal(label: str, left: Any, right: Any) -> None:
    if left != right:
        raise AssertionError(f"{label} mismatch\nLEFT: {left!r}\nRIGHT: {right!r}")


def _fs_ref(p: str) -> str:
    payload = json.dumps({"kind": "fs-path", "value": p}, separators=(",", ":")).encode("utf-8")
    return "b64:" + base64.urlsafe_b64encode(payload).decode("ascii").rstrip("=")


def _parse_json_or_text(s: str) -> Any:
    text = s.strip()
    if not text:
        return ""
    try:
        return json.loads(text)
    except Exception:
        return text


def _normalize_obj(obj: Any) -> Any:
    if isinstance(obj, str):
        # Normalize ISO-like timestamps to avoid false diffs in parity checks.
        if re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$", obj):
            return "<timestamp>"
        return obj
    if isinstance(obj, dict):
        out: Dict[str, Any] = {}
        for k, v in obj.items():
            if k == "updatedAt" and isinstance(v, str):
                out[k] = "<timestamp>"
            else:
                out[k] = _normalize_obj(v)
        return out
    if isinstance(obj, list):
        return [_normalize_obj(v) for v in obj]
    return obj


def _normalize_stream(text: str) -> Any:
    return _normalize_obj(_parse_json_or_text(text))


def _normalize_stream_with_replacements(text: str, replacements: List[Tuple[str, str]]) -> Any:
    replaced = text
    for src, dst in replacements:
        replaced = replaced.replace(src, dst)
        replaced = replaced.replace(src.replace("\\", "\\\\"), dst)
        replaced = replaced.replace(src.replace("\\", "/"), dst)
        replaced = replaced.replace(src.replace("/", "\\"), dst)
    return _normalize_obj(_parse_json_or_text(replaced))


def _normalize_validate_result(text: str) -> Any:
    """Normalize a validate-card/validate-tmp-card response for structural comparison.

    TS uses AJV (JSON Pointer–style paths); Python uses hand-written messages.
    We compare isValid + whether issues is empty — not exact wording.
    """
    obj = _parse_json_or_text(text.strip())
    if not isinstance(obj, dict):
        return obj

    def _norm_item(item: Any) -> Any:
        if not isinstance(item, dict) or "issues" not in item:
            return item
        issues = item["issues"]
        return {**item, "issues": "<has-issues>" if issues else []}

    data = obj.get("data")
    if isinstance(data, list):
        return {**obj, "data": [_norm_item(i) for i in data]}
    if isinstance(data, dict):
        return {**obj, "data": _norm_item(data)}
    return obj


def _assert_validate_cmd_parity(label: str, left: CmdResult, right: CmdResult) -> None:
    _assert_equal(f"{label} exit code", left.code, right.code)
    _assert_equal(f"{label} stdout", _normalize_validate_result(left.stdout), _normalize_validate_result(right.stdout))
    _assert_equal(f"{label} stderr", _normalize_stream(left.stderr), _normalize_stream(right.stderr))


def _snapshot_dir(root: Path) -> Dict[str, Any]:
    result: Dict[str, Any] = {}
    if not root.exists():
        return result
    for p in sorted(root.rglob("*")):
        if not p.is_file():
            continue
        rel = p.relative_to(root).as_posix()
        try:
            parsed = json.loads(p.read_text(encoding="utf-8"))
            result[rel] = {"json": _normalize_obj(parsed)}
            continue
        except Exception:
            pass
        data = p.read_bytes()
        result[rel] = {"b64": base64.b64encode(data).decode("ascii")}
    return result


def _node_card_cmd(repo_root: Path, node: str, args: List[str]) -> List[str]:
    return [node, str(repo_root / "card-store.js"), *args]


def _py_card_cmd(repo_root: Path, py: str, args: List[str]) -> List[str]:
    return [py, str(repo_root / "pycli" / "main" / "card_store_pycli.py"), *args]


def _node_artifacts_cmd(repo_root: Path, node: str, args: List[str]) -> List[str]:
    tsx = repo_root / "node_modules" / "tsx" / "dist" / "cli.mjs"
    cli_ts = repo_root / "src" / "cli" / "node" / "artifacts-store-cli.ts"
    return [node, str(tsx), str(cli_ts), *args]


def _py_artifacts_cmd(repo_root: Path, py: str, args: List[str]) -> List[str]:
    return [py, str(repo_root / "pycli" / "main" / "artifacts_store_pycli.py"), *args]


def _node_board_cmd(repo_root: Path, node: str, args: List[str]) -> List[str]:
    return [node, str(repo_root / "board-live-cards-cli.js"), *args]


def _py_board_cmd(repo_root: Path, py: str, args: List[str]) -> List[str]:
    return [py, str(repo_root / "pycli" / "main" / "board_live_cards_pycli.py"), *args]


def _assert_cmd_parity(label: str, left: CmdResult, right: CmdResult) -> None:
    _assert_equal(f"{label} exit code", left.code, right.code)
    _assert_equal(f"{label} stdout", _normalize_stream(left.stdout), _normalize_stream(right.stdout))
    _assert_equal(f"{label} stderr", _normalize_stream(left.stderr), _normalize_stream(right.stderr))


def _assert_cmd_parity_replaced(
    label: str,
    left: CmdResult,
    right: CmdResult,
    *,
    left_replacements: List[Tuple[str, str]],
    right_replacements: List[Tuple[str, str]],
) -> None:
    _assert_equal(f"{label} exit code", left.code, right.code)
    _assert_equal(
        f"{label} stdout",
        _normalize_stream_with_replacements(left.stdout, left_replacements),
        _normalize_stream_with_replacements(right.stdout, right_replacements),
    )
    _assert_equal(
        f"{label} stderr",
        _normalize_stream_with_replacements(left.stderr, left_replacements),
        _normalize_stream_with_replacements(right.stderr, right_replacements),
    )


def run_card_store_parity(repo_root: Path, node: str, py: str) -> None:
    with tempfile.TemporaryDirectory(prefix="card-node-") as n_dir, tempfile.TemporaryDirectory(prefix="card-py-") as p_dir:
        n_ref = _fs_ref(n_dir)
        p_ref = _fs_ref(p_dir)

        # set
        payload = json.dumps({"id": "card-1", "card_data": {"n": 1}})
        n = _run(_node_card_cmd(repo_root, node, ["set", "--store-ref", n_ref]), stdin_text=payload, cwd=repo_root)
        p = _run(_py_card_cmd(repo_root, py, ["set", "--store-ref", p_ref]), stdin_text=payload, cwd=repo_root)
        _assert_cmd_parity("card set", n, p)

        # get all
        n = _run(_node_card_cmd(repo_root, node, ["get", "--store-ref", n_ref]), cwd=repo_root)
        p = _run(_py_card_cmd(repo_root, py, ["get", "--store-ref", p_ref]), cwd=repo_root)
        _assert_cmd_parity("card get all", n, p)

        # patch
        n = _run(
            _node_card_cmd(
                repo_root,
                node,
                ["patch", "--store-ref", n_ref, "--id", "card-1", "--path", "card_data.n", "--value-json", "2"],
            ),
            cwd=repo_root,
        )
        p = _run(
            _py_card_cmd(
                repo_root,
                py,
                ["patch", "--store-ref", p_ref, "--id", "card-1", "--path", "card_data.n", "--value-json", "2"],
            ),
            cwd=repo_root,
        )
        _assert_cmd_parity("card patch", n, p)

        # get by id
        n = _run(_node_card_cmd(repo_root, node, ["get", "--store-ref", n_ref, "--id", "card-1"]), cwd=repo_root)
        p = _run(_py_card_cmd(repo_root, py, ["get", "--store-ref", p_ref, "--id", "card-1"]), cwd=repo_root)
        _assert_cmd_parity("card get by id", n, p)

        # del
        n = _run(_node_card_cmd(repo_root, node, ["del", "--store-ref", n_ref, "--id", "card-1"]), cwd=repo_root)
        p = _run(_py_card_cmd(repo_root, py, ["del", "--store-ref", p_ref, "--id", "card-1"]), cwd=repo_root)
        _assert_cmd_parity("card del", n, p)

        # final store snapshot
        _assert_equal("card store snapshot", _snapshot_dir(Path(n_dir)), _snapshot_dir(Path(p_dir)))


def run_artifacts_store_parity(repo_root: Path, node: str, py: str) -> None:
    with tempfile.TemporaryDirectory(prefix="art-node-") as n_dir, tempfile.TemporaryDirectory(prefix="art-py-") as p_dir:
        n_ref = _fs_ref(n_dir)
        p_ref = _fs_ref(p_dir)

        # put text
        put_args = ["put", "--store-ref", "{ref}", "--key", "k1.txt", "--text", "hello", "--content-type", "text/plain"]
        n = _run(_node_artifacts_cmd(repo_root, node, [a if a != "{ref}" else n_ref for a in put_args]), cwd=repo_root)
        p = _run(_py_artifacts_cmd(repo_root, py, [a if a != "{ref}" else p_ref for a in put_args]), cwd=repo_root)
        _assert_cmd_parity("artifacts put text", n, p)

        # head
        n = _run(_node_artifacts_cmd(repo_root, node, ["head", "--store-ref", n_ref, "--key", "k1.txt"]), cwd=repo_root)
        p = _run(_py_artifacts_cmd(repo_root, py, ["head", "--store-ref", p_ref, "--key", "k1.txt"]), cwd=repo_root)
        _assert_cmd_parity("artifacts head", n, p)

        # list
        n = _run(_node_artifacts_cmd(repo_root, node, ["list", "--store-ref", n_ref]), cwd=repo_root)
        p = _run(_py_artifacts_cmd(repo_root, py, ["list", "--store-ref", p_ref]), cwd=repo_root)
        _assert_cmd_parity("artifacts list", n, p)

        # get text
        n = _run(_node_artifacts_cmd(repo_root, node, ["get", "--store-ref", n_ref, "--key", "k1.txt", "--as", "text"]), cwd=repo_root)
        p = _run(_py_artifacts_cmd(repo_root, py, ["get", "--store-ref", p_ref, "--key", "k1.txt", "--as", "text"]), cwd=repo_root)
        _assert_cmd_parity("artifacts get text", n, p)

        # put bytes via stdin
        n = _run(_node_artifacts_cmd(repo_root, node, ["put", "--store-ref", n_ref, "--key", "bin/k2.bin"]), stdin_text="abc", cwd=repo_root)
        p = _run(_py_artifacts_cmd(repo_root, py, ["put", "--store-ref", p_ref, "--key", "bin/k2.bin"]), stdin_text="abc", cwd=repo_root)
        _assert_cmd_parity("artifacts put bytes", n, p)

        # get bytes summary
        n = _run(_node_artifacts_cmd(repo_root, node, ["get", "--store-ref", n_ref, "--key", "bin/k2.bin"]), cwd=repo_root)
        p = _run(_py_artifacts_cmd(repo_root, py, ["get", "--store-ref", p_ref, "--key", "bin/k2.bin"]), cwd=repo_root)
        _assert_cmd_parity("artifacts get bytes", n, p)

        # delete and final list
        n = _run(_node_artifacts_cmd(repo_root, node, ["del", "--store-ref", n_ref, "--key", "k1.txt"]), cwd=repo_root)
        p = _run(_py_artifacts_cmd(repo_root, py, ["del", "--store-ref", p_ref, "--key", "k1.txt"]), cwd=repo_root)
        _assert_cmd_parity("artifacts del", n, p)

        n = _run(_node_artifacts_cmd(repo_root, node, ["list", "--store-ref", n_ref]), cwd=repo_root)
        p = _run(_py_artifacts_cmd(repo_root, py, ["list", "--store-ref", p_ref]), cwd=repo_root)
        _assert_cmd_parity("artifacts list after del", n, p)

        _assert_equal("artifacts store snapshot", _snapshot_dir(Path(n_dir)), _snapshot_dir(Path(p_dir)))


def _pick_board_python(repo_root: Path, default_py: str) -> str | None:
    env_py = os.environ.get("CLI_PARITY_BOARD_PYTHON")
    candidates = [
        env_py,
        default_py,
    ]
    for cand in candidates:
        if not cand:
            continue
        if not Path(cand).exists() and os.path.sep in cand:
            continue
        # Verify the native bridge is importable
        probe = _run(
            [cand, "-c", "import sys, os; sys.path.insert(0, os.path.join(r'" + str(repo_root) + "', 'pycli')); from sub.board_live_cards_native_bridge import invoke_board_command_native"],
            cwd=repo_root,
        )
        if probe.code == 0:
            return cand
    return None


def run_board_live_cards_parity(repo_root: Path, node: str, py_for_board: str) -> None:
    with tempfile.TemporaryDirectory(prefix="board-node-") as n_base, tempfile.TemporaryDirectory(prefix="board-py-") as p_base:
        n_board = Path(n_base) / "board"
        n_cards = Path(n_base) / "cards"
        n_out = Path(n_base) / "outputs"
        p_board = Path(p_base) / "board"
        p_cards = Path(p_base) / "cards"
        p_out = Path(p_base) / "outputs"
        for d in (n_board, n_cards, n_out, p_board, p_cards, p_out):
            d.mkdir(parents=True, exist_ok=True)

        n_board_ref = _fs_ref(str(n_board))
        n_cards_ref = _fs_ref(str(n_cards))
        n_out_ref = _fs_ref(str(n_out))
        p_board_ref = _fs_ref(str(p_board))
        p_cards_ref = _fs_ref(str(p_cards))
        p_out_ref = _fs_ref(str(p_out))

        n_rep = [
            (str(n_board), "<BASE_BOARD>"),
            (str(n_cards), "<BASE_CARDS>"),
            (str(n_out), "<BASE_OUT>"),
        ]
        p_rep = [
            (str(p_board), "<BASE_BOARD>"),
            (str(p_cards), "<BASE_CARDS>"),
            (str(p_out), "<BASE_OUT>"),
        ]

        card_payload = json.dumps(
            {
                "id": "portfolio-form",
                "meta": {"title": "Portfolio Holdings Form"},
                "provides": [{"bindTo": "holdings", "ref": "card_data.holdings"}],
                "card_data": {"holdings": [{"symbol": "AAPL", "qty": 2}]},
                "view": {
                    "elements": [
                        {
                            "kind": "table",
                            "label": "Holdings",
                            "data": {"bind": "card_data.holdings", "columns": ["symbol", "qty"]},
                        }
                    ]
                },
            }
        )

        # Seed card stores with their corresponding CLIs.
        n = _run(_node_card_cmd(repo_root, node, ["set", "--store-ref", n_cards_ref]), stdin_text=card_payload, cwd=repo_root)
        p = _run(_py_card_cmd(repo_root, py_for_board, ["set", "--store-ref", p_cards_ref]), stdin_text=card_payload, cwd=repo_root)
        _assert_cmd_parity("board pre-seed card store", n, p)

        body = json.dumps({})
        n = _run(
            _node_board_cmd(
                repo_root,
                node,
                ["init", "--base-ref", n_board_ref, "--card-store-ref", n_cards_ref, "--outputs-store-ref", n_out_ref],
            ),
            stdin_text=body,
            cwd=repo_root,
        )
        p = _run(
            _py_board_cmd(
                repo_root,
                py_for_board,
                ["init", "--base-ref", p_board_ref, "--card-store-ref", p_cards_ref, "--outputs-store-ref", p_out_ref],
            ),
            stdin_text=body,
            cwd=repo_root,
        )
        _assert_cmd_parity_replaced("board init", n, p, left_replacements=n_rep, right_replacements=p_rep)

        n = _run(_node_board_cmd(repo_root, node, ["status", "--base-ref", n_board_ref]), cwd=repo_root)
        p = _run(_py_board_cmd(repo_root, py_for_board, ["status", "--base-ref", p_board_ref]), cwd=repo_root)
        _assert_cmd_parity_replaced("board status", n, p, left_replacements=n_rep, right_replacements=p_rep)

        n = _run(_node_board_cmd(repo_root, node, ["upsert-card", "--base-ref", n_board_ref, "--card-id", "portfolio-form"]), cwd=repo_root)
        p = _run(_py_board_cmd(repo_root, py_for_board, ["upsert-card", "--base-ref", p_board_ref, "--card-id", "portfolio-form"]), cwd=repo_root)
        _assert_cmd_parity_replaced("board upsert-card", n, p, left_replacements=n_rep, right_replacements=p_rep)

        n = _run(
            _node_board_cmd(repo_root, node, ["get-outputs", "--base-ref", n_board_ref, "--type", "data-object", "--all"]),
            cwd=repo_root,
        )
        p = _run(
            _py_board_cmd(repo_root, py_for_board, ["get-outputs", "--base-ref", p_board_ref, "--type", "data-object", "--all"]),
            cwd=repo_root,
        )
        _assert_cmd_parity_replaced("board get-outputs --all", n, p, left_replacements=n_rep, right_replacements=p_rep)

        n = _run(_node_board_cmd(repo_root, node, ["status", "--base-ref", n_board_ref]), cwd=repo_root)
        p = _run(_py_board_cmd(repo_root, py_for_board, ["status", "--base-ref", p_board_ref]), cwd=repo_root)
        _assert_cmd_parity_replaced("board status after upsert", n, p, left_replacements=n_rep, right_replacements=p_rep)

        # validate-card --card-id
        n = _run(
            _node_board_cmd(repo_root, node, ["validate-card", "--base-ref", n_board_ref, "--card-id", "portfolio-form"]),
            cwd=repo_root,
        )
        p = _run(
            _py_board_cmd(repo_root, py_for_board, ["validate-card", "--base-ref", p_board_ref, "--card-id", "portfolio-form"]),
            cwd=repo_root,
        )
        _assert_validate_cmd_parity("board validate-card --card-id", n, p)

        # validate-card --all
        n = _run(
            _node_board_cmd(repo_root, node, ["validate-card", "--base-ref", n_board_ref, "--all"]),
            cwd=repo_root,
        )
        p = _run(
            _py_board_cmd(repo_root, py_for_board, ["validate-card", "--base-ref", p_board_ref, "--all"]),
            cwd=repo_root,
        )
        _assert_validate_cmd_parity("board validate-card --all", n, p)

        # validate-card --card-id not found
        n = _run(
            _node_board_cmd(repo_root, node, ["validate-card", "--base-ref", n_board_ref, "--card-id", "does-not-exist"]),
            cwd=repo_root,
        )
        p = _run(
            _py_board_cmd(repo_root, py_for_board, ["validate-card", "--base-ref", p_board_ref, "--card-id", "does-not-exist"]),
            cwd=repo_root,
        )
        _assert_validate_cmd_parity("board validate-card --card-id not found", n, p)

        # validate-tmp-card (valid card via stdin)
        tmp_card_payload = json.dumps({"card-content": json.loads(card_payload)})
        n = _run(
            _node_board_cmd(repo_root, node, ["validate-tmp-card"]),
            stdin_text=tmp_card_payload,
            cwd=repo_root,
        )
        p = _run(
            _py_board_cmd(repo_root, py_for_board, ["validate-tmp-card"]),
            stdin_text=tmp_card_payload,
            cwd=repo_root,
        )
        _assert_validate_cmd_parity("board validate-tmp-card (valid)", n, p)

        # validate-tmp-card (invalid card via stdin — bad kind, missing card_data)
        invalid_card_payload = json.dumps({"card-content": {"id": "bad-card", "card_data": {}, "view": {"elements": [{"kind": "not-a-real-kind"}]}}})
        n = _run(
            _node_board_cmd(repo_root, node, ["validate-tmp-card"]),
            stdin_text=invalid_card_payload,
            cwd=repo_root,
        )
        p = _run(
            _py_board_cmd(repo_root, py_for_board, ["validate-tmp-card"]),
            stdin_text=invalid_card_payload,
            cwd=repo_root,
        )
        _assert_validate_cmd_parity("board validate-tmp-card (invalid)", n, p)

        # get-card-store-ref
        n = _run(_node_board_cmd(repo_root, node, ["get-card-store-ref", "--base-ref", n_board_ref]), cwd=repo_root)
        p = _run(_py_board_cmd(repo_root, py_for_board, ["get-card-store-ref", "--base-ref", p_board_ref]), cwd=repo_root)
        _assert_cmd_parity_replaced("board get-card-store-ref", n, p, left_replacements=n_rep, right_replacements=p_rep)

        # get-outputs-store-ref
        n = _run(_node_board_cmd(repo_root, node, ["get-outputs-store-ref", "--base-ref", n_board_ref]), cwd=repo_root)
        p = _run(_py_board_cmd(repo_root, py_for_board, ["get-outputs-store-ref", "--base-ref", p_board_ref]), cwd=repo_root)
        _assert_cmd_parity_replaced("board get-outputs-store-ref", n, p, left_replacements=n_rep, right_replacements=p_rep)

        # get-outputs --type computed-values --all
        n = _run(
            _node_board_cmd(repo_root, node, ["get-outputs", "--base-ref", n_board_ref, "--type", "computed-values", "--all"]),
            cwd=repo_root,
        )
        p = _run(
            _py_board_cmd(repo_root, py_for_board, ["get-outputs", "--base-ref", p_board_ref, "--type", "computed-values", "--all"]),
            cwd=repo_root,
        )
        _assert_cmd_parity("board get-outputs --type computed-values --all", n, p)

        # process-accumulated-events
        n = _run(_node_board_cmd(repo_root, node, ["process-accumulated-events", "--base-ref", n_board_ref]), cwd=repo_root)
        p = _run(_py_board_cmd(repo_root, py_for_board, ["process-accumulated-events", "--base-ref", p_board_ref]), cwd=repo_root)
        _assert_cmd_parity("board process-accumulated-events", n, p)

        # upsert-card --all
        n = _run(_node_board_cmd(repo_root, node, ["upsert-card", "--base-ref", n_board_ref, "--all"]), cwd=repo_root)
        p = _run(_py_board_cmd(repo_root, py_for_board, ["upsert-card", "--base-ref", p_board_ref, "--all"]), cwd=repo_root)
        _assert_cmd_parity_replaced("board upsert-card --all", n, p, left_replacements=n_rep, right_replacements=p_rep)

        # remove-card
        n = _run(_node_board_cmd(repo_root, node, ["remove-card", "--base-ref", n_board_ref, "--id", "portfolio-form"]), cwd=repo_root)
        p = _run(_py_board_cmd(repo_root, py_for_board, ["remove-card", "--base-ref", p_board_ref, "--id", "portfolio-form"]), cwd=repo_root)
        _assert_cmd_parity("board remove-card", n, p)

        # retrigger (card was just removed — tests the not-found error path)
        n = _run(_node_board_cmd(repo_root, node, ["retrigger", "--base-ref", n_board_ref, "--id", "portfolio-form"]), cwd=repo_root)
        p = _run(_py_board_cmd(repo_root, py_for_board, ["retrigger", "--base-ref", p_board_ref, "--id", "portfolio-form"]), cwd=repo_root)
        _assert_cmd_parity("board retrigger (not found)", n, p)

        # describe-task-executor-capabilities (no executor registered — error path)
        n = _run(_node_board_cmd(repo_root, node, ["describe-task-executor-capabilities", "--base-ref", n_board_ref]), cwd=repo_root)
        p = _run(_py_board_cmd(repo_root, py_for_board, ["describe-task-executor-capabilities", "--base-ref", p_board_ref]), cwd=repo_root)
        _assert_cmd_parity("board describe-task-executor-capabilities (no executor)", n, p)

        # probe-source (card not found — error path)
        n = _run(
            _node_board_cmd(repo_root, node, ["probe-source", "--base-ref", n_board_ref, "--card-id", "does-not-exist", "--source-idx", "0"]),
            cwd=repo_root,
        )
        p = _run(
            _py_board_cmd(repo_root, py_for_board, ["probe-source", "--base-ref", p_board_ref, "--card-id", "does-not-exist", "--source-idx", "0"]),
            cwd=repo_root,
        )
        _assert_cmd_parity("board probe-source (card not found)", n, p)

        # probe-tmp-source (missing source-def — error path)
        bad_probe_body = json.dumps({"mock-projections": {}})
        n = _run(
            _node_board_cmd(repo_root, node, ["probe-tmp-source", "--out-ref", _fs_ref(str(n_board / "probe-out.json"))]),
            stdin_text=bad_probe_body,
            cwd=repo_root,
        )
        p = _run(
            _py_board_cmd(repo_root, py_for_board, ["probe-tmp-source", "--out-ref", _fs_ref(str(p_board / "probe-out.json"))]),
            stdin_text=bad_probe_body,
            cwd=repo_root,
        )
        _assert_cmd_parity("board probe-tmp-source (missing source-def)", n, p)


def run_portfolio_tracker_dual_mode_parity(repo_root: Path, py_for_board: str) -> None:
    tracker = repo_root / "examples" / "browser" / "boards" / "portfolio-tracker" / "portfolio-tracker.py"
    if not tracker.exists():
        raise AssertionError("portfolio tracker script not found")

    timeout_s = float(os.environ.get("CLI_PARITY_PORTFOLIO_TIMEOUT_S", "60"))

    node_run = _run([py_for_board, str(tracker), "--run-nodecli"], cwd=repo_root, timeout_s=timeout_s)
    py_run = _run([py_for_board, str(tracker), "--run-pycli"], cwd=repo_root, timeout_s=timeout_s)

    if node_run.code != 0:
        raise AssertionError(
            "portfolio tracker --run-nodecli failed\n"
            f"STDOUT:\n{node_run.stdout}\nSTDERR:\n{node_run.stderr}"
        )
    if py_run.code != 0:
        raise AssertionError(
            "portfolio tracker --run-pycli failed\n"
            f"STDOUT:\n{py_run.stdout}\nSTDERR:\n{py_run.stderr}"
        )

    # Soft output sanity checks; script has its own assertions and exits non-zero on failure.
    if "[T3] assertions passed" not in node_run.stdout:
        raise AssertionError("portfolio tracker --run-nodecli did not report T3 assertions pass")
    if "[T3] assertions passed" not in py_run.stdout:
        raise AssertionError("portfolio tracker --run-pycli did not report T3 assertions pass")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--include-portfolio",
        action="store_true",
        help="Run heavy portfolio dual-mode parity in addition to CLI parity checks",
    )
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]

    node = shutil.which("node")
    if not node:
        print("[FAIL] node not found on PATH", file=sys.stderr)
        return 2

    py = sys.executable
    if not py:
        print("[FAIL] python executable unavailable", file=sys.stderr)
        return 2

    board_py = _pick_board_python(repo_root, py)
    include_portfolio = args.include_portfolio or (os.environ.get("CLI_PARITY_INCLUDE_PORTFOLIO", "0") != "0")

    try:
        run_card_store_parity(repo_root, node, py)
        print("[OK] card-store parity")
        run_artifacts_store_parity(repo_root, node, py)
        print("[OK] artifacts-store parity")
        if not board_py:
            print("[SKIP] board-live-cards parity (no Python env with native bridge; set CLI_PARITY_BOARD_PYTHON)")
        else:
            run_board_live_cards_parity(repo_root, node, board_py)
            print(f"[OK] board-live-cards parity (python={board_py})")
            if include_portfolio:
                run_portfolio_tracker_dual_mode_parity(repo_root, board_py)
                print("[OK] portfolio-tracker dual-mode parity")
            else:
                print("[SKIP] portfolio-tracker dual-mode parity (CLI_PARITY_INCLUDE_PORTFOLIO=0)")
    except AssertionError as e:
        print(f"[FAIL] {e}", file=sys.stderr)
        return 1
    except Exception as e:
        print(f"[FAIL] unexpected error: {e}", file=sys.stderr)
        return 1

    print("[OK] all CLI parity checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
