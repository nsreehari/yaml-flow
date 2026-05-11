#!/usr/bin/env python3
"""
py-demo-server.py

Python port of demo-src/example-board/demo-server.js — exact step-by-step parity.

Node.js host using http module → Python host using http.server.
Same endpoints, same config loading, same adapter factories.
"""
from __future__ import annotations

import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import urlparse, parse_qs, unquote

# ── Resolve paths ────────────────────────────────────────────────────────────

__file_dir = os.path.dirname(os.path.abspath(__file__))

# Add pycli to sys.path so we can import from py-server-runtime
_PYCLI_ROOT = os.path.normpath(os.path.join(__file_dir, "..", "..", "pycli"))
if _PYCLI_ROOT not in sys.path:
    sys.path.insert(0, _PYCLI_ROOT)

# Hyphenated package name workaround
_PY_SERVER_RUNTIME_DIR = os.path.join(_PYCLI_ROOT, "py-server-runtime")
if _PY_SERVER_RUNTIME_DIR not in sys.path:
    sys.path.insert(0, _PY_SERVER_RUNTIME_DIR)

from index import (
    create_single_board_server_runtime,
    create_multi_board_server_runtime,
    _create_artifacts_store,
)

# Reuse existing FS adapters from the native bridge
_PYCLI_SUB = os.path.join(_PYCLI_ROOT, "sub")
if _PYCLI_SUB not in sys.path:
    sys.path.insert(0, _PYCLI_SUB)

from board_live_cards_adapters import (
    FsKvStorage,
    FsBlobStorage,
    FsJournalStorageAdapter,
    FileAtomicRelayLock,
    PythonCommandExecutor,
    compute_stable_json_hash,
)
from pylib.cli.storage_interface import parse_ref, serialize_ref


# ============================================================================
# Config loading (reads demo-server-config.json)
# ============================================================================

def load_server_config() -> Dict[str, Any]:
    config_path = os.path.join(__file_dir, "demo-server-config.json")
    if not os.path.isfile(config_path):
        return {}
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            parsed = json.load(f)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def resolve_from_config(config_value) -> Optional[str]:
    if not isinstance(config_value, str) or not config_value.strip():
        return None
    return os.path.normpath(os.path.join(__file_dir, config_value))


def resolve_kind_ref_from_config(config_value) -> Optional[str]:
    if not isinstance(config_value, str) or not config_value.strip():
        return None
    trimmed = config_value.strip()

    if not trimmed.startswith("b64:"):
        return trimmed
    try:
        parsed = parse_ref(trimmed)
        if parsed.get("kind") != "fs-path":
            return trimmed
        raw_path = str(parsed.get("value") or "").strip()
        if not raw_path:
            return None
        resolved = raw_path if os.path.isabs(raw_path) else os.path.normpath(os.path.join(__file_dir, raw_path))
        return serialize_ref({"kind": "fs-path", "value": resolved})
    except Exception:
        return trimmed


def prefer_python_script(script_path: Optional[str]) -> Optional[str]:
    if not isinstance(script_path, str) or not script_path.strip():
        return script_path
    if script_path.endswith(".js") or script_path.endswith(".mjs"):
        py_candidate = script_path.rsplit(".", 1)[0] + ".py"
        if os.path.isfile(py_candidate):
            return py_candidate
    return script_path


server_config = load_server_config()

configured_cards_dir = resolve_from_config(server_config.get("cardsDir"))
configured_task_executor_path = resolve_from_config(
    server_config.get("taskExecutorPath") or server_config.get("demoTaskExecutorPath")
)
configured_chat_handler_path = resolve_from_config(server_config.get("chatHandlerPath"))
configured_inference_adapter_path = resolve_from_config(server_config.get("inferenceAdapterPath"))
configured_gandalf_cards_dir = resolve_from_config(server_config.get("gandalfCardsDir"))
configured_gandalf_task_executor_path = resolve_from_config(server_config.get("gandalfTaskExecutorPath"))
configured_gandalf_chat_handler_path = resolve_from_config(server_config.get("gandalfChatHandlerPath"))
configured_gandalf_inference_adapter_path = resolve_from_config(server_config.get("gandalfInferenceAdapterPath"))
configured_server_meta_store_ref = resolve_kind_ref_from_config(server_config.get("serverMetaStoreRef"))

PORT = int(os.environ.get("DEMO_SERVER_PORT") or server_config.get("port") or 7799)
RESET_ON_START = "--reset" in sys.argv

CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type,x-file-name",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
}

# ============================================================================
# Setup directory & defaults
# ============================================================================

setup_dir = os.path.normpath(
    os.environ.get("DEMO_SETUP_DIR") or resolve_from_config(server_config.get("setupDir")) or os.path.join(__file_dir, ".demo-setup")
)
os.makedirs(setup_dir, exist_ok=True)

default_cards_dir = os.path.normpath(
    os.environ.get("DEMO_CARDS_DIR") or configured_cards_dir or os.path.join(__file_dir, "cards")
)
default_task_executor_path = os.environ.get("DEMO_TASK_EXECUTOR_PATH") or configured_task_executor_path
default_chat_handler_path = os.environ.get("DEMO_CHAT_HANDLER_PATH") or configured_chat_handler_path
default_inference_adapter_path = os.environ.get("DEMO_INFERENCE_ADAPTER_PATH") or configured_inference_adapter_path
default_gandalf_cards_dir = os.environ.get("DEMO_GANDALF_CARDS_DIR") or configured_gandalf_cards_dir
default_gandalf_task_executor_path = os.environ.get("DEMO_GANDALF_TASK_EXECUTOR_PATH") or configured_gandalf_task_executor_path
default_gandalf_chat_handler_path = os.environ.get("DEMO_GANDALF_CHAT_HANDLER_PATH") or configured_gandalf_chat_handler_path
default_gandalf_inference_adapter_path = os.environ.get("DEMO_GANDALF_INFERENCE_ADAPTER_PATH") or configured_gandalf_inference_adapter_path

default_task_executor_path = prefer_python_script(default_task_executor_path)
default_chat_handler_path = prefer_python_script(default_chat_handler_path)
default_gandalf_task_executor_path = prefer_python_script(default_gandalf_task_executor_path)
default_gandalf_chat_handler_path = prefer_python_script(default_gandalf_chat_handler_path)


# ============================================================================
# Host adapter factories — Python-specific implementations injected into the
# platform-free server runtime.
# ============================================================================

def create_fs_card_source(cards_dir: str):
    """Port of createFsCardSource."""

    class _FsCardSource:
        def list_cards(self) -> List[Dict[str, Any]]:
            if not os.path.isdir(cards_dir):
                return []
            results = []
            for fname in sorted(os.listdir(cards_dir)):
                if not fname.endswith(".json") or fname.startswith("_"):
                    continue
                fpath = os.path.join(cards_dir, fname)
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        card = json.load(f)
                    if card:
                        results.append(card)
                except Exception:
                    pass
            return results

    return _FsCardSource()


def make_execution_ref(script_path: Optional[str], meta: str) -> Optional[Dict[str, Any]]:
    """Port of makeExecutionRef."""
    if not script_path:
        return None
    resolved = script_path if os.path.isabs(script_path) else os.path.normpath(os.path.join(os.getcwd(), script_path))
    # Determine howToRun from extension
    lower = resolved.lower()
    if lower.endswith(".py"):
        how_to_run = "local-python"
    elif lower.endswith(".js") or lower.endswith(".mjs"):
        how_to_run = "local-node"
    else:
        how_to_run = "local-process"
    return {"howToRun": how_to_run, "whatToRun": serialize_ref({"kind": "fs-path", "value": resolved}), "meta": meta}


def create_subprocess_invocation_adapter():
    """Port of createNodeSpawnInvocationAdapter — Python equivalent."""

    class _InvocationAdapter:
        def invoke(self, ref: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
            how_to_run = ref.get("howToRun", "")
            what_to_run = ref.get("whatToRun")
            if isinstance(what_to_run, dict):
                parsed = what_to_run
            else:
                parsed = parse_ref(str(what_to_run or ""))
            script_path = parsed.get("value") if parsed.get("kind") == "fs-path" else ""

            if not script_path:
                return {"dispatched": False, "error": f"no fs-path in whatToRun: {json.dumps(what_to_run)}"}

            # Determine interpreter
            if how_to_run == "local-python":
                interpreter = sys.executable
            elif how_to_run == "local-node":
                interpreter = shutil.which("node") or "node"
            else:
                return {"dispatched": False, "error": f"unsupported howToRun: {how_to_run}"}

            # Resolve chatsKeyPrefix (blob key prefix) to absolute FS chatDir for handlers
            final_args = dict(args)
            if final_args.get("chatsKeyPrefix") and final_args.get("chatsBlobBasePath"):
                card_part = str(final_args["chatsKeyPrefix"]).split("/")[0]
                final_args["chatDir"] = os.path.join(str(final_args["chatsBlobBasePath"]), card_part)
            final_args.pop("chatsKeyPrefix", None)
            final_args.pop("chatsBlobBasePath", None)

            import base64
            extra = base64.b64encode(json.dumps(final_args).encode("utf-8")).decode("ascii")
            try:
                cmd = [
                    interpreter, script_path,
                    "--boardId", str(args.get("boardId") or ""),
                    "--cardId", str(args.get("cardId") or ""),
                    "--extraEncJson", extra,
                ]
                if sys.platform == "win32":
                    CREATE_NO_WINDOW = 0x08000000
                    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     creationflags=CREATE_NO_WINDOW)
                else:
                    subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                     start_new_session=True)
                return {"dispatched": True}
            except Exception as err:
                return {"dispatched": False, "error": str(err)}

        def describe(self, ref: Dict[str, Any]) -> Optional[Dict[str, Any]]:
            how_to_run = ref.get("howToRun", "")
            what_to_run = ref.get("whatToRun")
            if isinstance(what_to_run, dict):
                parsed = what_to_run
            else:
                parsed = parse_ref(str(what_to_run or ""))
            script_path = parsed.get("value") if parsed.get("kind") == "fs-path" else ""
            if not script_path:
                return None

            if how_to_run == "local-python":
                interpreter = sys.executable
            elif how_to_run == "local-node":
                interpreter = shutil.which("node") or "node"
            else:
                return None

            try:
                result = subprocess.run(
                    [interpreter, script_path, "describe"],
                    capture_output=True, text=True, timeout=5,
                )
                if result.returncode != 0:
                    return None
                return json.loads(result.stdout.strip())
            except Exception:
                return None

    return _InvocationAdapter()


def create_fs_board_platform_adapter(base_ref: Dict[str, str], notify_channel: Optional[str] = None):
    """
    Port of createFsBoardPlatformAdapter — Python FS-backed adapter.
    """
    scope = base_ref["value"]

    class _Adapter:
        def kv_storage(self, namespace: str):
            root = os.path.join(scope, f".{namespace}") if namespace else scope
            return _make_kv(root)

        def kv_storage_for_ref(self, ref: str):
            parsed = parse_ref(ref)
            return _make_kv(parsed["value"])

        def blob_storage(self, namespace: str):
            root = os.path.join(scope, namespace) if namespace else scope
            return _make_blob(root)

        def journal_adapter(self):
            return _make_journal(scope)

        @property
        def lock(self):
            lock_path = os.path.join(scope, ".board.lock")
            return _make_lock(lock_path)

        @property
        def self_ref(self) -> Dict[str, Any]:
            board_pycli = os.path.join(_PYCLI_ROOT, "main", "board_live_cards_pycli.py")
            return {
                "meta": "board-live-cards",
                "howToRun": "local-python",
                "whatToRun": serialize_ref({"kind": "fs-path", "value": board_pycli}),
            }

        def dispatch_execution(self, ref: Dict[str, Any], args: Dict[str, Any]) -> Dict[str, Any]:
            from board_live_cards_adapters import ExecutionRef, dispatch_execution
            exec_ref = ExecutionRef(
                meta=ref.get("meta"),
                howToRun=ref.get("howToRun", ""),
                whatToRun=ref.get("whatToRun", ""),
            )
            label = (args.get("source_def") or {}).get("bindTo") or uuid.uuid4().hex[:8]
            board_tmp_dir = os.path.join(scope, ".tmp")
            os.makedirs(board_tmp_dir, exist_ok=True)
            in_file = os.path.join(board_tmp_dir, f"exec-in-{label}.json")
            out_file = os.path.join(board_tmp_dir, f"exec-out-{label}.json")
            err_file = os.path.join(board_tmp_dir, f"exec-err-{label}.txt")
            with open(in_file, "w", encoding="utf-8") as f:
                json.dump(args, f, indent=2)
            return dispatch_execution(exec_ref, {
                "subcommand": "run-source-fetch",
                "inRef": serialize_ref({"kind": "fs-path", "value": in_file}),
                "outRef": serialize_ref({"kind": "fs-path", "value": out_file}),
                "errRef": serialize_ref({"kind": "fs-path", "value": err_file}),
            }, cwd=scope, detached=True)

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
            return uuid.uuid4().hex[:32]

        def request_process_accumulated(self):
            board_pycli = os.path.join(_PYCLI_ROOT, "main", "board_live_cards_pycli.py")
            cmd_args = [
                board_pycli,
                "process-accumulated-events",
                "--base-ref", serialize_ref(base_ref),
            ]
            if notify_channel:
                cmd_args.extend(["--notify-channel", notify_channel])
            PythonCommandExecutor().spawn_detached(sys.executable, cmd_args, cwd=scope)

        def publish_board_change_notifications(self, notifications):
            pass  # Overridden by the runtime when wiring SSE

    return _Adapter()


def _make_kv(root: str):
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


def _make_blob(root: str):
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

        def list_keys(self, prefix=""):
            """Walk the FS root and return all keys matching prefix."""
            root_path = Path(root)
            if not root_path.is_dir():
                return []
            results = []
            for p in root_path.rglob("*"):
                if p.is_file():
                    rel = p.relative_to(root_path).as_posix()
                    if not prefix or rel.startswith(prefix):
                        results.append(rel)
            return sorted(results)

    return _Blob()


def _make_journal(scope: str):
    journal = FsJournalStorageAdapter(scope)

    class _Journal:
        def read_all_entries(self):
            return journal.read_all_entries()

        def append_entry(self, entry):
            journal.append_entry(entry)

        def generate_id(self):
            return journal.generate_id()

    return _Journal()


def _make_lock(lock_path: str):
    lock = FileAtomicRelayLock(lock_path)

    class _Lock:
        def try_acquire(self):
            return lock.try_acquire()

    return _Lock()


# ============================================================================
# Server meta store
# ============================================================================

server_meta_ref = os.environ.get("DEMO_SERVER_META_STORE_REF") or configured_server_meta_store_ref or serialize_ref({"kind": "fs-path", "value": setup_dir})
server_meta_parsed = parse_ref(server_meta_ref)
server_meta_adapter = create_fs_board_platform_adapter(server_meta_parsed)
server_meta_store = _create_artifacts_store(server_meta_adapter.blob_storage("server-meta"))


# ============================================================================
# Build multi-board runtime
# ============================================================================

api_base_path = "/api/boards"
invocation_adapter = create_subprocess_invocation_adapter()
logger_obj = type("Logger", (), {
    "info": staticmethod(lambda msg, *a: print(f"[py-demo-server] {msg}", *a)),
    "warn": staticmethod(lambda msg, *a: print(f"[py-demo-server][WARN] {msg}", *a)),
    "error": staticmethod(lambda msg, *a: print(f"[py-demo-server][ERROR] {msg}", *a)),
})()

board_host_config: Dict[str, Dict[str, Any]] = {}


def build_board_context_config(label, board_dir, task_exec_path, chat_handler_path_, inf_adapter_path, board_id_):
    os.makedirs(board_dir, exist_ok=True)

    # Runtime card store lives inside the board's setup dir, isolated from the source cards dir.
    # Layout: board_dir/cards/store  — KV card store
    #         board_dir/cards/chats  — chat blobs
    #         board_dir/cards/files  — file uploads
    runtime_cards_dir = os.path.join(board_dir, "cards")
    runtime_card_store_dir = os.path.join(runtime_cards_dir, "store")
    os.makedirs(runtime_card_store_dir, exist_ok=True)

    notify_channel = f"yaml-flow-py-server-{label}-{board_id_}-{os.getpid()}"
    base_ref = parse_ref(serialize_ref({"kind": "fs-path", "value": board_dir}))
    board_adapter = create_fs_board_platform_adapter(base_ref, notify_channel)

    # Artifacts adapter rooted at runtime_cards_dir so chats/ and files/ are siblings of store/.
    artifacts_ref = parse_ref(serialize_ref({"kind": "fs-path", "value": runtime_cards_dir}))
    artifacts_adapter = create_fs_board_platform_adapter(artifacts_ref)

    card_store_ref = serialize_ref({"kind": "fs-path", "value": runtime_card_store_dir})

    return {
        "label": label,
        "board_adapter": board_adapter,
        "artifacts_adapter": artifacts_adapter,
        "base_ref": base_ref,
        "card_store_ref": card_store_ref,
        "outputs_store_ref": serialize_ref({"kind": "fs-path", "value": os.path.join(os.path.dirname(board_dir), "runtime-out", ".outputs")}),
        "notify_ref": {"kind": "named-pipe", "value": notify_channel},
        "task_executor_ref": make_execution_ref(task_exec_path, "task-executor"),
        "chat_handler_ref": make_execution_ref(chat_handler_path_, "chat-handler"),
        "inference_adapter_ref": make_execution_ref(inf_adapter_path, "inference-adapter"),
    }


def board_runtime_factory(board_id_: str, entry: Dict[str, Any]):
    # source_cards_dir: read-only source used only for initial seeding.
    source_cards_dir = os.path.abspath(entry["cardsDir"]) if isinstance(entry.get("cardsDir"), str) else default_cards_dir
    board_root = os.path.join(setup_dir, f"board-{board_id_}")
    board_dir = os.path.join(board_root, "runtime")

    task_exec_path = entry.get("taskExecutorPath") if isinstance(entry.get("taskExecutorPath"), str) else default_task_executor_path
    chat_handler_path_ = entry.get("chatHandlerPath") if isinstance(entry.get("chatHandlerPath"), str) else default_chat_handler_path
    inf_adapter_path = entry.get("inferenceAdapterPath") if isinstance(entry.get("inferenceAdapterPath"), str) else default_inference_adapter_path

    source_gandalf_cards_dir = (
        os.path.normpath(entry["gandalfCardsDir"]) if isinstance(entry.get("gandalfCardsDir"), str)
        else default_gandalf_cards_dir
    )
    gandalf_task_exec_path = entry.get("gandalfTaskExecutorPath") if isinstance(entry.get("gandalfTaskExecutorPath"), str) else default_gandalf_task_executor_path
    gandalf_chat_path = entry.get("gandalfChatHandlerPath") if isinstance(entry.get("gandalfChatHandlerPath"), str) else default_gandalf_chat_handler_path
    gandalf_inf_path = entry.get("gandalfInferenceAdapterPath") if isinstance(entry.get("gandalfInferenceAdapterPath"), str) else default_gandalf_inference_adapter_path

    base_cfg = build_board_context_config("base", board_dir, task_exec_path, chat_handler_path_, inf_adapter_path, board_id_)

    # runtimeCardsDir is where the live card store lives (inside setupDir).
    runtime_cards_dir = os.path.join(board_dir, "cards")

    boards = [base_cfg]
    gandalf_board_dir = None
    if source_gandalf_cards_dir and gandalf_task_exec_path:
        gandalf_board_dir = os.path.join(board_root, "gandalf-runtime")
        gandalf_cfg = build_board_context_config("gandalf", gandalf_board_dir, gandalf_task_exec_path, gandalf_chat_path, gandalf_inf_path, board_id_)
        gandalf_cfg["outputs_store_ref"] = serialize_ref({"kind": "fs-path", "value": os.path.join(board_root, "gandalf-runtime-out", ".outputs")})
        boards.append(gandalf_cfg)

    board_host_config[board_id_] = {"cardsDir": source_cards_dir, "gandalfCardsDir": source_gandalf_cards_dir, "boardDir": board_dir, "boardRoot": board_root}

    # Auto-run demo-setup at board init time (mirrors JS demoPrepSetup call)
    demo_prep_setup(board_id_)

    single_board_runtime = create_single_board_server_runtime({
        "api_base_path": f"{api_base_path}/{board_id_}",
        "board_id": board_id_,
        "boards": boards,
        "invocation_adapter": invocation_adapter,
        "logger": logger_obj,
        "server_url": f"http://127.0.0.1:{PORT}",
        "execution_extra": {
            "boardSetupRoot": board_root,
            "chatsBlobBasePath": os.path.join(runtime_cards_dir, "chats"),
        },
    })

    # Host concern: seed card store from source cards dir only if the runtime store is empty.
    existing = single_board_runtime.card_store.get({})
    is_empty = existing.get("status") != "success" or not existing.get("data", {}).get("cards")
    if is_empty:
        cards = create_fs_card_source(source_cards_dir).list_cards()
        if cards:
            single_board_runtime.card_store.set({"body": cards})

    # Seed gandalf board if present
    if gandalf_board_dir and source_gandalf_cards_dir:
        get_gandalf_runtime = getattr(single_board_runtime, "get_board_runtime", None)
        gandalf_runtime = get_gandalf_runtime("gandalf") if callable(get_gandalf_runtime) else None
        if gandalf_runtime:
            g_existing = gandalf_runtime.card_store.get({})
            g_empty = g_existing.get("status") != "success" or not g_existing.get("data", {}).get("cards")
            if g_empty:
                g_cards = create_fs_card_source(source_gandalf_cards_dir).list_cards()
                if g_cards:
                    gandalf_runtime.card_store.set({"body": g_cards})

    return single_board_runtime


runtime = create_multi_board_server_runtime({
    "api_base_path": api_base_path,
    "server_meta_store": server_meta_store,
    "board_runtime_factory": board_runtime_factory,
    "logger": logger_obj,
})


# ============================================================================
# Reset
# ============================================================================

def reset_runtime():
    if os.path.exists(setup_dir):
        shutil.rmtree(setup_dir, ignore_errors=True)
        print(f"[py-demo-server] reset: wiped {setup_dir}")
    chat_sessions_dir = (
        os.path.normpath(os.path.join(__file_dir, server_config["chatSessionsDir"]))
        if server_config.get("chatSessionsDir")
        else os.path.join(tempfile.gettempdir(), "demo-chat-handler-sessions")
    )
    if os.path.exists(chat_sessions_dir):
        shutil.rmtree(chat_sessions_dir, ignore_errors=True)
        print(f"[py-demo-server] reset: wiped {chat_sessions_dir}")


if RESET_ON_START:
    reset_runtime()


# ============================================================================
# Demo-setup — host-level concern
# ============================================================================

BOARD_SEG_RE = re.compile(r"^/api/boards/([^/]+)/(.+)$")
_demo_prep_setup_done: Dict[str, bool] = {}


def is_demo_setup_done(board_id_: str) -> bool:
    cfg = board_host_config.get(board_id_)
    return _demo_prep_setup_done.get(board_id_) is True and cfg is not None and os.path.isdir(cfg["cardsDir"])


def demo_prep_setup(board_id_: str):
    cfg = board_host_config.get(board_id_)
    if not cfg:
        return
    cards_dir = cfg["cardsDir"]
    board_dir = cfg["boardDir"]
    board_setup_root = os.path.dirname(board_dir)
    os.makedirs(board_setup_root, exist_ok=True)
    src_dir = os.path.dirname(cards_dir)
    agent_instruction_files = ["agent-instructions.md", "agent-instructions-cardlayout.md"]
    parts = []
    for fname in agent_instruction_files:
        fpath = os.path.join(src_dir, fname)
        if os.path.isfile(fpath):
            with open(fpath, "r", encoding="utf-8") as f:
                parts.append(f.read().rstrip())
    if parts:
        with open(os.path.join(board_setup_root, "copilot-instructions.md"), "w", encoding="utf-8") as f:
            f.write("\n\n".join(parts) + "\n")
    _demo_prep_setup_done[board_id_] = True


# ============================================================================
# HTTP Server (Python stdlib)
# ============================================================================

class ParsedUrl:
    """Lightweight parsed URL adapter matching what the runtime expects."""
    def __init__(self, url_str: str):
        parsed = urlparse(url_str)
        self.path = parsed.path
        qs = parse_qs(parsed.query, keep_blank_values=True)
        self.query_params = {k: v[0] for k, v in qs.items()}


class RequestAdapter:
    """Adapts http.server request to RuntimeRequest protocol."""
    def __init__(self, handler: http.server.BaseHTTPRequestHandler, body: bytes):
        self._handler = handler
        self._body = body

    @property
    def method(self) -> str:
        return self._handler.command

    @property
    def path(self) -> str:
        parsed = urlparse(self._handler.path)
        return parsed.path

    @property
    def headers(self) -> Dict[str, str]:
        return {k.lower(): v for k, v in self._handler.headers.items()}

    @property
    def query_params(self) -> Dict[str, str]:
        parsed = urlparse(self._handler.path)
        qs = parse_qs(parsed.query, keep_blank_values=True)
        return {k: v[0] for k, v in qs.items()}

    def read_body(self) -> bytes:
        return self._body


class ResponseAdapter:
    """Adapts http.server response to RuntimeResponse protocol."""
    def __init__(self, handler: http.server.BaseHTTPRequestHandler):
        self._handler = handler
        self._headers_sent = False
        self._status = 200
        self._headers: Dict[str, str] = {}
        self._is_sse = False

    def write_head(self, status_code: int, headers: Optional[Dict[str, str]] = None):
        self._status = status_code
        if headers:
            self._headers.update(headers)
        if self._headers.get("Content-Type", "").startswith("text/event-stream"):
            self._is_sse = True

    def _send_headers(self):
        if self._headers_sent:
            return
        self._handler.send_response(self._status)
        for k, v in self._headers.items():
            self._handler.send_header(k, str(v))
        self._handler.end_headers()
        self._headers_sent = True

    def write(self, data):
        self._send_headers()
        if isinstance(data, str):
            self._handler.wfile.write(data.encode("utf-8"))
        else:
            self._handler.wfile.write(data)
        self._handler.wfile.flush()

    def end(self, data=None):
        self._send_headers()
        if data:
            if isinstance(data, str):
                self._handler.wfile.write(data.encode("utf-8"))
            else:
                self._handler.wfile.write(data)
        self._handler.wfile.flush()


def json_reply(handler: http.server.BaseHTTPRequestHandler, status: int, payload: Any):
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    for k, v in CORS_HEADERS.items():
        handler.send_header(k, v)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


class DemoRequestHandler(http.server.BaseHTTPRequestHandler):
    """HTTP request handler — routes to multi-board runtime."""

    def log_message(self, format, *args):
        # Quieter logging
        pass

    def do_OPTIONS(self):
        self.send_response(204)
        for k, v in CORS_HEADERS.items():
            self.send_header(k, v)
        self.end_headers()

    def do_GET(self):
        self._handle_request()

    def do_POST(self):
        self._handle_request()

    def do_PATCH(self):
        self._handle_request()

    def _handle_request(self):
        parsed = urlparse(self.path)
        pathname = parsed.path

        # Read body if present
        content_length = int(self.headers.get("content-length") or 0)
        body = self.rfile.read(content_length) if content_length > 0 else b""

        # WorkIQ proxy route (host concern — requires WorkIQ CLI)
        if self.command == "POST" and pathname == "/api/workiq/ask":
            self._handle_workiq_ask(body)
            return

        # Demo-setup route — no-op (setup now runs at board init time)
        board_seg_match = BOARD_SEG_RE.match(pathname)
        if board_seg_match and board_seg_match.group(2) == "demo-setup":
            json_reply(self, 200, {"ok": True, "setupPerformed": False})
            return

        # All other /api/boards routes handled by platform-free runtime
        req = RequestAdapter(self, body)
        res = ResponseAdapter(self)
        parsed_url = ParsedUrl(self.path)

        handled = runtime.handle_api(req, res, parsed_url)
        if not handled:
            json_reply(self, 404, {"error": "Not found"})

    def _handle_workiq_ask(self, body: bytes):
        try:
            query = json.loads(body.decode("utf-8")).get("query")
        except Exception:
            json_reply(self, 400, {"error": "Invalid JSON body"})
            return
        if not query or not isinstance(query, str):
            json_reply(self, 400, {"error": "{ query } string is required"})
            return

        appdata = os.environ.get("APPDATA") or os.path.expanduser("~")
        workiq_js = os.path.join(appdata, "npm", "node_modules", "@microsoft", "workiq", "bin", "workiq.js")
        if not os.path.isfile(workiq_js):
            json_reply(self, 503, {"error": f"WorkIQ CLI not found at: {workiq_js}"})
            return

        node = shutil.which("node") or "node"
        try:
            result = subprocess.run(
                [node, workiq_js, "ask", "-q", query],
                capture_output=True, text=True, timeout=60,
            )
            if result.returncode != 0:
                json_reply(self, 500, {"error": f"workiq exited {result.returncode}", "stderr": result.stderr})
            else:
                json_reply(self, 200, {"response": result.stdout})
        except subprocess.TimeoutExpired:
            json_reply(self, 504, {"error": "workiq timed out after 60s"})
        except Exception as err:
            json_reply(self, 500, {"error": f"workiq spawn error: {err}"})


# ============================================================================
# Main
# ============================================================================

def main():
    server = http.server.HTTPServer(("127.0.0.1", PORT), DemoRequestHandler)
    print(f"[py-demo-server] listening on http://127.0.0.1:{PORT}")
    print(f"[py-demo-server] setup dir: {setup_dir}")
    print(f"[py-demo-server] server-meta store: {server_meta_ref}")
    print("[py-demo-server] endpoints:")
    print(f"  GET  {api_base_path}                          <- list boards")
    print(f"  POST {api_base_path}  {{id, label?}}            <- register board")
    print(f"  GET  {api_base_path}/:boardId/demo-setup  (no-op; setup now runs at board init)")
    print(f"  GET  {api_base_path}/:boardId/init-board")
    print(f"  POST /api/workiq/ask  {{query}}              <- WorkIQ (M365 Copilot) proxy")
    print(f"  GET  {api_base_path}/:boardId/sse")
    print(f"  GET  {api_base_path}/:boardId/board-status")
    print(f"  PATCH {api_base_path}/:boardId/cards/:id")
    print(f"  POST {api_base_path}/:boardId/cards/:id/actions")
    print(f"  POST {api_base_path}/:boardId/cards/:id/files")
    print(f"  GET  {api_base_path}/:boardId/cards/:id/files/:idx")
    print(f"  GET  {api_base_path}/:boardId/cards/:id/chats")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[py-demo-server] shutting down")
        server.shutdown()


if __name__ == "__main__":
    main()
