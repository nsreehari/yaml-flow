#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from datetime import datetime
from typing import Any, Dict

_HERE = os.path.dirname(os.path.abspath(__file__))
_PYCLI_ROOT = os.path.normpath(os.path.join(_HERE, ".."))
if _PYCLI_ROOT not in sys.path:
    sys.path.insert(0, _PYCLI_ROOT)

from sub.board_live_cards_adapters import (
    ExecutionRef,
    FileAtomicRelayLock,
    FsBlobStorage,
    FsJournalStorageAdapter,
    FsKvStorage,
    compute_stable_json_hash,
    dispatch_execution,
    parse_execution_ref,
)
from sub.board_live_cards_quickjs_bridge import (
    QuickJsUnavailableError,
    invoke_js_bundle_function,
)
from sub.board_live_cards_state_snapshot import commit_snapshot, read_snapshot


DEFAULT_QUICKJS_BUNDLE = "dist/pycli/quickjs-board-runtime.global.js"


def _parse_json_file(file_path: str) -> Dict[str, Any]:
    with open(file_path, "r", encoding="utf-8") as f:
        value = json.load(f)
    if not isinstance(value, dict):
        raise ValueError(f"JSON root must be an object: {file_path}")
    return value


def _parse_any_json_file(file_path: str) -> Any:
    with open(file_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _print_json(value: Any) -> None:
    print(json.dumps(value, indent=2, ensure_ascii=True))


def _read_stdin_json() -> Any:
    if sys.stdin.isatty():
        return None
    raw = sys.stdin.read().strip()
    if not raw:
        return None
    return json.loads(raw)


def _resolve_bundle_path(bundle_arg: str | None) -> str:
    bundle = bundle_arg or DEFAULT_QUICKJS_BUNDLE
    if os.path.exists(bundle):
        return bundle
    # If called from outside yaml-flow dir, also try relative to this file.
    here = os.path.dirname(os.path.abspath(__file__))
    alt = os.path.normpath(os.path.join(here, "..", "..", bundle))
    return alt


def _decode_board_ref_from_token(token: str) -> str | None:
    try:
        pad = "=" * ((4 - (len(token) % 4)) % 4)
        raw = base64.urlsafe_b64decode((token + pad).encode("ascii")).decode("utf-8")
        payload = json.loads(raw)
        if isinstance(payload, dict):
            br = payload.get("br")
            if isinstance(br, str) and br:
                return br
    except Exception:
        return None
    return None


def _kv_root(scope: str, namespace: str) -> str:
    return f"{scope}/.{namespace}"


def _blob_root(scope: str, namespace: str) -> str:
    return f"{scope}/{namespace}" if namespace else scope


def cmd_read_snapshot(args: argparse.Namespace) -> int:
    view = read_snapshot(args.scope)
    _print_json({"version": view.version, "values": view.values})
    return 0


def cmd_commit_snapshot(args: argparse.Namespace) -> int:
    envelope = _parse_json_file(args.input)
    result = commit_snapshot(args.scope, envelope)
    if result.ok:
        _print_json({"ok": True, "newVersion": result.new_version})
        return 0

    _print_json({"ok": False, "reason": result.reason, "currentVersion": result.current_version})
    return 2


def cmd_kv_read(args: argparse.Namespace) -> int:
    kv = FsKvStorage(_kv_root(args.scope, args.namespace))
    _print_json({"value": kv.read(args.key)})
    return 0


def cmd_kv_write(args: argparse.Namespace) -> int:
    kv = FsKvStorage(_kv_root(args.scope, args.namespace))
    kv.write(args.key, _parse_any_json_file(args.input))
    _print_json({"ok": True})
    return 0


def cmd_kv_delete(args: argparse.Namespace) -> int:
    kv = FsKvStorage(_kv_root(args.scope, args.namespace))
    kv.delete(args.key)
    _print_json({"ok": True})
    return 0


def cmd_kv_list(args: argparse.Namespace) -> int:
    kv = FsKvStorage(_kv_root(args.scope, args.namespace))
    _print_json({"keys": kv.list_keys(args.prefix)})
    return 0


def cmd_blob_read(args: argparse.Namespace) -> int:
    blob = FsBlobStorage(_blob_root(args.scope, args.namespace))
    _print_json({"content": blob.read(args.key)})
    return 0


def cmd_blob_write(args: argparse.Namespace) -> int:
    blob = FsBlobStorage(_blob_root(args.scope, args.namespace))
    content = args.text if args.text is not None else str(_parse_any_json_file(args.input))
    blob.write(args.key, content)
    _print_json({"ok": True})
    return 0


def cmd_blob_exists(args: argparse.Namespace) -> int:
    blob = FsBlobStorage(_blob_root(args.scope, args.namespace))
    _print_json({"exists": blob.exists(args.key)})
    return 0


def cmd_blob_remove(args: argparse.Namespace) -> int:
    blob = FsBlobStorage(_blob_root(args.scope, args.namespace))
    blob.remove(args.key)
    _print_json({"ok": True})
    return 0


def cmd_journal_append(args: argparse.Namespace) -> int:
    journal = FsJournalStorageAdapter(args.scope)
    entry = {"id": journal.generate_id(), "event": _parse_any_json_file(args.input)}
    journal.append_entry(entry)
    _print_json({"ok": True, "id": entry["id"]})
    return 0


def cmd_journal_read_after(args: argparse.Namespace) -> int:
    journal = FsJournalStorageAdapter(args.scope)
    entries = journal.read_all_entries()
    if not args.cursor:
        sliced = entries
    else:
        idx = next((i for i, e in enumerate(entries) if e.get("id") == args.cursor), -1)
        sliced = entries if idx < 0 else entries[idx + 1 :]
    events = [e.get("event") for e in sliced]
    new_cursor = args.cursor if not sliced else sliced[-1].get("id")
    _print_json({"events": events, "newCursor": new_cursor})
    return 0


def cmd_lock_try(args: argparse.Namespace) -> int:
    lock = FileAtomicRelayLock(f"{args.scope}/.board.lock")
    release = lock.try_acquire()
    acquired = release is not None
    if release:
        release()
    _print_json({"acquired": acquired})
    return 0


def cmd_dispatch(args: argparse.Namespace) -> int:
    if args.ref_json:
        ref = parse_execution_ref(args.ref_json)
    else:
        ref = parse_execution_ref(_parse_any_json_file(args.ref_file))
    if not isinstance(ref, ExecutionRef):
        raise ValueError("Invalid execution ref")
    payload = _parse_any_json_file(args.input)
    if not isinstance(payload, dict):
        raise ValueError("Dispatch args payload must be a JSON object")
    result = dispatch_execution(ref, payload, cwd=args.cwd)
    _print_json(result)
    return 0 if result.get("dispatched") else 2


def cmd_quickjs_invoke(args: argparse.Namespace) -> int:
    payload = _parse_any_json_file(args.input) if args.input else {}
    if not isinstance(payload, dict):
        raise ValueError("QuickJS payload must be a JSON object")
    try:
        result_raw = invoke_js_bundle_function(
            bundle_path=args.bundle,
            function_name=args.function,
            function_arg=payload,
            bootstrap_js=args.bootstrap,
        )
    except QuickJsUnavailableError as e:
        _print_json({"status": "error", "error": str(e)})
        return 2

    parsed: Any = result_raw
    if isinstance(result_raw, str):
        try:
            parsed = json.loads(result_raw)
        except Exception:
            parsed = result_raw
    _print_json({"status": "success", "data": parsed})
    return 0


def cmd_card_store_set(args: argparse.Namespace) -> int:
    card = _parse_json_file(args.input)
    prefix = "::fs-path::"
    if not args.store_ref.startswith(prefix):
        _print_json({"status": "error", "error": "Only ::fs-path:: store refs are supported"})
        return 2

    store_root = args.store_ref[len(prefix) :]
    os.makedirs(store_root, exist_ok=True)

    card_id = card.get("id")
    if not isinstance(card_id, str) or not card_id:
        _print_json({"status": "error", "error": "Card JSON must include string field 'id'"})
        return 2

    kv = FsKvStorage(store_root)
    kv.write(card_id, card)

    index = kv.read("_index")
    if not isinstance(index, dict):
        index = {}
    index[card_id] = {
        "key": card_id,
        "checksum": compute_stable_json_hash(card),
        "updatedAt": datetime.utcnow().isoformat() + "Z",
    }
    kv.write("_index", index)

    _print_json({"status": "success"})
    return 0


def _invoke_board_command(
    *,
    base_ref: str,
    command: str,
    input_obj: Dict[str, Any] | None,
    notify_channel: str | None,
    bundle: str | None,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "baseRef": base_ref,
        "command": command,
        "input": input_obj or {},
    }
    if notify_channel:
        payload["notifyChannel"] = notify_channel
    result_raw = invoke_js_bundle_function(
        bundle_path=_resolve_bundle_path(bundle),
        function_name="pycliBoardInvoke",
        function_arg=payload,
    )
    if isinstance(result_raw, str):
        try:
            parsed = json.loads(result_raw)
        except Exception:
            return {"status": "error", "error": result_raw}
        if isinstance(parsed, dict):
            return parsed
        return {"status": "error", "error": "Unexpected non-object result from QuickJS runtime"}
    if isinstance(result_raw, dict):
        return result_raw
    return {"status": "error", "error": "Unexpected result type from QuickJS runtime"}


def _board_handler(command: str):
    def _handler(args: argparse.Namespace) -> int:
        try:
            base_ref = getattr(args, "base_ref", None)
            if not base_ref and command in ("sourceDataFetched", "sourceDataFetchFailure"):
                token = getattr(args, "token", None)
                if isinstance(token, str) and token:
                    base_ref = _decode_board_ref_from_token(token)
            if not base_ref and command in ("validateTmpCard", "probeTmpSource"):
                base_ref = f"::fs-path::{os.path.abspath('.') }"

            input_obj: Dict[str, Any] = {"params": {}, "body": None}

            if getattr(args, "body_input", None):
                input_obj["body"] = _parse_any_json_file(args.body_input)
            else:
                input_obj["body"] = _read_stdin_json()

            params = input_obj["params"]
            for field in (
                "id",
                "card_id",
                "key",
                "token",
                "ref",
                "reason",
                "error",
                "card_store_ref",
                "outputs_store_ref",
            ):
                if hasattr(args, field):
                    val = getattr(args, field)
                    if val is not None:
                        params_name = {
                            "card_id": "cardId",
                            "card_store_ref": "cardStoreRef",
                            "outputs_store_ref": "outputsStoreRef",
                        }.get(field, field)
                        params[params_name] = val

            if hasattr(args, "restart") and args.restart:
                params["restart"] = True
            if hasattr(args, "all") and args.all:
                params["all"] = True

            if hasattr(args, "update") and args.update is not None:
                input_obj["body"] = {"update": _parse_any_json_file(args.update)}
            if hasattr(args, "update_json") and args.update_json is not None:
                input_obj["body"] = {"update": json.loads(args.update_json)}

            if not input_obj["params"]:
                input_obj.pop("params", None)
            if input_obj.get("body") is None:
                input_obj.pop("body", None)

            result = _invoke_board_command(
                base_ref=base_ref,
                command=command,
                input_obj=input_obj,
                notify_channel=getattr(args, "notify_channel", None),
                bundle=getattr(args, "bundle", None),
            )
            _print_json(result)

            status = result.get("status")
            return 0 if status == "success" else 2
        except QuickJsUnavailableError as e:
            _print_json({"status": "error", "error": str(e)})
            return 2

    return _handler


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="board-live-cards-pycli",
        description="Python host implementation for board-live-cards snapshot-store operations.",
    )

    sub = parser.add_subparsers(dest="command", required=True)

    def _add_notify_channel_arg(p: argparse.ArgumentParser) -> None:
        p.add_argument(
            "--notify-channel",
            required=False,
            help="Optional named pipe/socket channel for board change notifications",
        )

    read_cmd = sub.add_parser("read-snapshot", help="Read authoritative snapshot values")
    read_cmd.add_argument("--scope", required=True, help="Board directory")
    read_cmd.set_defaults(handler=cmd_read_snapshot)

    commit_cmd = sub.add_parser("commit-snapshot", help="Commit snapshot envelope")
    commit_cmd.add_argument("--scope", required=True, help="Board directory")
    commit_cmd.add_argument("--in", dest="input", required=True, help="Path to commit envelope JSON")
    commit_cmd.set_defaults(handler=cmd_commit_snapshot)

    kv_read_cmd = sub.add_parser("kv-read", help="Read one key from a KV namespace")
    kv_read_cmd.add_argument("--scope", required=True, help="Board directory")
    kv_read_cmd.add_argument("--namespace", required=True, help="KV namespace")
    kv_read_cmd.add_argument("--key", required=True, help="KV key")
    kv_read_cmd.set_defaults(handler=cmd_kv_read)

    kv_write_cmd = sub.add_parser("kv-write", help="Write one key in a KV namespace")
    kv_write_cmd.add_argument("--scope", required=True, help="Board directory")
    kv_write_cmd.add_argument("--namespace", required=True, help="KV namespace")
    kv_write_cmd.add_argument("--key", required=True, help="KV key")
    kv_write_cmd.add_argument("--in", dest="input", required=True, help="JSON file to write")
    kv_write_cmd.set_defaults(handler=cmd_kv_write)

    kv_delete_cmd = sub.add_parser("kv-delete", help="Delete one key in a KV namespace")
    kv_delete_cmd.add_argument("--scope", required=True, help="Board directory")
    kv_delete_cmd.add_argument("--namespace", required=True, help="KV namespace")
    kv_delete_cmd.add_argument("--key", required=True, help="KV key")
    kv_delete_cmd.set_defaults(handler=cmd_kv_delete)

    kv_list_cmd = sub.add_parser("kv-list", help="List keys in a KV namespace")
    kv_list_cmd.add_argument("--scope", required=True, help="Board directory")
    kv_list_cmd.add_argument("--namespace", required=True, help="KV namespace")
    kv_list_cmd.add_argument("--prefix", required=False, help="Optional key prefix")
    kv_list_cmd.set_defaults(handler=cmd_kv_list)

    blob_read_cmd = sub.add_parser("blob-read", help="Read one blob key")
    blob_read_cmd.add_argument("--scope", required=True, help="Board directory")
    blob_read_cmd.add_argument("--namespace", default="", help="Blob namespace")
    blob_read_cmd.add_argument("--key", required=True, help="Blob key")
    blob_read_cmd.set_defaults(handler=cmd_blob_read)

    blob_write_cmd = sub.add_parser("blob-write", help="Write one blob key")
    blob_write_cmd.add_argument("--scope", required=True, help="Board directory")
    blob_write_cmd.add_argument("--namespace", default="", help="Blob namespace")
    blob_write_cmd.add_argument("--key", required=True, help="Blob key")
    blob_write_group = blob_write_cmd.add_mutually_exclusive_group(required=True)
    blob_write_group.add_argument("--text", help="Text content")
    blob_write_group.add_argument("--in", dest="input", help="JSON file to stringify")
    blob_write_cmd.set_defaults(handler=cmd_blob_write)

    blob_exists_cmd = sub.add_parser("blob-exists", help="Check blob key existence")
    blob_exists_cmd.add_argument("--scope", required=True, help="Board directory")
    blob_exists_cmd.add_argument("--namespace", default="", help="Blob namespace")
    blob_exists_cmd.add_argument("--key", required=True, help="Blob key")
    blob_exists_cmd.set_defaults(handler=cmd_blob_exists)

    blob_remove_cmd = sub.add_parser("blob-remove", help="Remove one blob key")
    blob_remove_cmd.add_argument("--scope", required=True, help="Board directory")
    blob_remove_cmd.add_argument("--namespace", default="", help="Blob namespace")
    blob_remove_cmd.add_argument("--key", required=True, help="Blob key")
    blob_remove_cmd.set_defaults(handler=cmd_blob_remove)

    journal_append_cmd = sub.add_parser("journal-append", help="Append one event to board journal")
    journal_append_cmd.add_argument("--scope", required=True, help="Board directory")
    journal_append_cmd.add_argument("--in", dest="input", required=True, help="Event JSON file")
    journal_append_cmd.set_defaults(handler=cmd_journal_append)

    journal_read_cmd = sub.add_parser("journal-read-after", help="Read events after a cursor")
    journal_read_cmd.add_argument("--scope", required=True, help="Board directory")
    journal_read_cmd.add_argument("--cursor", required=False, help="Last processed journal id")
    journal_read_cmd.set_defaults(handler=cmd_journal_read_after)

    lock_try_cmd = sub.add_parser("lock-try", help="Try lock acquire and release immediately")
    lock_try_cmd.add_argument("--scope", required=True, help="Board directory")
    lock_try_cmd.set_defaults(handler=cmd_lock_try)

    dispatch_cmd = sub.add_parser("dispatch", help="Dispatch an execution ref")
    dispatch_ref_group = dispatch_cmd.add_mutually_exclusive_group(required=True)
    dispatch_ref_group.add_argument("--ref-json", help="ExecutionRef JSON string")
    dispatch_ref_group.add_argument("--ref-file", help="ExecutionRef JSON file")
    dispatch_cmd.add_argument("--in", dest="input", required=True, help="Dispatch args JSON file")
    dispatch_cmd.add_argument("--cwd", help="Optional working directory")
    dispatch_cmd.set_defaults(handler=cmd_dispatch)

    quickjs_cmd = sub.add_parser("quickjs-invoke", help="Invoke a function from a JS bundle using QuickJS host adapters")
    quickjs_cmd.add_argument("--bundle", required=True, help="Path to JS bundle file")
    quickjs_cmd.add_argument("--function", required=True, help="Global function name to invoke")
    quickjs_cmd.add_argument("--in", dest="input", help="Optional JSON payload file")
    quickjs_cmd.add_argument("--bootstrap", help="Optional JS code evaluated before loading bundle")
    quickjs_cmd.set_defaults(handler=cmd_quickjs_invoke)

    card_store_set_cmd = sub.add_parser("card-store-set", help="Set one card into a card store ref")
    card_store_set_cmd.add_argument("--store-ref", required=True, help="Card store ref (::kind::value)")
    card_store_set_cmd.add_argument("--in", dest="input", required=True, help="Card JSON file")
    card_store_set_cmd.set_defaults(handler=cmd_card_store_set)

    board_init_cmd = sub.add_parser("board-init", help="Initialize board stores")
    board_init_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    board_init_cmd.add_argument("--card-store-ref", required=True, help="Card store ref (::kind::value)")
    board_init_cmd.add_argument("--outputs-store-ref", required=True, help="Outputs store ref (::kind::value)")
    board_init_cmd.add_argument("--in", dest="body_input", help="Optional JSON body file")
    board_init_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(board_init_cmd)
    board_init_cmd.set_defaults(handler=_board_handler("init"))

    board_status_cmd = sub.add_parser("board-status", help="Read board status")
    board_status_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    board_status_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(board_status_cmd)
    board_status_cmd.set_defaults(handler=_board_handler("status"))

    board_card_ref_cmd = sub.add_parser("board-get-card-store-ref", help="Get card store ref")
    board_card_ref_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    board_card_ref_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(board_card_ref_cmd)
    board_card_ref_cmd.set_defaults(handler=_board_handler("getCardStoreRef"))

    board_out_ref_cmd = sub.add_parser("board-get-outputs-store-ref", help="Get outputs store ref")
    board_out_ref_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    board_out_ref_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(board_out_ref_cmd)
    board_out_ref_cmd.set_defaults(handler=_board_handler("getOutputsStoreRef"))

    board_get_outputs_cmd = sub.add_parser("board-get-outputs", help="Get outputs data or computed-values")
    board_get_outputs_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    board_get_outputs_cmd.add_argument("--type", choices=["data-object", "computed-values"], required=True)
    board_get_outputs_cmd.add_argument("--key", required=True, help="Data key (data-object) or card id (computed-values)")
    board_get_outputs_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(board_get_outputs_cmd)

    def _board_get_outputs_handler(args: argparse.Namespace) -> int:
        cmd = "getOutputsDataObject" if args.type == "data-object" else "getOutputsComputedValues"
        invoke = _board_handler(cmd)
        return invoke(args)

    board_get_outputs_cmd.set_defaults(handler=_board_get_outputs_handler)

    board_remove_cmd = sub.add_parser("board-remove-card", help="Remove a card")
    board_remove_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    board_remove_cmd.add_argument("--id", required=True, help="Card id")
    board_remove_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(board_remove_cmd)
    board_remove_cmd.set_defaults(handler=_board_handler("removeCard"))

    board_retrigger_cmd = sub.add_parser("board-retrigger", help="Retrigger a card")
    board_retrigger_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    board_retrigger_cmd.add_argument("--id", required=True, help="Card id")
    board_retrigger_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(board_retrigger_cmd)
    board_retrigger_cmd.set_defaults(handler=_board_handler("retrigger"))

    board_process_cmd = sub.add_parser("board-process-accumulated-events", help="Process pending board events")
    board_process_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    board_process_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(board_process_cmd)
    board_process_cmd.set_defaults(handler=_board_handler("processAccumulatedEvents"))

    board_upsert_cmd = sub.add_parser("board-upsert-card", help="Upsert one card or all cards")
    board_upsert_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    board_upsert_cmd.add_argument("--card-id", help="Card id")
    board_upsert_cmd.add_argument("--all", action="store_true", help="Upsert all cards")
    board_upsert_cmd.add_argument("--restart", action="store_true", help="Mark upsert as restart")
    board_upsert_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(board_upsert_cmd)
    board_upsert_cmd.set_defaults(handler=_board_handler("upsertCard"))

    board_task_failed_cmd = sub.add_parser("board-task-failed", help="Send task-failed callback")
    board_task_failed_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    board_task_failed_cmd.add_argument("--token", required=True, help="Callback token")
    board_task_failed_cmd.add_argument("--error", help="Error message")
    board_task_failed_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(board_task_failed_cmd)
    board_task_failed_cmd.set_defaults(handler=_board_handler("taskFailed"))

    board_task_progress_cmd = sub.add_parser("board-task-progress", help="Send task-progress callback")
    board_task_progress_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    board_task_progress_cmd.add_argument("--token", required=True, help="Callback token")
    board_task_progress_cmd.add_argument("--update", required=True, help="JSON file for progress update payload")
    board_task_progress_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(board_task_progress_cmd)
    board_task_progress_cmd.set_defaults(handler=_board_handler("taskProgress"))

    board_source_fetched_cmd = sub.add_parser("board-source-data-fetched", help="Send source-data-fetched callback")
    board_source_fetched_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    board_source_fetched_cmd.add_argument("--token", required=True, help="Callback token")
    board_source_fetched_cmd.add_argument("--ref", required=True, help="Fetched source ref")
    board_source_fetched_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(board_source_fetched_cmd)
    board_source_fetched_cmd.set_defaults(handler=_board_handler("sourceDataFetched"))

    board_source_failed_cmd = sub.add_parser("board-source-data-fetch-failure", help="Send source-data-fetch-failure callback")
    board_source_failed_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    board_source_failed_cmd.add_argument("--token", required=True, help="Callback token")
    board_source_failed_cmd.add_argument("--reason", help="Failure reason")
    board_source_failed_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(board_source_failed_cmd)
    board_source_failed_cmd.set_defaults(handler=_board_handler("sourceDataFetchFailure"))

    # JS-parity board CLI commands (unprefixed names).
    init_cmd = sub.add_parser("init", help="Initialize board stores")
    init_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    init_cmd.add_argument("--card-store-ref", required=True, help="Card store ref (::kind::value)")
    init_cmd.add_argument("--outputs-store-ref", required=True, help="Outputs store ref (::kind::value)")
    init_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(init_cmd)
    init_cmd.set_defaults(handler=_board_handler("init"))

    status_cmd = sub.add_parser("status", help="Read board status")
    status_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    status_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(status_cmd)
    status_cmd.set_defaults(handler=_board_handler("status"))

    get_card_ref_cmd = sub.add_parser("get-card-store-ref", help="Get card store ref")
    get_card_ref_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    get_card_ref_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(get_card_ref_cmd)
    get_card_ref_cmd.set_defaults(handler=_board_handler("getCardStoreRef"))

    get_out_ref_cmd = sub.add_parser("get-outputs-store-ref", help="Get outputs store ref")
    get_out_ref_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    get_out_ref_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(get_out_ref_cmd)
    get_out_ref_cmd.set_defaults(handler=_board_handler("getOutputsStoreRef"))

    get_outputs_cmd = sub.add_parser("get-outputs", help="Get outputs data or computed-values")
    get_outputs_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    get_outputs_cmd.add_argument("--type", choices=["data-object", "computed-values"], required=True)
    get_outputs_cmd.add_argument("--key", required=False, help="Data key/card id")
    get_outputs_cmd.add_argument("--all", action="store_true", help="Return all entries for type")
    get_outputs_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(get_outputs_cmd)

    def _js_get_outputs_handler(args: argparse.Namespace) -> int:
        if args.all:
            cmd = "getAllOutputsDataObjects" if args.type == "data-object" else "getAllOutputsComputedValues"
            return _board_handler(cmd)(args)
        if not args.key:
            raise ValueError("get-outputs requires --key unless --all is used")
        cmd = "getOutputsDataObject" if args.type == "data-object" else "getOutputsComputedValues"
        return _board_handler(cmd)(args)

    get_outputs_cmd.set_defaults(handler=_js_get_outputs_handler)

    remove_cmd = sub.add_parser("remove-card", help="Remove a card")
    remove_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    remove_cmd.add_argument("--id", required=True, help="Card id")
    remove_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(remove_cmd)
    remove_cmd.set_defaults(handler=_board_handler("removeCard"))

    retrigger_cmd = sub.add_parser("retrigger", help="Retrigger a card")
    retrigger_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    retrigger_cmd.add_argument("--id", required=True, help="Card id")
    retrigger_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(retrigger_cmd)
    retrigger_cmd.set_defaults(handler=_board_handler("retrigger"))

    process_cmd = sub.add_parser("process-accumulated-events", help="Process pending board events")
    process_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    process_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(process_cmd)
    process_cmd.set_defaults(handler=_board_handler("processAccumulatedEvents"))

    upsert_cmd = sub.add_parser("upsert-card", help="Upsert one card or all cards")
    upsert_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    upsert_cmd.add_argument("--card-id", help="Card id")
    upsert_cmd.add_argument("--all", action="store_true", help="Upsert all cards")
    upsert_cmd.add_argument("--restart", action="store_true", help="Mark upsert as restart")
    upsert_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(upsert_cmd)
    upsert_cmd.set_defaults(handler=_board_handler("upsertCard"))

    task_failed_cmd = sub.add_parser("task-failed", help="Send task-failed callback")
    task_failed_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    task_failed_cmd.add_argument("--token", required=True, help="Callback token")
    task_failed_cmd.add_argument("--error", help="Error message")
    task_failed_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(task_failed_cmd)
    task_failed_cmd.set_defaults(handler=_board_handler("taskFailed"))

    task_progress_cmd = sub.add_parser("task-progress", help="Send task-progress callback")
    task_progress_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    task_progress_cmd.add_argument("--token", required=True, help="Callback token")
    task_progress_cmd.add_argument("--update", dest="update_json", required=False, help="Inline JSON payload for update")
    task_progress_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(task_progress_cmd)
    task_progress_cmd.set_defaults(handler=_board_handler("taskProgress"))

    source_fetched_cmd = sub.add_parser("source-data-fetched", help="Send source-data-fetched callback")
    source_fetched_cmd.add_argument("--base-ref", required=False, help="Board base ref (::kind::value)")
    source_fetched_cmd.add_argument("--token", required=True, help="Callback token")
    source_fetched_cmd.add_argument("--ref", required=True, help="Fetched source ref")
    source_fetched_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(source_fetched_cmd)
    source_fetched_cmd.set_defaults(handler=_board_handler("sourceDataFetched"))

    source_failed_cmd = sub.add_parser("source-data-fetch-failure", help="Send source-data-fetch-failure callback")
    source_failed_cmd.add_argument("--base-ref", required=False, help="Board base ref (::kind::value)")
    source_failed_cmd.add_argument("--token", required=True, help="Callback token")
    source_failed_cmd.add_argument("--reason", help="Failure reason")
    source_failed_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(source_failed_cmd)
    source_failed_cmd.set_defaults(handler=_board_handler("sourceDataFetchFailure"))

    validate_cmd = sub.add_parser("validate-card", help="Validate card(s)")
    validate_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    validate_cmd.add_argument("--card-id", help="Card id")
    validate_cmd.add_argument("--all", action="store_true", help="Validate all cards")
    validate_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(validate_cmd)
    validate_cmd.set_defaults(handler=_board_handler("validateCard"))

    probe_cmd = sub.add_parser("probe-source", help="Probe a source")
    probe_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    probe_cmd.add_argument("--card-id", required=True, help="Card id")
    probe_cmd.add_argument("--source-idx", required=True, help="Source index")
    probe_cmd.add_argument("--out-ref", required=False, help="Output ref")
    probe_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(probe_cmd)
    probe_cmd.set_defaults(handler=_board_handler("probeSource"))

    describe_cmd = sub.add_parser("describe-task-executor-capabilities", help="Describe task executor capabilities")
    describe_cmd.add_argument("--base-ref", required=True, help="Board base ref (::kind::value)")
    describe_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(describe_cmd)
    describe_cmd.set_defaults(handler=_board_handler("describeTaskExecutorCapabilities"))

    validate_tmp_cmd = sub.add_parser("validate-tmp-card", help="Validate temporary card body")
    validate_tmp_cmd.add_argument("--base-ref", required=False, help="Board base ref (::kind::value)")
    validate_tmp_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(validate_tmp_cmd)
    validate_tmp_cmd.set_defaults(handler=_board_handler("validateTmpCard"))

    probe_tmp_cmd = sub.add_parser("probe-tmp-source", help="Probe temporary source body")
    probe_tmp_cmd.add_argument("--base-ref", required=False, help="Board base ref (::kind::value)")
    probe_tmp_cmd.add_argument("--out-ref", required=True, help="Output ref")
    probe_tmp_cmd.add_argument("--bundle", help=f"Optional QuickJS bundle path (default: {DEFAULT_QUICKJS_BUNDLE})")
    _add_notify_channel_arg(probe_tmp_cmd)
    probe_tmp_cmd.set_defaults(handler=_board_handler("probeTmpSource"))

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    return args.handler(args)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as err:  # pragma: no cover - CLI error path
        print(str(err), file=sys.stderr)
        raise SystemExit(1)
