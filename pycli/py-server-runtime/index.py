"""
py-server-runtime/index.py

Platform-free board server runtime.

─────────────────────────────────────────────────────────────────────────────
LAYER DIAGRAM
─────────────────────────────────────────────────────────────────────────────

  HOST (py-demo-server / Azure Fn / Firebase Fn)
    ↓ constructs adapters, calls create_single_board_server_runtime(options)
  THIS FILE — routes, contexts, chat/file orchestration
    ↓ delegates to
  board-live-cards-public.py — graph, journal, dispatch (already platform-free)

No os, subprocess, socket imports.
All platform access flows through injected adapters.
─────────────────────────────────────────────────────────────────────────────

Port of src/server-runtime/index.ts — exact parity, step by step.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional, Set
from urllib.parse import urlparse, parse_qs, unquote

import sys
import os

# Import from sibling pylib modules (platform-free)
_PYCLI_ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
if _PYCLI_ROOT not in sys.path:
    sys.path.insert(0, _PYCLI_ROOT)

from pylib.cli.board_live_cards_public import create_board_live_cards_public
from pylib.cli.board_live_cards_lib import (
    create_card_store,
    create_published_outputs_store,
    build_board_status_object,
    live_card_to_task_config,
)
from pylib.cli.storage_interface import serialize_ref, parse_ref


# ============================================================================
# Constants
# ============================================================================

DEFAULT_CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "content-type,x-file-name",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
}

MAX_STORED_FILE_NAME_LEN = 32


# ============================================================================
# Internal types
# ============================================================================

def _make_notification_state() -> Dict[str, Any]:
    return {"status": None, "computedValues": {}, "dataObjects": {}, "cards": {}}


def _append_notification(state: Dict[str, Any], event: Any) -> None:
    if not event or not isinstance(event, dict):
        return
    # Unpack notification-batch so individual items update state fields
    if event.get("kind") == "notification-batch" and isinstance(event.get("notifications"), list):
        for n in event["notifications"]:
            _append_notification(state, n)
        return
    if event.get("kind") == "status":
        state["status"] = event.get("status")
    if event.get("kind") == "computed_values" and event.get("cardId"):
        state["computedValues"][event["cardId"]] = event.get("values")
    if event.get("kind") == "data_object" and event.get("key"):
        state["dataObjects"][event["key"]] = event.get("payload")
    if event.get("kind") == "card_refreshed" and event.get("cardId"):
        state["cards"][event["cardId"]] = event.get("card")


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _escape_regexp(s: str) -> str:
    return re.escape(s)


# ============================================================================
# Artifacts helpers (inlined — matching TS artifacts-store-lib)
# ============================================================================

INDEX_KEY = ".artifacts-index.json"


def _utf8_byte_length(s: str) -> int:
    return len(s.encode("utf-8"))


def _load_artifacts_index(blob) -> Dict[str, Any]:
    raw = blob.read(INDEX_KEY)
    if not raw:
        return {"entries": {}}
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
        if parsed and isinstance(parsed.get("entries"), dict):
            return parsed
    except Exception:
        pass
    return {"entries": {}}


def _save_artifacts_index(blob, index: Dict[str, Any]) -> None:
    blob.write(INDEX_KEY, json.dumps(index, indent=2))


def _create_artifacts_store(blob):
    """Port of createArtifactsStore."""

    def head(key: str):
        idx = _load_artifacts_index(blob)
        entry = idx["entries"].get(key)
        if entry:
            return dict(entry)
        if not blob.exists(key):
            return None
        content = blob.read(key)
        if content is None:
            return {"key": key}
        return {"key": key, "size": _utf8_byte_length(content)}

    class _Store:
        def exists(self, key: str) -> bool:
            return blob.exists(key)

        def put_text(self, key: str, content: str, content_type: str = "text/plain; charset=utf-8"):
            blob.write(key, content)
            info = head(key) or {"key": key}
            info["contentType"] = content_type
            info.setdefault("updatedAt", _now_iso())
            info.setdefault("size", _utf8_byte_length(content))
            idx = _load_artifacts_index(blob)
            idx["entries"][key] = info
            _save_artifacts_index(blob, idx)
            return info

        def put_bytes(self, key: str, content: bytes, content_type: str = "application/octet-stream"):
            if hasattr(blob, "write_bytes"):
                blob.write_bytes(key, content)
            else:
                envelope = json.dumps({"__kind": "bytes-array", "data": list(content)})
                blob.write(key, envelope)
            info = head(key) or {"key": key}
            info["contentType"] = content_type
            info.setdefault("updatedAt", _now_iso())
            info.setdefault("size", len(content))
            idx = _load_artifacts_index(blob)
            idx["entries"][key] = info
            _save_artifacts_index(blob, idx)
            return info

        def get_text(self, key: str) -> Optional[str]:
            raw = blob.read(key)
            if raw is None:
                if hasattr(blob, "read_bytes"):
                    b = blob.read_bytes(key)
                    if b is None:
                        return None
                    return b.decode("utf-8")
                return None
            if isinstance(raw, str):
                try:
                    parsed = json.loads(raw)
                    if isinstance(parsed, dict) and parsed.get("__kind") == "bytes-array" and isinstance(parsed.get("data"), list):
                        return bytes(parsed["data"]).decode("utf-8")
                except Exception:
                    pass
                return raw
            return str(raw)

        def get_bytes(self, key: str) -> Optional[bytes]:
            if hasattr(blob, "read_bytes"):
                b = blob.read_bytes(key)
                if b is not None:
                    return b
            raw = blob.read(key)
            if raw is None:
                return None
            if isinstance(raw, str):
                try:
                    parsed = json.loads(raw)
                    if isinstance(parsed, dict) and parsed.get("__kind") == "bytes-array" and isinstance(parsed.get("data"), list):
                        return bytes(parsed["data"])
                except Exception:
                    pass
                return raw.encode("utf-8")
            return str(raw).encode("utf-8")

        def head(self, key: str):
            return head(key)

        def list(self, prefix: str = "") -> List[Dict[str, Any]]:
            info_by_key: Dict[str, Any] = {}
            if hasattr(blob, "list_keys"):
                for k in blob.list_keys(prefix):
                    if k == INDEX_KEY:
                        continue
                    info_by_key[k] = head(k) or {"key": k}
            idx = _load_artifacts_index(blob)
            for k, entry in idx["entries"].items():
                if k == INDEX_KEY:
                    continue
                if prefix and not k.startswith(prefix):
                    continue
                if k not in info_by_key:
                    info_by_key[k] = dict(entry)
            return sorted(info_by_key.values(), key=lambda x: x.get("key", ""))

        def remove(self, key: str) -> None:
            blob.remove(key)
            idx = _load_artifacts_index(blob)
            idx["entries"].pop(key, None)
            _save_artifacts_index(blob, idx)

    return _Store()


def _parse_leading_serial(file_name: str) -> int:
    m = re.match(r"^(\d+)[-_]", str(file_name or ""))
    return int(m.group(1)) if m else 0


def _basename_from_key(key: str) -> str:
    idx = key.rfind("/")
    return key[idx + 1:] if idx >= 0 else key


def _split_base_ext(name: str) -> tuple:
    last_dot = name.rfind(".")
    if last_dot <= 0 or last_dot == len(name) - 1:
        return (name, "")
    return (name[:last_dot], name[last_dot:])


def _normalize_ext(ext: str) -> str:
    if not ext or ext == ".":
        return ""
    cleaned = ext.lstrip(".").lower()
    cleaned = re.sub(r"[^a-z0-9]", "", cleaned)
    return f".{cleaned}" if cleaned else ""


def _normalize_stem(stem: str) -> str:
    return re.sub(r"_+", "_", re.sub(r"[^a-z0-9_-]", "_", re.sub(r"\s+", "_", stem.lower()))).strip("_") or "file"


def _create_chat_artifacts_store(store, index_file_name: str = ".index.json"):
    """Port of createChatArtifactsStore."""

    def index_key(card_prefix: str) -> str:
        return f"{card_prefix}/{index_file_name}"

    def load_index(card_prefix: str) -> List[Dict[str, Any]]:
        raw = store.get_text(index_key(card_prefix))
        if not raw:
            return []
        try:
            parsed = json.loads(raw)
            if not isinstance(parsed, list):
                return []
            result = []
            for row in parsed:
                if not row or not isinstance(row.get("stored_name"), str):
                    continue
                result.append({
                    "serial": int(row.get("serial") or _parse_leading_serial(str(row["stored_name"])) or 0),
                    "role": str(row.get("role") or "system").lower(),
                    "stored_name": str(row["stored_name"]),
                    "path": row["path"] if isinstance(row.get("path"), str) else f"{card_prefix}/chats/{row['stored_name']}",
                    "updated_at": row["updated_at"] if isinstance(row.get("updated_at"), str) else None,
                })
            return result
        except Exception:
            return []

    def save_index(card_prefix: str, records: List[Dict[str, Any]]) -> None:
        store.put_text(index_key(card_prefix), json.dumps(records, indent=2), "application/json; charset=utf-8")

    def next_serial(card_prefix: str) -> int:
        index = load_index(card_prefix)
        max_seen = 0
        for row in index:
            serial = int(row.get("serial") or 0)
            if serial > max_seen:
                max_seen = serial
        return max_seen + 1

    def append_index_record(card_prefix: str, record: Dict[str, Any]) -> None:
        index = load_index(card_prefix)
        index.append(record)
        save_index(card_prefix, index)

    def read_records(card_prefix: str) -> List[Dict[str, Any]]:
        index = load_index(card_prefix)
        out = []
        for row in index:
            key = f"{card_prefix}/{row['stored_name']}"
            text = store.get_text(key)
            if text is None:
                continue
            out.append({
                "serial": int(row.get("serial") or _parse_leading_serial(row["stored_name"]) or 0),
                "role": str(row.get("role") or "system").lower(),
                "text": text,
                "path": row["path"] if isinstance(row.get("path"), str) else f"{card_prefix}/chats/{row['stored_name']}",
                "stored_name": row["stored_name"],
                "updated_at": row.get("updated_at"),
            })
        out.sort(key=lambda r: (r["serial"], r["stored_name"]))
        return out

    def clear(card_prefix: str) -> None:
        prefix = f"{card_prefix}/"
        for entry in store.list(prefix):
            store.remove(entry["key"])

    def read_signal(card_prefix: str) -> Dict[str, Any]:
        prefix = f"{card_prefix}/"
        entries = store.list(prefix)
        count = 0
        latest_mtime_ms = 0
        processing = False
        for entry in entries:
            name = entry["key"][len(prefix):]
            if name == ".processing":
                processing = True
                continue
            if not re.match(r"^(\d+)[-_]([a-z0-9_-]+)\.txt$", name, re.IGNORECASE):
                continue
            count += 1
            updated = entry.get("updatedAt")
            if updated:
                try:
                    mtime_ms = int(datetime.fromisoformat(updated.replace("Z", "+00:00")).timestamp() * 1000)
                except Exception:
                    mtime_ms = 0
                if mtime_ms > latest_mtime_ms:
                    latest_mtime_ms = mtime_ms
        return {"count": count, "latest_mtime_ms": latest_mtime_ms, "processing": processing}

    class _ChatStore:
        def __init__(self):
            pass

    _ChatStore.index_key = staticmethod(index_key)
    _ChatStore.load_index = staticmethod(load_index)
    _ChatStore.save_index = staticmethod(save_index)
    _ChatStore.next_serial = staticmethod(next_serial)
    _ChatStore.append_index_record = staticmethod(append_index_record)
    _ChatStore.read_records = staticmethod(read_records)
    _ChatStore.clear = staticmethod(clear)
    _ChatStore.read_signal = staticmethod(read_signal)

    return _ChatStore()


def _create_file_artifacts_store(store):
    """Port of createFileArtifactsStore."""

    def next_serial(card_prefix: str, seed_names: Optional[List[str]] = None) -> int:
        max_seen = 0
        names: List[str] = []
        if seed_names:
            names.extend(seed_names)
        for entry in store.list(f"{card_prefix}/"):
            names.append(_basename_from_key(entry["key"]))
        for name in names:
            serial = _parse_leading_serial(name)
            if serial > max_seen:
                max_seen = serial
        return max_seen + 1

    def build_stored_name(display_name: str, serial: int, max_len: int = 32) -> str:
        stem, ext = _split_base_ext(display_name)
        safe_ext = _normalize_ext(ext)
        safe_stem = _normalize_stem(stem)
        prefix = f"{str(serial).zfill(3)}-"

        keep_ext = safe_ext
        stem_budget = max_len - len(prefix) - len(keep_ext)
        if stem_budget < 1:
            keep_ext = ""
            stem_budget = max_len - len(prefix)

        out_stem = safe_stem[:max(1, stem_budget)]
        out = f"{prefix}{out_stem}{keep_ext}"
        if len(out) > max_len:
            out = out[:max_len].rstrip(".")
        return out

    def allocate_stored_name(card_prefix: str, display_name: str, seed_names: Optional[List[str]] = None, max_len: int = 32) -> str:
        serial = next_serial(card_prefix, seed_names)
        out = build_stored_name(display_name, serial, max_len)
        while store.exists(f"{card_prefix}/{out}"):
            serial += 1
            out = build_stored_name(display_name, serial, max_len)
        return out

    class _FileStore:
        def __init__(self):
            pass

    _FileStore.next_serial = staticmethod(next_serial)
    _FileStore.build_stored_name = staticmethod(build_stored_name)
    _FileStore.allocate_stored_name = staticmethod(allocate_stored_name)

    return _FileStore()


def _create_card_file_metadata_store():
    """Port of createCardFileMetadataStore."""

    def normalize_incoming(payload_files, default_uploaded_at: Optional[str] = None) -> List[Dict[str, Any]]:
        if not isinstance(payload_files, list):
            return []
        out = []
        for raw in payload_files:
            if not raw or not isinstance(raw, dict):
                continue
            if not isinstance(raw.get("stored_name"), str):
                continue
            out.append({
                "name": raw["name"] if isinstance(raw.get("name"), str) else raw["stored_name"],
                "stored_name": raw["stored_name"],
                "size": raw["size"] if isinstance(raw.get("size"), (int, float)) else None,
                "mime_type": raw["mime_type"] if isinstance(raw.get("mime_type"), str) else None,
                "path": raw["path"] if isinstance(raw.get("path"), str) else None,
                "uploaded_at": raw["uploaded_at"] if isinstance(raw.get("uploaded_at"), str) else default_uploaded_at,
            })
        return out

    def read(card_data) -> List[Dict[str, Any]]:
        if not card_data or not isinstance(card_data, dict):
            return []
        return normalize_incoming(card_data.get("files"))

    def merge(card_data: Dict[str, Any], incoming: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        existing = read(card_data)
        if not incoming:
            card_data["files"] = existing
            return existing
        known = set(f["stored_name"] for f in existing)
        for file in incoming:
            if file["stored_name"] not in known:
                existing.append(file)
                known.add(file["stored_name"])
        card_data["files"] = existing
        return existing

    def resolve(card_data, index: int, expected_stored_name: Optional[str] = None):
        files = read(card_data)
        if not isinstance(index, int) or index < 0 or index >= len(files):
            return {"ok": False, "reason": "index_out_of_range"}
        file = files[index]
        if not file or not file.get("stored_name"):
            return {"ok": False, "reason": "missing_stored_name"}
        if expected_stored_name and expected_stored_name != file["stored_name"]:
            return {"ok": False, "reason": "stale_reference"}
        return {"ok": True, "file": file}

    class _MetaStore:
        def __init__(self):
            pass

    _MetaStore.normalize_incoming = staticmethod(normalize_incoming)
    _MetaStore.read = staticmethod(read)
    _MetaStore.merge = staticmethod(merge)
    _MetaStore.resolve = staticmethod(resolve)

    return _MetaStore()


# ============================================================================
# Card store public (simplified port of card-store-lib-public)
# ============================================================================

def _create_card_store_public(card_store, warn_fn=None):
    """Port of createCardStorePublic from card-store-lib-public.ts."""

    class _CardStorePublic:
        def get(self, input_obj: Dict[str, Any] = None):
            try:
                input_obj = input_obj or {}
                params = input_obj.get("params") or {}
                card_id = params.get("id")
                if card_id:
                    card = card_store.read_card(card_id)
                    if card:
                        return {"status": "success", "data": {"cards": [card]}}
                    else:
                        return {"status": "fail", "error": f'card "{card_id}" not found'}
                else:
                    return {"status": "success", "data": {"cards": card_store.read_all_cards()}}
            except Exception as e:
                return {"status": "error", "error": str(e)}

        def set(self, input_obj: Dict[str, Any] = None):
            try:
                input_obj = input_obj or {}
                body = input_obj.get("body")
                if body is None:
                    return {"status": "fail", "error": "set requires a body (card object or array of cards)"}
                cards = body if isinstance(body, list) else [body]
                for card in cards:
                    if not isinstance(card.get("id"), str):
                        return {"status": "fail", "error": "each card must have a string `id` field"}
                    card_store.write_card(card["id"], card)
                return {"status": "success", "data": {"count": len(cards)}}
            except Exception as e:
                return {"status": "error", "error": str(e)}

        def delete(self, input_obj: Dict[str, Any] = None):
            try:
                input_obj = input_obj or {}
                body = input_obj.get("body") or {}
                params = input_obj.get("params") or {}
                ids = list(body.get("ids", []))
                single_id = params.get("id")
                if single_id:
                    ids.append(single_id)
                if not ids:
                    return {"status": "fail", "error": "del requires body.ids (string[]) or params.id"}
                for cid in ids:
                    card_store.remove_card(cid)
                return {"status": "success", "data": {"count": len(ids)}}
            except Exception as e:
                return {"status": "error", "error": str(e)}

        def patch(self, input_obj: Dict[str, Any] = None):
            try:
                input_obj = input_obj or {}
                params = input_obj.get("params") or {}
                card_id = params.get("id")
                path = params.get("path")
                if not card_id:
                    return {"status": "fail", "error": "patch requires params.id"}
                if not path:
                    return {"status": "fail", "error": "patch requires params.path"}
                body = input_obj.get("body")
                value = body.get("value") if body and isinstance(body, dict) and "value" in body else body
                card_store.patch_card(card_id, path, value)
                return {"status": "success", "data": {"count": 1}}
            except Exception as e:
                return {"status": "error", "error": str(e)}

    return _CardStorePublic()


def _create_card_store_from_kv(kv, warn_fn=None):
    """Create a card store adapter from a KV storage."""

    class _CardStoreAdapter:
        def read_index(self):
            return kv.read("_index") or {}

        def write_index(self, idx):
            kv.write("_index", idx)

        def read_card(self, card_id: str):
            idx = self.read_index()
            entry = idx.get(card_id)
            if not entry:
                return None
            key = entry.get("key", card_id)
            return kv.read(key)

        def read_all_cards(self) -> List[Dict[str, Any]]:
            idx = self.read_index()
            cards = []
            for card_id, entry in idx.items():
                key = entry.get("key", card_id)
                card = kv.read(key)
                if card:
                    cards.append(card)
            return cards

        def write_card(self, card_id: str, card: Any):
            idx = self.read_index()
            key = idx.get(card_id, {}).get("key", card_id)
            kv.write(key, card)
            idx[card_id] = {
                "key": key,
                "checksum": "",  # simplified
                "updatedAt": _now_iso(),
            }
            self.write_index(idx)

        def remove_card(self, card_id: str):
            idx = self.read_index()
            if card_id in idx:
                del idx[card_id]
                self.write_index(idx)

        def patch_card(self, card_id: str, path: str, value: Any):
            card = self.read_card(card_id)
            if not card or not isinstance(card, dict):
                raise ValueError(f'card "{card_id}" not found')
            parts = [p for p in path.split(".") if p]
            target = card
            for p in parts[:-1]:
                if not isinstance(target.get(p), dict):
                    target[p] = {}
                target = target[p]
            target[parts[-1]] = value
            self.write_card(card_id, card)

    return _CardStoreAdapter()


# ============================================================================
# createSingleBoardServerRuntime
# ============================================================================

def create_single_board_server_runtime(options: Dict[str, Any]):
    """
    Port of createSingleBoardServerRuntime from src/server-runtime/index.ts.
    Exact step-by-step parity.
    """
    api_base_path = str(options.get("api_base_path") or "/api/board").rstrip("/")
    cors_headers = {**DEFAULT_CORS_HEADERS, **(options.get("cors_headers") or {})}
    board_id = options.get("board_id") or ""
    logger = options.get("logger") or _DefaultLogger()
    invocation_adapter = options["invocation_adapter"]
    notification_transport = options.get("notification_transport")
    server_url = options.get("server_url")
    execution_extra = options.get("execution_extra") or {}

    sse_clients: Set[Any] = set()

    # ── Build board contexts from injected configs ───────────────────────────

    def build_context(cfg: Dict[str, Any]) -> Dict[str, Any]:
        board = create_board_live_cards_public(cfg["base_ref"], cfg["board_adapter"])
        kv = cfg["board_adapter"].kv_storage_for_ref(cfg["card_store_ref"])
        card_store_adapter = _create_card_store_from_kv(kv, logger.warn)
        card_store = _create_card_store_public(card_store_adapter, logger.warn)
        art_adapter = cfg.get("artifacts_adapter") or cfg["board_adapter"]

        _files_artifacts = [None]
        _chats_artifacts = [None]

        def get_files_artifacts():
            if _files_artifacts[0] is None:
                _files_artifacts[0] = _create_artifacts_store(art_adapter.blob_storage("files"))
            return _files_artifacts[0]

        def get_chats_artifacts():
            if _chats_artifacts[0] is None:
                _chats_artifacts[0] = _create_artifacts_store(art_adapter.blob_storage("chats"))
            return _chats_artifacts[0]

        return {
            "label": cfg["label"],
            "board": board,
            "card_store": card_store,
            "get_files_artifacts": get_files_artifacts,
            "get_chats_artifacts": get_chats_artifacts,
            "card_store_ref": cfg["card_store_ref"],
            "outputs_store_ref": cfg["outputs_store_ref"],
            "notify_ref": cfg.get("notify_ref"),
            "task_executor_ref": cfg.get("task_executor_ref"),
            "chat_handler_ref": cfg.get("chat_handler_ref"),
            "inference_adapter_ref": cfg.get("inference_adapter_ref"),
            "notification": _make_notification_state(),
            "notification_teardown": None,
            "initialized": False,
            "cards_bootstrapped": False,
        }

    board_contexts = [build_context(b) for b in options["boards"]]

    # Wire each adapter's publish_board_change_notifications to feed in-process
    # notification state.
    for i, ctx in enumerate(board_contexts):
        adapter = options["boards"][i]["board_adapter"]
        orig_publish = getattr(adapter, "publish_board_change_notifications", None)

        def _make_publish_hook(ctx_ref, orig_fn):
            def hooked_publish(notifications):
                for n in notifications:
                    _append_notification(ctx_ref["notification"], n)
                broadcast_notification_batch_to_sse_clients(notifications)
                if orig_fn:
                    orig_fn(notifications)
            return hooked_publish

        adapter.publish_board_change_notifications = _make_publish_hook(ctx, orig_publish)

    card_owner_index: Dict[str, int] = {}

    def owner_index(card_id: str) -> int:
        return card_owner_index.get(card_id, 0)

    # ── Artifacts stores ─────────────────────────────────────────────────────

    def artifacts_stores(card_id: str):
        ctx = board_contexts[owner_index(card_id)]
        return {
            "files": ctx["get_files_artifacts"]() if ctx else None,
            "chats": ctx["get_chats_artifacts"]() if ctx else None,
        }

    def chat_artifacts_for_card(card_id: str):
        stores = artifacts_stores(card_id)
        if not stores["chats"]:
            return None
        return _create_chat_artifacts_store(stores["chats"], ".index.json")

    def file_artifacts_for_card(card_id: str):
        stores = artifacts_stores(card_id)
        if not stores["files"]:
            return None
        return _create_file_artifacts_store(stores["files"])

    def card_file_metadata_store_instance():
        return _create_card_file_metadata_store()

    # ── Card ID tracking ─────────────────────────────────────────────────────

    def safe_card_id(card_id: str) -> str:
        return re.sub(r"[^a-zA-Z0-9_-]", "_", str(card_id or "")) or "unknown-card"

    # ── Notification transport ───────────────────────────────────────────────

    def ensure_notification_consumer(ctx: Dict[str, Any]) -> None:
        if not ctx or ctx.get("notification_teardown"):
            return
        if not notification_transport or not ctx.get("notify_ref"):
            return

        def _handle_transport_event(event):
            _append_notification(ctx["notification"], event)
            if isinstance(event, dict) and event.get("kind") == "notification-batch" and isinstance(event.get("notifications"), list):
                notifications = event["notifications"]
            else:
                notifications = [event]
            broadcast_notification_batch_to_sse_clients(notifications)

        teardown = notification_transport.subscribe(ctx["notify_ref"], _handle_transport_event)
        ctx["notification_teardown"] = teardown

    # ── Init & bootstrap ─────────────────────────────────────────────────────

    def init_context(ctx: Dict[str, Any]) -> None:
        if not ctx or ctx.get("initialized"):
            return

        params = {
            "cardStoreRef": ctx["card_store_ref"],
            "outputsStoreRef": ctx["outputs_store_ref"],
        }
        body: Dict[str, Any] = {}
        if ctx.get("task_executor_ref"):
            body["task-executor-ref"] = ctx["task_executor_ref"]
        if ctx.get("chat_handler_ref"):
            body["chat-handler-ref"] = ctx["chat_handler_ref"]
        if ctx.get("inference_adapter_ref"):
            body["inference-adapter-ref"] = ctx["inference_adapter_ref"]

        init_result = ctx["board"].init({"params": params, "body": body})
        if init_result.get("status") != "success":
            raise RuntimeError(init_result.get("error") or f"init failed for {ctx['label']}")

        ensure_notification_consumer(ctx)

        # Pre-init validation: describe chat-handler if adapter supports it
        if ctx.get("chat_handler_ref") and hasattr(invocation_adapter, "describe"):
            try:
                desc = invocation_adapter.describe(ctx["chat_handler_ref"])
                if desc and desc.get("kind") != "chat-handler":
                    logger.warn(f'[init] chat-handler describe returned kind="{desc.get("kind")}", expected "chat-handler" for {ctx["label"]}')
                elif desc:
                    logger.info(f'[init] chat-handler validated: {desc.get("name")} (protocol {desc.get("protocolVersion")}) for {ctx["label"]}')
            except Exception as err:
                logger.warn(f'[init] chat-handler describe failed for {ctx["label"]}: {err}')

        ctx["initialized"] = True

    def upsert_cards_from_source(ctx: Dict[str, Any], ctx_index: int) -> None:
        if not ctx or ctx.get("cards_bootstrapped"):
            return
        result = ctx["card_store"].get({})
        cards = (result.get("data", {}).get("cards", [])
                 if result.get("status") == "success" else [])
        for card in cards:
            if not isinstance(card.get("id"), str):
                continue
            card_owner_index[card["id"]] = ctx_index
            ctx["board"].upsert_card({"params": {"cardId": card["id"]}})
        ctx["board"].process_accumulated_events({})
        ctx["cards_bootstrapped"] = True

    def init_board_and_setup() -> None:
        for ctx in board_contexts:
            init_context(ctx)

    def bootstrap_board() -> None:
        init_board_and_setup()
        for i, ctx in enumerate(board_contexts):
            upsert_cards_from_source(ctx, i)

    # ── Card reads ───────────────────────────────────────────────────────────

    def card_context_for_card(card_id: str):
        idx = owner_index(card_id)
        return board_contexts[idx] if idx < len(board_contexts) else None

    def read_card_from_store(card_id: str):
        ctx = card_context_for_card(card_id)
        if not ctx:
            return None
        result = ctx["card_store"].get({"params": {"id": card_id}})
        if result.get("status") != "success":
            return None
        cards = result.get("data", {}).get("cards", [])
        return cards[0] if cards else None

    def read_card_definitions() -> List[Dict[str, Any]]:
        all_cards = []
        for ctx in board_contexts:
            result = ctx["card_store"].get({})
            if result.get("status") == "success" and isinstance(result.get("data", {}).get("cards"), list):
                all_cards.extend(result["data"]["cards"])
        return all_cards

    # ── Status & runtime artifacts ───────────────────────────────────────────

    def read_status_snapshot():
        statuses = [ctx["notification"]["status"] for ctx in board_contexts if ctx["notification"]["status"]]
        if not statuses:
            return None
        if len(statuses) == 1:
            return statuses[0]
        # Merge multiple board statuses
        merged_cards = []
        summary_keys = ["completed", "eligible", "pending", "blocked", "unresolved", "failed", "in_progress", "orphan_cards"]
        totals = {k: 0 for k in summary_keys}
        for status in statuses:
            cards = status.get("cards", []) if isinstance(status, dict) else []
            merged_cards.extend(cards)
            for k in summary_keys:
                totals[k] += int((status.get("summary") or {}).get(k) or 0)
        first = statuses[0]
        return {
            **first,
            "cards": merged_cards,
            "summary": {
                **(first.get("summary") or {}),
                "card_count": len(merged_cards),
                **totals,
            },
        }

    def read_card_runtime_artifacts() -> Dict[str, Any]:
        out = {}
        for ctx in board_contexts:
            for card_id, values in ctx["notification"]["computedValues"].items():
                card = ctx["notification"]["cards"].get(card_id)
                out[card_id] = {
                    "schema_version": "v1",
                    "card_id": card_id,
                    "card_data": (card or {}).get("card_data", {}) if isinstance(card, dict) else {},
                    "computed_values": values or {},
                    "fetched_sources": {},
                    "requires": {},
                }
        return out

    def read_source_payloads(card_def: Dict[str, Any]) -> Dict[str, Any]:
        out = {}
        if not isinstance(card_def.get("source_defs"), list):
            return out
        ctx = board_contexts[owner_index(card_def.get("id", ""))]
        data_objects = ctx["notification"]["dataObjects"] if ctx else {}
        for sd in card_def["source_defs"]:
            if not sd or not sd.get("bindTo"):
                continue
            if sd["bindTo"] in data_objects:
                out[sd["bindTo"]] = data_objects[sd["bindTo"]]
        return out

    def read_data_objects_by_token() -> Dict[str, Any]:
        merged = {}
        for ctx in board_contexts:
            merged.update(ctx["notification"]["dataObjects"] or {})
        return merged

    def read_chat_signal(card_id: str) -> Dict[str, Any]:
        sid = safe_card_id(card_id)
        chat_store = chat_artifacts_for_card(card_id)
        if not chat_store:
            return {"count": 0, "latest_mtime_ms": 0, "processing": False}
        return chat_store.read_signal(sid)

    def build_published_runtime_payload():
        card_definitions = read_card_definitions()
        raw_artifacts = read_card_runtime_artifacts()
        data_objects_by_token = read_data_objects_by_token()
        card_runtime_by_id = {}

        for card_def in card_definitions:
            if not card_def or not card_def.get("id"):
                continue
            cid = card_def["id"]
            raw = raw_artifacts.get(cid) or {}
            sources = read_source_payloads(card_def)
            chat_signal = read_chat_signal(cid)
            card_data = {
                **(raw.get("card_data") if isinstance(raw.get("card_data"), dict) else
                   card_def.get("card_data") if isinstance(card_def.get("card_data"), dict) else {}),
                "__chat_signal": chat_signal,
            }
            card_runtime_by_id[cid] = {
                "schema_version": raw.get("schema_version") or "v1",
                "card_id": raw.get("card_id") or cid,
                "card_data": card_data,
                "computed_values": raw.get("computed_values") if isinstance(raw.get("computed_values"), dict) else {},
                "fetched_sources": sources,
                "requires": raw.get("requires") if isinstance(raw.get("requires"), dict) else {},
            }

        return {
            "cardDefinitions": card_definitions,
            "statusSnapshot": read_status_snapshot(),
            "dataObjectsByToken": data_objects_by_token,
            "cardRuntimeById": card_runtime_by_id,
        }

    # ── Card mutations ───────────────────────────────────────────────────────

    def mutate_card(card_id: str, update_fn, opts=None):
        sync_board = (opts or {}).get("syncBoard", True)
        ctx = card_context_for_card(card_id)
        if not ctx:
            raise _HttpError(f"Card not found: {card_id}", 404)
        card = read_card_from_store(card_id)
        if not card:
            raise _HttpError(f"Card not found: {card_id}", 404)
        next_card = update_fn(card) or card
        set_result = ctx["card_store"].set({"body": next_card})
        if set_result.get("status") != "success":
            raise _HttpError(set_result.get("error") or f"Failed to persist card: {card_id}", 500)
        if sync_board:
            upsert_result = ctx["board"].upsert_card({"params": {"cardId": card_id, "restart": True}})
            if upsert_result.get("status") != "success":
                raise _HttpError(upsert_result.get("error") or f"Failed to upsert card: {card_id}", 500)

    def update_card(card_id: str, update_fn):
        mutate_card(card_id, update_fn, {"syncBoard": True})

    def update_card_local_only(card_id: str, update_fn):
        mutate_card(card_id, update_fn, {"syncBoard": False})

    def patch_card(card_id: str, patch: Dict[str, Any]):
        def _do_patch(card):
            if not patch or not isinstance(patch, dict) or not patch:
                return card

            def deep_set(obj, dotted_path, value):
                parts = [p for p in str(dotted_path or "").split(".") if p]
                if not parts:
                    return
                target = obj
                for p in parts[:-1]:
                    if not isinstance(target.get(p), dict):
                        target[p] = {}
                    target = target[p]
                target[parts[-1]] = value

            if "fieldValues" in patch and isinstance(patch["fieldValues"], dict):
                write_to = None
                view = card.get("view")
                if view and isinstance(view.get("elements"), list):
                    for elem in view["elements"]:
                        if elem and isinstance(elem.get("data"), dict) and elem["data"].get("writeTo"):
                            write_to = elem["data"]["writeTo"]
                            break
                if write_to:
                    deep_set(card, write_to, patch["fieldValues"])
                else:
                    card["card_data"] = {**(card.get("card_data") or {}), **patch["fieldValues"]}
            elif isinstance(patch.get("_stagedFiles"), list) and patch["_stagedFiles"]:
                return card
            else:
                for key, value in patch.items():
                    if key == "_stagedFiles":
                        continue
                    if (value is not None and isinstance(value, dict) and not isinstance(value, list) and
                            card.get(key) is not None and isinstance(card.get(key), dict) and not isinstance(card.get(key), list)):
                        card[key] = {**card[key], **value}
                    else:
                        card[key] = value
            return card

        update_card(card_id, _do_patch)

    # ── Chat & file operations ───────────────────────────────────────────────

    def normalize_display_file_name(name: str) -> str:
        input_s = str(name or "").strip()
        if not input_s:
            return "upload.bin"
        last_slash = max(input_s.rfind("/"), input_s.rfind("\\"))
        base = input_s[last_slash + 1:] if last_slash >= 0 else input_s
        return base or "upload.bin"

    def clear_chat_records(card_id: str) -> None:
        sid = safe_card_id(card_id)
        chat_store = chat_artifacts_for_card(card_id)
        if not chat_store:
            return
        chat_store.clear(sid)

    def next_chat_stored_name(card_id: str, role: str) -> str:
        sid = safe_card_id(card_id)
        chat_store = chat_artifacts_for_card(card_id)
        serial = chat_store.next_serial(sid) if chat_store else 1
        safe_role = re.sub(r"[^a-z0-9_-]", "_", str(role or "system").lower()) or "system"
        return f"{str(serial).zfill(3)}_{safe_role}.txt"

    def write_chat_record(card_id: str, role: str, text: str, files: List[Dict[str, Any]]) -> Dict[str, Any]:
        now = _now_iso()
        sid = safe_card_id(card_id)
        stores = artifacts_stores(card_id)
        out_name = next_chat_stored_name(card_id, role or "system")
        artifact_key = f"{sid}/{out_name}"

        lines = []
        msg = str(text or "").strip()
        if msg:
            lines.append(msg)
        file_list = files if isinstance(files, list) else []
        if file_list:
            if lines:
                lines.append("")
            lines.append("files:")
            for f in file_list:
                if not f or not isinstance(f, dict):
                    continue
                display = f.get("name", "file") if isinstance(f.get("name"), str) else "file"
                stored = f.get("stored_name", "") if isinstance(f.get("stored_name"), str) else ""
                lines.append(f"- {display} -> {stored}" if stored else f"- {display}")

        if stores["chats"]:
            stores["chats"].put_text(artifact_key, "\n".join(lines) + "\n")

        serial = _parse_leading_serial(out_name)
        chat_store = chat_artifacts_for_card(card_id)
        if chat_store:
            chat_store.append_index_record(sid, {
                "serial": serial,
                "role": role or "system",
                "stored_name": out_name,
                "path": f"{card_id}/chats/{out_name}",
                "updated_at": now,
            })
        return {"at": now, "role": role or "system", "text": msg, "files": file_list, "path": f"{card_id}/chats/{out_name}"}

    def read_chat_records(card_id: str) -> List[Dict[str, Any]]:
        sid = safe_card_id(card_id)
        chat_store = chat_artifacts_for_card(card_id)
        if not chat_store:
            return []
        return [
            {**row, "path": f"{card_id}/chats/{row['stored_name']}"}
            for row in chat_store.read_records(sid)
        ]

    def read_card_stored_file_names(card_id: str) -> List[str]:
        names = []
        try:
            card = read_card_from_store(card_id)
            if not card:
                return names
            metadata = card_file_metadata_store_instance().read(card.get("card_data") if isinstance(card.get("card_data"), dict) else None)
            for entry in metadata:
                names.append(entry["stored_name"])
        except Exception:
            pass
        return names

    def persist_uploaded_file(card_id: str, requested_name: str, content_type: str, buffer: bytes) -> Dict[str, Any]:
        sid = safe_card_id(card_id)
        stores = artifacts_stores(card_id)
        display_name = normalize_display_file_name(requested_name)
        file_store = file_artifacts_for_card(card_id)
        stored_name = (
            file_store.allocate_stored_name(
                sid, display_name,
                seed_names=read_card_stored_file_names(card_id),
                max_len=MAX_STORED_FILE_NAME_LEN,
            )
            if file_store
            else f"{int(datetime.now(timezone.utc).timestamp() * 1000)}-{display_name}"
        )

        if stores["files"]:
            stores["files"].put_bytes(f"{sid}/{stored_name}", buffer, content_type or "application/octet-stream")

        return {
            "name": display_name,
            "stored_name": stored_name,
            "size": len(buffer),
            "mime_type": content_type or "application/octet-stream",
            "path": f"{card_id}/files/{stored_name}",
            "uploaded_at": _now_iso(),
        }

    # ── Chat handler invocation ──────────────────────────────────────────────

    def invoke_chat_handler(card_id: str, chats_key_prefix: str, last_chat_file: str) -> None:
        ctx = card_context_for_card(card_id)
        if not ctx:
            return

        cfg_result = ctx["board"].get_config({"params": {"key": "chat-handler"}})
        if cfg_result.get("status") != "success":
            return
        handler_ref = (cfg_result.get("data") or {}).get("value")
        if not handler_ref or not isinstance(handler_ref, dict):
            return

        sid = safe_card_id(card_id)
        stores = artifacts_stores(card_id)
        processing_marker_key = f"{sid}/.processing"
        try:
            if stores["chats"]:
                stores["chats"].put_text(processing_marker_key, "", "text/plain; charset=utf-8")
        except Exception:
            pass

        args = {
            "boardId": board_id,
            "cardId": str(card_id),
            "chatsKeyPrefix": chats_key_prefix,
            "chatProcessingMarkerKey": processing_marker_key,
            "lastChatFile": last_chat_file,
            **execution_extra,
            **({"serverUrl": server_url} if server_url else {}),
        }

        try:
            result = invocation_adapter.invoke(handler_ref, args)
            if result.get("dispatched"):
                logger.info(f'[chat-handler] invoked for card "{card_id}" (boardId: "{board_id}")')
            else:
                try:
                    if stores["chats"]:
                        stores["chats"].remove(processing_marker_key)
                except Exception:
                    pass
                logger.warn(f'[chat-handler] dispatch failed for card "{card_id}": {result.get("error") or "unknown"}')
        except Exception as err:
            try:
                if stores["chats"]:
                    stores["chats"].remove(processing_marker_key)
            except Exception:
                pass
            logger.warn(f'[chat-handler] invoke failed for card "{card_id}": {err}')

    # ── Card actions ─────────────────────────────────────────────────────────

    def apply_card_action(card_id: str, action_type: str, payload: Optional[Dict[str, Any]]) -> None:
        persist_card = update_card_local_only if action_type == "chat-send" else update_card
        chat_handler_result = [None]

        def _action_updater(card):
            now = _now_iso()
            card_data = card.get("card_data") if isinstance(card.get("card_data"), dict) else {}
            card["card_data"] = card_data

            if action_type == "chat-send":
                text = payload.get("text", "").strip() if payload and isinstance(payload.get("text"), str) else ""
                files = []
                if payload and isinstance(payload.get("files"), list):
                    for f in payload["files"]:
                        if not f:
                            continue
                        if isinstance(f, str):
                            files.append({"name": f})
                            continue
                        if isinstance(f, dict) and isinstance(f.get("name"), str):
                            files.append({
                                "name": f["name"],
                                "size": f.get("size"),
                                "mime_type": f.get("mime_type"),
                                "path": f.get("path"),
                                "uploaded_at": f.get("uploaded_at"),
                                "stored_name": f.get("stored_name"),
                            })

                if text or files:
                    sid = safe_card_id(card_id)
                    user_record = write_chat_record(card_id, "user", text, files)
                    rec_path = user_record["path"]
                    last_seg = rec_path[rec_path.rfind("/") + 1:] if "/" in rec_path else rec_path
                    chat_handler_result[0] = {"chatsKeyPrefix": f"{sid}/chats", "lastChatFile": last_seg}
                    for file in files:
                        if not file or not isinstance(file, dict):
                            continue
                        display = file.get("name", "file") if isinstance(file.get("name"), str) else "file"
                        stored = file.get("stored_name") if isinstance(file.get("stored_name"), str) else None
                        if not stored:
                            continue
                        write_chat_record(card_id, "system", f"File {display} uploaded as {stored}.", [])
                return card

            if action_type == "file-upload":
                files = card_file_metadata_store_instance().normalize_incoming(
                    (payload or {}).get("files"), now
                )
                if files:
                    card_file_metadata_store_instance().merge(card_data, files)
                return card

            if action_type == "action":
                button_id = payload.get("buttonId", "") if payload and isinstance(payload.get("buttonId"), str) else ""
                if not button_id:
                    return card
                card_data["lastAction"] = {"buttonId": button_id, "at": now}
                card_data["lastActionText"] = f"{button_id} @ {now}"

            return card

        persist_card(card_id, _action_updater)

        if chat_handler_result[0]:
            invoke_chat_handler(card_id, chat_handler_result[0]["chatsKeyPrefix"], chat_handler_result[0]["lastChatFile"])

    # ── HTTP helpers ─────────────────────────────────────────────────────────

    def json_response(res, status: int, payload):
        body = json.dumps(payload)
        byte_len = len(body.encode("utf-8"))
        res.write_head(status, {
            **cors_headers,
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": str(byte_len),
        })
        res.end(body)

    # ── SSE ──────────────────────────────────────────────────────────────────

    sse_event_id = [0]

    def build_sse_frame(payload) -> str:
        json_str = json.dumps(payload)
        sse_event_id[0] += 1
        return f"id: {sse_event_id[0]}\ndata: {json_str}\n\n"

    def broadcast_to_sse_clients():
        payload = build_published_runtime_payload()
        frame = build_sse_frame(payload)
        dead = set()
        for client in sse_clients:
            try:
                client.write(frame)
            except Exception:
                dead.add(client)
        sse_clients.difference_update(dead)

    def broadcast_notification_batch_to_sse_clients(notifications):
        if not notifications:
            return
        frame = build_sse_frame({"kind": "notification-batch", "notifications": notifications})
        dead = set()
        for client in sse_clients:
            try:
                client.write(frame)
            except Exception:
                dead.add(client)
        sse_clients.difference_update(dead)

    def handle_sse(req, res):
        res.write_head(200, {
            **cors_headers,
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        })
        sse_clients.add(res)
        payload = build_published_runtime_payload()
        frame = build_sse_frame(payload)
        res.write(frame)
        # Note: keepalive and close handling done by the host HTTP layer

    # ── Route handler ────────────────────────────────────────────────────────

    def handle_runtime_api(req, res, parsed_url) -> bool:
        method = req.method
        p = parsed_url.path

        try:
            if method == "GET" and p == f"{api_base_path}/init-board":
                init_board_and_setup()
                json_response(res, 200, build_published_runtime_payload())
                return True

            if method == "GET" and p in (f"{api_base_path}/bootstrap-cards", f"{api_base_path}/bootstrap"):
                bootstrap_board()
                # Fire a catch-up notification batch using the board public API so
                # that ctx["notification"] is populated before the caller reads
                # build_published_runtime_payload(). This covers the page-refresh
                # case where the graph is already completed and the drain cycle
                # produces no new notifications.
                for ctx in board_contexts:
                    adapter = ctx["board_adapter"]
                    publish_fn = getattr(adapter, "publish_board_change_notifications", None)
                    if not callable(publish_fn):
                        continue
                    notifications: List[Dict[str, Any]] = []
                    status_result = ctx["board"].status({})
                    if status_result.get("status") == "success" and status_result.get("data") is not None:
                        notifications.append({"kind": "status", "status": status_result["data"]})
                    data_result = ctx["board"].get_all_outputs_data_objects({})
                    if data_result.get("status") == "success" and data_result.get("data") is not None:
                        for token, payload in (data_result["data"] or {}).items():
                            if token:
                                notifications.append({"kind": "data_object", "key": token, "payload": payload})
                    cv_result = ctx["board"].get_all_outputs_computed_values({})
                    if cv_result.get("status") == "success" and cv_result.get("data") is not None:
                        for card_id_key, values in (cv_result["data"] or {}).items():
                            if card_id_key:
                                notifications.append({"kind": "computed_values", "cardId": card_id_key, "values": values})
                    if notifications:
                        publish_fn(notifications)
                json_response(res, 200, build_published_runtime_payload())
                return True

            if method == "GET" and p == f"{api_base_path}/sse":
                bootstrap_board()
                handle_sse(req, res)
                return True

            if method == "GET" and p == f"{api_base_path}/board-status":
                payload = build_published_runtime_payload()
                payload["boardId"] = board_id
                json_response(res, 200, payload)
                return True

            # PATCH /cards/:id
            card_match = re.match(f"^{_escape_regexp(api_base_path)}/cards/([^/]+)$", p)
            if method == "PATCH" and card_match:
                bootstrap_board()
                card_id = unquote(card_match.group(1))
                body = json.loads(req.read_body().decode("utf-8") or "{}")
                patch_card(card_id, body)
                json_response(res, 200, {"ok": True})
                return True

            # POST /cards/:id/actions
            card_action_match = re.match(f"^{_escape_regexp(api_base_path)}/cards/([^/]+)/actions$", p)
            if method == "POST" and card_action_match:
                bootstrap_board()
                card_id = unquote(card_action_match.group(1))
                body = json.loads(req.read_body().decode("utf-8") or "{}")
                apply_card_action(card_id, body.get("actionType", ""), body.get("payload"))
                json_response(res, 200, {"ok": True})
                return True

            # GET /cards/:id/chats
            card_chats_match = re.match(f"^{_escape_regexp(api_base_path)}/cards/([^/]+)/chats$", p)
            if method == "GET" and card_chats_match:
                bootstrap_board()
                card_id = unquote(card_chats_match.group(1))
                json_response(res, 200, {"ok": True, "messages": read_chat_records(card_id)})
                return True

            # POST /cards/:id/files
            card_file_match = re.match(f"^{_escape_regexp(api_base_path)}/cards/([^/]+)/files$", p)
            if method == "POST" and card_file_match:
                bootstrap_board()
                card_id = unquote(card_file_match.group(1))
                in_chat = (parsed_url.query_params.get("inChat") or "").lower() == "true"
                encoded_name = req.headers.get("x-file-name")
                content_type = req.headers.get("content-type", "application/octet-stream")
                requested_name = unquote(encoded_name) if encoded_name else "upload.bin"
                body = req.read_body()
                if not body:
                    json_response(res, 400, {"error": "Empty upload body"})
                    return True

                file = persist_uploaded_file(card_id, requested_name, content_type, body)
                if in_chat:
                    def _in_chat_updater(card):
                        now = _now_iso()
                        card_data = card.get("card_data") if isinstance(card.get("card_data"), dict) else {}
                        card["card_data"] = card_data
                        incoming = card_file_metadata_store_instance().normalize_incoming([{
                            "name": file["name"],
                            "stored_name": file["stored_name"],
                            "size": file["size"],
                            "mime_type": file["mime_type"],
                            "path": file["path"],
                            "uploaded_at": file.get("uploaded_at") or now,
                        }], now)
                        card_file_metadata_store_instance().merge(card_data, incoming)
                        return card
                    update_card_local_only(card_id, _in_chat_updater)
                    write_chat_record(card_id, "system", f"file uploaded: {file['name']} as {file['stored_name']}", [])
                json_response(res, 200, {"ok": True, "file": file})
                return True

            # GET /cards/:id/files/:idx
            card_file_dl_match = re.match(f"^{_escape_regexp(api_base_path)}/cards/([^/]+)/files/(\\d+)$", p)
            if method == "GET" and card_file_dl_match:
                card_id = unquote(card_file_dl_match.group(1))
                idx = int(card_file_dl_match.group(2))
                expected_sn = parsed_url.query_params.get("sn")
                card = read_card_from_store(card_id)
                if not card:
                    json_response(res, 404, {"error": "Card not found"})
                    return True

                resolved = card_file_metadata_store_instance().resolve(card.get("card_data"), idx, expected_sn)
                if not resolved["ok"] and resolved.get("reason") == "stale_reference":
                    json_response(res, 409, {"error": "File reference is stale. Refresh and try again."})
                    return True
                if not resolved["ok"]:
                    json_response(res, 404, {"error": "File not found"})
                    return True

                file_record = resolved["file"]
                sid = safe_card_id(card_id)
                stores = artifacts_stores(card_id)
                file_key = f"{sid}/{file_record['stored_name']}"
                file_bytes = stores["files"].get_bytes(file_key) if stores["files"] else None
                if not file_bytes:
                    json_response(res, 404, {"error": "File not found"})
                    return True

                filename = file_record.get("name") or file_record["stored_name"]
                mime_type = file_record.get("mime_type") or "application/octet-stream"
                res.write_head(200, {
                    "Content-Type": mime_type,
                    "Content-Disposition": f'attachment; filename="{filename}"',
                    "Content-Length": str(len(file_bytes)),
                })
                res.end(file_bytes)
                return True

            return False

        except _HttpError as err:
            json_response(res, err.status_code, {"error": str(err)})
            return True
        except Exception as err:
            json_response(res, 500, {"error": str(err)})
            return True

    # ── Return runtime object ────────────────────────────────────────────────

    class _SingleBoardRuntime:
        @property
        def api_base_path(self):
            return api_base_path

        @property
        def cors_headers(self):
            return cors_headers

        @property
        def card_store(self):
            return board_contexts[0]["card_store"] if board_contexts else None

    _SingleBoardRuntime.handle_runtime_api = staticmethod(handle_runtime_api)
    _SingleBoardRuntime.build_published_runtime_payload = staticmethod(build_published_runtime_payload)
    _SingleBoardRuntime.clear_chat_records = staticmethod(clear_chat_records)

    return _SingleBoardRuntime()


# ============================================================================
# createMultiBoardServerRuntime
# ============================================================================

def create_multi_board_server_runtime(options: Dict[str, Any]):
    """
    Port of createMultiBoardServerRuntime from src/server-runtime/index.ts.
    Exact step-by-step parity.
    """
    api_base_path = str(options.get("api_base_path") or "/api/boards").rstrip("/")
    cors_headers = {**DEFAULT_CORS_HEADERS, **(options.get("cors_headers") or {})}
    server_meta_store = options["server_meta_store"]
    board_runtime_factory = options["board_runtime_factory"]
    logger = options.get("logger") or _DefaultLogger()

    board_service_cache: Dict[str, Any] = {}
    boards_registry_key = "boards-config.json"

    def read_boards_config():
        raw = server_meta_store.get_text(boards_registry_key)
        if not raw:
            return {"boards": [{"id": "default", "label": "Default Board"}]}
        try:
            return json.loads(raw)
        except Exception:
            return {"boards": [{"id": "default", "label": "Default Board"}]}

    def write_boards_config(config):
        server_meta_store.put_text(boards_registry_key, json.dumps(config, indent=2))

    def safe_board_id(raw) -> Optional[str]:
        sanitized = re.sub(r"[^a-zA-Z0-9_-]", "_", str(raw or "")).strip("_")
        return sanitized if 0 < len(sanitized) <= 64 else None

    def get_board_service(board_id: str):
        if board_id in board_service_cache:
            return board_service_cache[board_id]
        config = read_boards_config()
        entry = next((b for b in config["boards"] if b.get("id") == board_id), {})
        service = board_runtime_factory(board_id, entry)
        board_service_cache[board_id] = service
        return service

    def json_response(res, status: int, payload):
        body = json.dumps(payload)
        byte_len = len(body.encode("utf-8"))
        res.write_head(status, {
            **cors_headers,
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": str(byte_len),
        })
        res.end(body)

    def handle_boards_registry_api(req, res, parsed_url) -> bool:
        method = req.method
        p = parsed_url.path

        if method == "GET" and p == api_base_path:
            json_response(res, 200, {"ok": True, "boards": read_boards_config()["boards"]})
            return True

        if method == "POST" and p == api_base_path:
            body_raw = req.read_body().decode("utf-8").strip()
            body = json.loads(body_raw) if body_raw else {}

            bid = safe_board_id(body.get("id"))
            if not bid:
                json_response(res, 400, {"error": "board id must be 1-64 alphanumeric/dash/underscore characters"})
                return True

            config = read_boards_config()
            if any(b.get("id") == bid for b in config["boards"]):
                json_response(res, 409, {"error": f'Board "{bid}" is already registered'})
                return True

            label = body.get("label", "").strip() if isinstance(body.get("label"), str) else bid
            entry = {"id": bid, "label": label or bid}
            for key, val in body.items():
                if key in ("id", "label"):
                    continue
                if val is not None:
                    entry[key] = val
            config["boards"].append(entry)
            write_boards_config(config)
            json_response(res, 200, {"ok": True, "board": entry})
            return True

        return False

    def handle_board_api(req, res, parsed_url) -> bool:
        p = parsed_url.path
        board_seg_match = re.match(f"^{_escape_regexp(api_base_path)}/([^/]+)(/|$)", p)
        if not board_seg_match:
            return False

        board_id = safe_board_id(unquote(board_seg_match.group(1)))
        if not board_id:
            json_response(res, 400, {"error": "Invalid board id"})
            return True

        config = read_boards_config()
        if not any(b.get("id") == board_id for b in config["boards"]):
            json_response(res, 404, {"error": f'Board "{board_id}" not registered. POST {api_base_path} with {{id}} to register it first.'})
            return True

        service = get_board_service(board_id)
        if service.handle_runtime_api(req, res, parsed_url):
            return True
        return False

    def handle_api(req, res, parsed_url) -> bool:
        if handle_boards_registry_api(req, res, parsed_url):
            return True
        if handle_board_api(req, res, parsed_url):
            return True
        return False

    def require_board_service(board_id: str):
        config = read_boards_config()
        if not any(b.get("id") == board_id for b in config["boards"]):
            raise _HttpError(f'Board "{board_id}" not registered', 404)
        return {"service": get_board_service(board_id)}

    class _MultiBoardRuntime:
        @property
        def api_base_path(self):
            return api_base_path

        @property
        def cors_headers(self):
            return cors_headers

    _MultiBoardRuntime.handle_api = staticmethod(handle_api)
    _MultiBoardRuntime.require_board_service = staticmethod(require_board_service)

    return _MultiBoardRuntime()


# ============================================================================
# Helpers
# ============================================================================

class _HttpError(Exception):
    def __init__(self, message: str, status_code: int = 500):
        super().__init__(message)
        self.status_code = status_code


class _DefaultLogger:
    def info(self, msg, *args):
        print(f"[INFO] {msg}", *args)

    def warn(self, msg, *args):
        print(f"[WARN] {msg}", *args)

    def error(self, msg, *args):
        print(f"[ERROR] {msg}", *args)
