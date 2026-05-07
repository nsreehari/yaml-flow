"""
board_live_cards_native_bridge.py

Drop-in replacement for board_live_cards_quickjs_bridge.py.
Instead of executing a JS bundle via QuickJS, this module calls
the Python-native port of the board-live-cards-public module directly.

Same function signature as invoke_js_bundle_function:
  invoke_board_command_native(payload) -> dict result

The pycli entrypoint can switch from QuickJS to native by replacing:
  from sub.board_live_cards_quickjs_bridge import invoke_js_bundle_function
with:
  from sub.board_live_cards_native_bridge import invoke_board_command_native
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, Optional

# Ensure pylib is importable
_PYCLI_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
if _PYCLI_ROOT not in sys.path:
    sys.path.insert(0, _PYCLI_ROOT)

from pylib.cli.storage_interface import parse_ref, serialize_ref
from pylib.cli.board_live_cards_public import create_board_live_cards_public
from sub.board_live_cards_adapters import (
    ExecutionRef,
    FileAtomicRelayLock,
    FsBlobStorage,
    FsJournalStorageAdapter,
    FsKvStorage,
    PythonCommandExecutor,
    compute_stable_json_hash,
    dispatch_execution,
    parse_execution_ref as adapters_parse_execution_ref,
)


class NativeBoardPlatformAdapter:
    """
    Implements the BoardPlatformAdapter protocol using the existing
    Python fs-based adapters (FsKvStorage, FsBlobStorage, etc.).

    This is the Python equivalent of the QuickJS host_call adapter.
    """

    def __init__(self, base_ref: Dict[str, str], notify_channel: Optional[str] = None):
        self._base_ref = base_ref
        self._scope = base_ref["value"]
        self._notify_channel = notify_channel
        self._locks: Dict[str, Any] = {}
        self._repo_root = os.path.normpath(
            os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
        )

    def kv_storage(self, namespace: str):
        root = os.path.join(self._scope, f".{namespace}") if namespace else self._scope
        return _make_kv_adapter(root)

    def kv_storage_for_ref(self, ref: str):
        parsed = parse_ref(ref)
        return _make_kv_adapter(parsed["value"])

    def blob_storage(self, namespace: str):
        root = os.path.join(self._scope, namespace) if namespace else self._scope
        return _make_blob_adapter(root)

    def journal_adapter(self):
        return _make_journal_adapter(self._scope)

    @property
    def lock(self):
        lock_path = os.path.join(self._scope, ".board.lock")
        return _make_lock_adapter(lock_path)

    @property
    def self_ref(self) -> Dict[str, Any]:
        board_pycli = os.path.join(
            self._repo_root, "pycli", "main", "board_live_cards_pycli.py"
        )
        return {
            "meta": "board-live-cards",
            "howToRun": "local-python",
            "whatToRun": f"::fs-path::{board_pycli}",
        }

    def dispatch_execution(self, ref: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
        import tempfile
        import uuid

        exec_ref = ExecutionRef(
            meta=ref.get("meta"),
            howToRun=ref.get("howToRun", ""),
            whatToRun=ref.get("whatToRun", ""),
        )

        # Marshal high-level args into temp files (same as TS fs-board-adapter)
        label = (args.get("source_def") or {}).get("bindTo") or uuid.uuid4().hex[:8]
        board_tmp_dir = os.path.join(self._scope, ".tmp")
        os.makedirs(board_tmp_dir, exist_ok=True)

        in_file = os.path.join(board_tmp_dir, f"exec-in-{label}.json")
        out_file = os.path.join(board_tmp_dir, f"exec-out-{label}.json")
        err_file = os.path.join(board_tmp_dir, f"exec-err-{label}.txt")

        with open(in_file, "w", encoding="utf-8") as f:
            json.dump(args, f, indent=2)

        in_ref = f"::fs-path::{in_file}"
        out_ref = f"::fs-path::{out_file}"
        err_ref = f"::fs-path::{err_file}"

        return dispatch_execution(exec_ref, {
            "subcommand": "run-source-fetch",
            "inRef": in_ref,
            "outRef": out_ref,
            "errRef": err_ref,
        }, cwd=self._scope, detached=True)

    def resolve_blob(self, ref: Dict[str, str]) -> str:
        kind = ref.get("kind", "")
        value = ref.get("value", "")
        if kind == "fs-path":
            with open(value, "r", encoding="utf-8") as f:
                return f.read()
        raise ValueError(f"resolveBlob: unsupported ref kind: {kind}")

    def hash_fn(self, value: Any) -> str:
        return compute_stable_json_hash(value)

    def gen_id(self) -> str:
        import uuid
        return uuid.uuid4().hex[:32]

    def request_process_accumulated(self):
        """Spawn a detached process-accumulated-events pass (fire-and-forget).

        Matches TS requestProcessAccumulatedDetached: spawns a background
        process that re-acquires the lock and drains any new journal entries.
        """
        board_pycli = os.path.join(
            self._repo_root, "pycli", "main", "board_live_cards_pycli.py"
        )
        cmd_args = [
            board_pycli,
            "process-accumulated-events",
            "--base-ref", serialize_ref(self._base_ref),
        ]
        if self._notify_channel:
            cmd_args.extend(["--notify-channel", self._notify_channel])
        PythonCommandExecutor().spawn_detached(sys.executable, cmd_args, cwd=self._scope)

    def publish_board_change_notifications(self, notifications):
        pass  # no-op for now


def _make_kv_adapter(root: str):
    kv = FsKvStorage(root)

    class _KV:
        def read(self, key):
            return kv.read(key)

        def write(self, key, value):
            kv.write(key, value)

        def delete(self, key):
            kv.delete(key)

        def list_keys(self, prefix=None):
            return kv.list_keys(prefix)

    return _KV()


def _make_blob_adapter(root: str):
    blob = FsBlobStorage(root)

    class _Blob:
        def read(self, key):
            return blob.read(key)

        def write(self, key, content):
            blob.write(key, content)

        def exists(self, key):
            return blob.exists(key)

        def remove(self, key):
            blob.remove(key)

    return _Blob()


def _make_journal_adapter(scope: str):
    journal = FsJournalStorageAdapter(scope)

    class _Journal:
        def read_all_entries(self):
            return journal.read_all_entries()

        def append_entry(self, entry):
            journal.append_entry(entry)

        def generate_id(self):
            return journal.generate_id()

    return _Journal()


def _make_lock_adapter(lock_path: str):
    lock = FileAtomicRelayLock(lock_path)

    class _Lock:
        def try_acquire(self):
            return lock.try_acquire()

    return _Lock()


def invoke_board_command_native(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Drop-in replacement for the QuickJS invoke path.

    Accepts the same BoardInvokePayload shape:
      {
        "baseRef": "::fs-path::/some/path",
        "command": "init" | "status" | "upsertCard" | ...,
        "input": { "params": {...}, "body": ... },
        "notifyChannel": "..."
      }

    Returns the CommandResult dict.
    """
    base_ref_str = payload.get("baseRef", "")
    command = payload.get("command", "")
    input_obj = payload.get("input", {})
    notify_channel = payload.get("notifyChannel")

    base_ref = parse_ref(base_ref_str)
    adapter = NativeBoardPlatformAdapter(base_ref, notify_channel)
    board = create_board_live_cards_public(base_ref, adapter)

    # Map command string to method
    method_map = {
        "init": board.init,
        "status": board.status,
        "getCardStoreRef": board.get_card_store_ref,
        "getOutputsStoreRef": board.get_outputs_store_ref,
        "getOutputsDataObject": board.get_outputs_data_object,
        "getAllOutputsDataObjects": board.get_all_outputs_data_objects,
        "getOutputsComputedValues": board.get_outputs_computed_values,
        "getAllOutputsComputedValues": board.get_all_outputs_computed_values,
        "removeCard": board.remove_card,
        "retrigger": board.retrigger,
        "processAccumulatedEvents": board.process_accumulated_events,
        "upsertCard": board.upsert_card,
        "taskFailed": board.task_failed,
        "taskProgress": board.task_progress,
        "sourceDataFetched": board.source_data_fetched,
        "sourceDataFetchFailure": board.source_data_fetch_failure,
    }

    fn = method_map.get(command)
    if fn is None:
        return {"status": "error", "error": f"Unknown command: {command}"}

    try:
        result = fn(input_obj)
        return result
    except Exception as e:
        return {"status": "error", "error": str(e)}
