"""
KV-backed StepMachineStore for Python step-machine.

Parallels JS KVStorageStore key schema:
  state_<b64url(runId)>
  data_<b64url(runId)>_<b64url(key)>
"""
from __future__ import annotations

import base64
import json
from pathlib import Path
from typing import Any, Dict, List


def _b64url_encode(value: str) -> str:
    return base64.urlsafe_b64encode(value.encode("utf-8")).decode("ascii").rstrip("=")


def _b64url_decode(value: str) -> str:
    padded = value + ("=" * ((4 - (len(value) % 4)) % 4))
    return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")


class FsKvStorage:
    """Simple file-backed KV storage where each key maps to <root>/<key>.json."""

    def __init__(self, root_dir: str):
        self._root = Path(root_dir)
        self._root.mkdir(parents=True, exist_ok=True)

    def _path_for_key(self, key: str) -> Path:
        if not key:
            raise ValueError("KV key must be non-empty")
        return self._root / f"{key}.json"

    def read(self, key: str) -> Any:
        p = self._path_for_key(key)
        if not p.exists():
            return None
        with p.open("r", encoding="utf-8") as f:
            return json.load(f)

    def write(self, key: str, value: Any) -> None:
        p = self._path_for_key(key)
        p.parent.mkdir(parents=True, exist_ok=True)
        with p.open("w", encoding="utf-8") as f:
            json.dump(value, f, indent=2, ensure_ascii=True)

    def delete(self, key: str) -> None:
        p = self._path_for_key(key)
        if p.exists():
            p.unlink()

    def list_keys(self, prefix: str = "") -> List[str]:
        keys: List[str] = []
        for p in self._root.glob("*.json"):
            key = p.stem
            if prefix and not key.startswith(prefix):
                continue
            keys.append(key)
        keys.sort()
        return keys


class KVStorageStore:
    def __init__(self, kv: Any):
        self._kv = kv

    def _state_key(self, run_id: str) -> str:
        return f"state_{_b64url_encode(run_id)}"

    def _data_prefix(self, run_id: str) -> str:
        return f"data_{_b64url_encode(run_id)}_"

    def _data_key(self, run_id: str, key: str) -> str:
        return f"{self._data_prefix(run_id)}{_b64url_encode(key)}"

    def save_run_state(self, run_id: str, state: Dict[str, Any]) -> None:
        self._kv.write(self._state_key(run_id), state)

    def load_run_state(self, run_id: str) -> Dict[str, Any] | None:
        value = self._kv.read(self._state_key(run_id))
        return value if isinstance(value, dict) else None

    def delete_run_state(self, run_id: str) -> None:
        self._kv.delete(self._state_key(run_id))
        for key in self._kv.list_keys(self._data_prefix(run_id)):
            self._kv.delete(key)

    def set_data(self, run_id: str, key: str, value: Any) -> None:
        self._kv.write(self._data_key(run_id, key), value)

    def get_data(self, run_id: str, key: str) -> Any:
        return self._kv.read(self._data_key(run_id, key))

    def get_all_data(self, run_id: str) -> Dict[str, Any]:
        prefix = self._data_prefix(run_id)
        out: Dict[str, Any] = {}
        for key in self._kv.list_keys(prefix):
            decoded = _b64url_decode(key[len(prefix):])
            out[decoded] = self._kv.read(key)
        return out

    def clear_data(self, run_id: str) -> None:
        for key in self._kv.list_keys(self._data_prefix(run_id)):
            self._kv.delete(key)

    def list_runs(self) -> List[str]:
        runs: List[str] = []
        for key in self._kv.list_keys("state_"):
            encoded = key[len("state_"):]
            runs.append(_b64url_decode(encoded))
        return runs
