"""
board_live_cards_state_snapshot — Python adapter for snapshot persistence.

Persists 5 mutable runtime state keys:
- board/graph and board/lastJournalProcessedId → board-graph.json
- cards/<id>/runtime, cards/<id>/fetched-sources-manifest, outputStore → .state-snapshot/ tree

Configuration state (CardsStore, ControlStore) is NOT persisted here;
it is loaded from card-source-kinds.json and config files at init time.

Version hashing is deterministic: sorts all keys before SHA256 to ensure
reproducible collision detection across hosts (Node, Python, Azure, Browser).
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SNAPSHOT_SCHEMA_VERSION_V1 = "v1"
BOARD_FILE = "board-graph.json"
SIDE_SNAPSHOT_ROOT = ".state-snapshot"

BOARD_GRAPH_KEY = "board/graph"
BOARD_LAST_JOURNAL_PROCESSED_ID_KEY = "board/lastJournalProcessedId"


@dataclass
class StateSnapshotReadView:
    version: Optional[str]
    values: Dict[str, Any]


@dataclass
class StateSnapshotCommitResult:
    ok: bool
    reason: Optional[str] = None
    current_version: Optional[str] = None
    new_version: Optional[str] = None


class StateSnapshotError(Exception):
    pass


def _stable_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def _values_to_version(values: Dict[str, Any]) -> str:
    digest = hashlib.sha256()
    digest.update(_stable_json(values).encode("utf-8"))
    return digest.hexdigest()


def _write_json_atomic(file_path: Path, payload: Any) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_fd, tmp_name = tempfile.mkstemp(prefix=f"{file_path.name}.", suffix=".tmp", dir=str(file_path.parent))
    try:
        with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=True)
        os.replace(tmp_name, file_path)
    except Exception:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise


def _sidecar_key_to_path(scope_dir: Path, key: str) -> Path:
    normalized = [part for part in key.split("/") if part]
    return scope_dir / SIDE_SNAPSHOT_ROOT / Path(*normalized)


def _read_json(file_path: Path) -> Any:
    with file_path.open("r", encoding="utf-8") as f:
        return json.load(f)


def _snapshot_values_to_board_envelope(values: Dict[str, Any]) -> Dict[str, Any]:
    graph = values.get(BOARD_GRAPH_KEY)
    last_processed = values.get(BOARD_LAST_JOURNAL_PROCESSED_ID_KEY)
    if not isinstance(graph, dict):
        raise StateSnapshotError(f"Snapshot missing required key: {BOARD_GRAPH_KEY}")
    if not isinstance(last_processed, str):
        raise StateSnapshotError(f"Snapshot missing required key: {BOARD_LAST_JOURNAL_PROCESSED_ID_KEY}")
    return {
        "graph": graph,
        "lastDrainedJournalId": last_processed,
    }


def apply_snapshot_commit(current: Dict[str, Any], delete_keys: List[str], shallow_merge: Dict[str, Any]) -> Dict[str, Any]:
    next_values = dict(current)
    for key in delete_keys:
        next_values.pop(key, None)
    next_values.update(shallow_merge)
    return next_values


def read_snapshot(scope_dir: str) -> StateSnapshotReadView:
    scope = Path(scope_dir)
    board_path = scope / BOARD_FILE
    if not board_path.exists():
        return StateSnapshotReadView(version=None, values={})

    board_envelope = _read_json(board_path)
    values: Dict[str, Any] = {
        BOARD_GRAPH_KEY: board_envelope.get("graph"),
        BOARD_LAST_JOURNAL_PROCESSED_ID_KEY: board_envelope.get("lastDrainedJournalId", ""),
    }

    sidecar_root = scope / SIDE_SNAPSHOT_ROOT
    if sidecar_root.exists():
        files = sorted(p for p in sidecar_root.rglob("*.json") if p.is_file())
        for file_path in files:
            rel = file_path.relative_to(sidecar_root).as_posix()
            key = rel[:-5] if rel.endswith(".json") else rel
            values[key] = _read_json(file_path)

    return StateSnapshotReadView(version=_values_to_version(values), values=values)


def commit_snapshot(scope_dir: str, envelope: Dict[str, Any]) -> StateSnapshotCommitResult:
    schema_version = envelope.get("schemaVersion")
    if schema_version != SNAPSHOT_SCHEMA_VERSION_V1:
        raise StateSnapshotError(f"Unsupported snapshot schema version: {schema_version}")

    expected_version = envelope.get("expectedVersion")
    delete_keys = envelope.get("deleteKeys", [])
    shallow_merge = envelope.get("shallowMerge", {})

    if not isinstance(delete_keys, list) or not all(isinstance(k, str) for k in delete_keys):
        raise StateSnapshotError("deleteKeys must be a list of strings")
    if not isinstance(shallow_merge, dict):
        raise StateSnapshotError("shallowMerge must be an object")

    current = read_snapshot(scope_dir)
    if current.version != expected_version:
        return StateSnapshotCommitResult(
            ok=False,
            reason="version-mismatch",
            current_version=current.version,
        )

    next_values = apply_snapshot_commit(current.values, delete_keys, shallow_merge)
    board_envelope = _snapshot_values_to_board_envelope(next_values)

    scope = Path(scope_dir)
    _write_json_atomic(scope / BOARD_FILE, board_envelope)

    board_keys = {BOARD_GRAPH_KEY, BOARD_LAST_JOURNAL_PROCESSED_ID_KEY}

    for key in delete_keys:
        if key in board_keys:
            continue
        sidecar_base = _sidecar_key_to_path(scope, key)
        sidecar_file = sidecar_base.with_suffix(".json")
        if sidecar_file.exists():
            sidecar_file.unlink()

    for key, value in shallow_merge.items():
        if key in board_keys:
            continue
        sidecar_base = _sidecar_key_to_path(scope, key)
        _write_json_atomic(sidecar_base.with_suffix(".json"), value)

    return StateSnapshotCommitResult(ok=True, new_version=_values_to_version(next_values))


def make_commit_envelope(
    expected_version: Optional[str],
    shallow_merge: Dict[str, Any],
    delete_keys: Optional[List[str]] = None,
) -> Dict[str, Any]:
    return {
        "schemaVersion": SNAPSHOT_SCHEMA_VERSION_V1,
        "expectedVersion": expected_version,
        "commitId": str(uuid.uuid4()),
        "committedAt": __import__("datetime").datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
        "deleteKeys": delete_keys or [],
        "shallowMerge": shallow_merge,
    }
