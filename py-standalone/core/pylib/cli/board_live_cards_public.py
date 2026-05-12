"""
board-live-cards-public.ts — Platform-free public API layer.

Port of src/cli/common/board-live-cards-public.ts

LAYER DIAGRAM:
  board-live-cards-cli        (THIN — arg parse -> call public -> print JSON)
          |
  board-live-cards-public     (THIS FILE — facade, all logic, no platform code)
          |
  board-live-cards-lib        (pure domain — stores, graph, codecs)
"""
from __future__ import annotations

import base64
import json
from datetime import datetime, timezone
from typing import Any, Callable

from .storage_interface import serialize_ref, parse_ref
from ..card_compute import CardCompute
from .board_live_cards_lib import (
    create_card_store,
    create_journal_store,
    create_execution_request_store,
    create_card_runtime_store,
    create_fetched_sources_store,
    create_published_outputs_store,
    create_board_config_store,
    create_state_snapshot_store,
    build_board_status_object,
    create_card_handler_fn,
    EMPTY_CONFIG,
    BOARD_GRAPH_KEY,
    SNAPSHOT_SCHEMA_VERSION_V1,
    board_envelope_to_snapshot_entries,
    snapshot_entries_to_board_envelope,
    live_card_to_task_config,
)
from ..continuous_event_graph.core import (
    restore,
    create_live_graph,
    snapshot,
)
from ..continuous_event_graph.reactive import (
    create_reactive_graph,
    compute_data_hash,
)


# ============================================================================
# Internal pure helpers
# ============================================================================

def to_base64_url(s: str) -> str:
    """Pure base64url encode — no platform dependency."""
    return base64.urlsafe_b64encode(s.encode("utf-8")).rstrip(b"=").decode("ascii")


def from_base64_url(s: str) -> str:
    """Pure base64url decode."""
    padded = s + "=" * ((4 - len(s) % 4) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")


def decode_callback_token(token: str) -> dict | None:
    """Decode a callback token -> {"taskName": str} or None."""
    try:
        p = json.loads(from_base64_url(token))
        return {"taskName": p["t"]} if isinstance(p, dict) and isinstance(p.get("t"), str) else None
    except Exception:
        return None


def encode_source_token(payload: dict) -> str:
    """Encode a source token payload to base64url."""
    return to_base64_url(json.dumps(payload))


def decode_source_token(token: str) -> dict | None:
    """Decode a source token -> SourceTokenPayload dict or None."""
    try:
        p = json.loads(from_base64_url(token))
        if (
            isinstance(p, dict)
            and isinstance(p.get("cbk"), str)
            and isinstance(p.get("cid"), str)
            and isinstance(p.get("b"), str)
            and isinstance(p.get("d"), str)
        ):
            return p
        return None
    except Exception:
        return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _ok(data: Any = None) -> dict:
    if data is not None:
        return {"status": "success", "data": data}
    return {"status": "success"}


def _fail(error: str) -> dict:
    return {"status": "fail", "error": error}


def _err(e: Any) -> dict:
    return {"status": "error", "error": str(e) if not isinstance(e, Exception) else str(e)}


# ============================================================================
# Dispatch helper
# ============================================================================

def _dispatch_source_fetch(entry: dict, executor_ref: dict, base_ref: dict, adapter: Any, warn) -> None:
    """Dispatch a single execution-request entry (source-fetch)."""
    if entry.get("taskKind") != "source-fetch":
        warn(f'[process-accumulated-events] unknown taskKind "{entry.get("taskKind")}" — skipping')
        return
    p = entry.get("payload", {})
    enriched_card = p.get("enrichedCard", {})
    card_id = enriched_card.get("id", "unknown")
    source_defs = enriched_card.get("source_defs", [])
    callback_token = p.get("callbackToken", "")
    rqt = p.get("rqt", "")
    board_ref_str = p.get("boardRef", serialize_ref(base_ref))

    for src in source_defs:
        output_file = src.get("outputFile")
        if not output_file:
            warn(f'[dispatch] source "{src.get("bindTo")}" has no outputFile — skipping')
            continue
        source_token = encode_source_token({
            "cbk": callback_token,
            "rg": base_ref["value"],
            "br": board_ref_str,
            "cid": card_id,
            "b": src.get("bindTo", ""),
            "d": output_file,
            "cs": None,
            "rqt": rqt,
        })
        try:
            adapter.dispatch_execution(executor_ref, {
                "source_def": src,
                "base_ref": board_ref_str,
                "callback": {"token": source_token, "via": adapter.self_ref},
            })
        except Exception as e:
            # Match TS: .catch((e) => taskFailedFn(cardId, e.message))
            warn(f"[dispatch] source fetch failed for {card_id}: {e}")


# ============================================================================
# createBoardLiveCardsPublic — factory
# ============================================================================

def create_board_live_cards_public(base_ref: dict, adapter: Any) -> Any:
    """
    Create the public API surface for board-live-cards.

    base_ref = {"kind": str, "value": str}
    adapter = BoardPlatformAdapter (duck-typed)

    Returns an object with methods:
        init, status, get_card_store_ref, get_outputs_store_ref, get_config,
        get_outputs_data_object, get_all_outputs_data_objects,
        get_outputs_computed_values, get_all_outputs_computed_values,
        remove_card, retrigger, process_accumulated_events,
        upsert_card, task_failed, task_progress,
        source_data_fetched, source_data_fetch_failure
    """
    warn = getattr(adapter, "on_warn", None) or (lambda msg: None)
    board_path = serialize_ref(base_ref)

    # ── Store helpers ──────────────────────────────────────────────────────────

    def config_store():
        return create_board_config_store(adapter.kv_storage("config"))

    def snapshot_adapter_impl():
        class _Adapter:
            def read_values(self, scope_id: str) -> dict:
                kv = adapter.kv_storage("state-snapshot")
                keys = sorted(kv.list_keys())
                if not keys:
                    return {"version": None, "values": {}}
                values = {key: kv.read(key) for key in keys}
                return {"version": adapter.hash_fn(values), "values": values}

            def write_values(self, scope_id: str, next_values: dict, deleted_keys: list) -> str:
                kv = adapter.kv_storage("state-snapshot")
                for key in deleted_keys:
                    kv.delete(key)
                for key, value in next_values.items():
                    kv.write(key, value)
                return adapter.hash_fn(next_values)

        return _Adapter()

    def snapshot_store():
        return create_state_snapshot_store(snapshot_adapter_impl())

    def journal_store():
        return create_journal_store(adapter.journal_adapter())

    def card_store():
        store_ref = config_store().read_card_store_ref()
        if not store_ref:
            raise ValueError(f"Board at {base_ref['value']} has no card store configured.")
        kv = adapter.kv_storage_for_ref(store_ref)

        class _CardAdapter:
            def read_index(self):
                return kv.read("_index")

            def write_index(self, index):
                kv.write("_index", index)

            def read_card(self, key):
                return kv.read(key)

            def write_card(self, key, card):
                kv.write(key, card)
                return adapter.hash_fn(card)

            def card_exists(self, key):
                return kv.read(key) is not None

            def default_card_key(self, card_id):
                return card_id

        return create_card_store(_CardAdapter(), warn)

    def output_store():
        ref = config_store().read_outputs_store_ref()
        if not ref:
            raise ValueError(f"Board at {base_ref['value']} has no outputs store configured.")
        return create_published_outputs_store(adapter.kv_storage_for_ref(ref))

    def board_exists() -> bool:
        return bool(snapshot_store().read_snapshot(base_ref["value"])["values"].get(BOARD_GRAPH_KEY))

    def load_envelope() -> dict:
        snap = snapshot_store().read_snapshot(base_ref["value"])
        if not snap["values"].get(BOARD_GRAPH_KEY):
            raise ValueError(f"Board not initialized at {base_ref['value']}")
        return snapshot_entries_to_board_envelope(snap["values"])

    def commit_envelope(envelope: dict, expected_version: str | None) -> None:
        result = snapshot_store().commit_snapshot(base_ref["value"], {
            "schemaVersion": SNAPSHOT_SCHEMA_VERSION_V1,
            "expectedVersion": expected_version,
            "commitId": adapter.gen_id(),
            "committedAt": _now_iso(),
            "deleteKeys": [],
            "shallowMerge": board_envelope_to_snapshot_entries(envelope),
        })
        if not result.get("ok"):
            raise ValueError(
                f"Snapshot commit failed (version mismatch): expected={expected_version} current={result.get('currentVersion')}"
            )

    def append_journal_event(event: dict) -> None:
        journal_store().append_event(event)

    # ── Public methods ─────────────────────────────────────────────────────────

    class _BoardLiveCardsPublic:
        def init(self, input_data: dict | None = None) -> dict:
            try:
                params = (input_data or {}).get("params", {})
                store_ref = params.get("cardStoreRef")
                if not store_ref:
                    return _fail("init requires params.cardStoreRef")
                if not board_exists():
                    live = create_live_graph(EMPTY_CONFIG)
                    commit_envelope({"lastDrainedJournalId": "", "graph": snapshot(live)}, None)
                outputs_store_ref = params.get("outputsStoreRef")
                if not outputs_store_ref:
                    return _fail("init requires params.outputsStoreRef")
                cfg = config_store()
                cfg.write_card_store_ref(store_ref)
                cfg.write_outputs_store_ref(outputs_store_ref)
                body = (input_data or {}).get("body") or {}
                if body.get("task-executor-ref"):
                    cfg.write_task_executor_ref(body["task-executor-ref"])
                if body.get("chat-handler-ref"):
                    cfg.write_chat_handler_ref(body["chat-handler-ref"])
                return _ok()
            except Exception as e:
                return _err(e)

        def status(self, input_data: dict | None = None) -> dict:
            try:
                s = output_store().read_status_snapshot()
                if not s:
                    s = build_board_status_object(board_path, restore(load_envelope()["graph"]))
                    try:
                        output_store().write_status_snapshot(s)
                    except Exception:
                        pass
                return _ok(s)
            except Exception as e:
                return _err(e)

        def get_card_store_ref(self, input_data: dict | None = None) -> dict:
            try:
                ref = config_store().read_card_store_ref()
                return _ok({"storeRef": ref})
            except Exception as e:
                return _err(e)

        def get_outputs_store_ref(self, input_data: dict | None = None) -> dict:
            try:
                ref = config_store().read_outputs_store_ref()
                return _ok({"storeRef": ref})
            except Exception as e:
                return _err(e)

        def get_config(self, input_data: dict | None = None) -> dict:
            try:
                params = (input_data or {}).get("params", {})
                key = params.get("key")
                cfg = config_store()
                value = None
                if key == "task-executor":
                    value = cfg.read_task_executor_ref()
                elif key == "chat-handler":
                    value = cfg.read_chat_handler_ref()
                elif key == "card-store-ref":
                    value = cfg.read_card_store_ref()
                elif key == "outputs-store-ref":
                    value = cfg.read_outputs_store_ref()
                return _ok({"value": value})
            except Exception as e:
                return _err(e)

        def get_outputs_data_object(self, input_data: dict | None = None) -> dict:
            try:
                params = (input_data or {}).get("params", {})
                key = params.get("key")
                return _ok(output_store().read_data_object(key))
            except Exception as e:
                return _err(e)

        def get_all_outputs_data_objects(self, input_data: dict | None = None) -> dict:
            try:
                return _ok(output_store().read_all_data_objects())
            except Exception as e:
                return _err(e)

        def get_outputs_computed_values(self, input_data: dict | None = None) -> dict:
            try:
                params = (input_data or {}).get("params", {})
                key = params.get("key")
                return _ok(output_store().read_computed_values(key))
            except Exception as e:
                return _err(e)

        def get_all_outputs_computed_values(self, input_data: dict | None = None) -> dict:
            try:
                return _ok(output_store().read_all_computed_values())
            except Exception as e:
                return _err(e)

        def remove_card(self, input_data: dict | None = None) -> dict:
            try:
                params = (input_data or {}).get("params", {})
                card_id = params.get("id")
                if not card_id:
                    return _fail("removeCard requires params.id")
                append_journal_event({"type": "task-removal", "taskName": card_id, "timestamp": _now_iso()})
                self.process_accumulated_events()
                return _ok()
            except Exception as e:
                return _err(e)

        def retrigger(self, input_data: dict | None = None) -> dict:
            try:
                params = (input_data or {}).get("params", {})
                card_id = params.get("id")
                if not card_id:
                    return _fail("retrigger requires params.id")
                append_journal_event({"type": "task-restart", "taskName": card_id, "timestamp": _now_iso()})
                self.process_accumulated_events()
                return _ok()
            except Exception as e:
                return _err(e)

        def process_accumulated_events(self, input_data: dict | None = None) -> dict:
            try:
                # Match TS withRelayLock: try-acquire, skip if already held
                lock_adapter = adapter.lock
                release = lock_adapter.try_acquire()
                if not release:
                    return _ok({"ran": False})  # relay: holder is already doing the work

                try:
                    self._drain_cycle()
                finally:
                    release()

                # Continuation: check for new events accumulated while we held the lock
                envelope = load_envelope()
                j_store = journal_store()
                result = j_store.read_entries_after_cursor(envelope["lastDrainedJournalId"])
                if result["events"]:
                    adapter.request_process_accumulated()

                return _ok({"ran": True})
            except Exception as e:
                return _err(e)

        def _drain_cycle(self) -> None:
            on_dispatch_failed = lambda entry, error: append_journal_event({
                "type": "task-failed",
                "taskName": ((entry.get("payload") or {}).get("enrichedCard") or {}).get("id", "unknown"),
                "error": error,
                "timestamp": _now_iso(),
            })

            exec_req_store = create_execution_request_store(
                adapter.kv_storage("execution-requests"), on_dispatch_failed
            )
            real_card_runtime_store = create_card_runtime_store(adapter.kv_storage("card-runtime"))
            real_fetched_sources_store = create_fetched_sources_store(
                adapter.blob_storage("sources"),
                lambda ref: adapter.resolve_blob(ref),
            )

            card_handler_adapters = {
                "cardStore": card_store(),
                "cardRuntimeStore": real_card_runtime_store,
                "fetchedSourcesStore": real_fetched_sources_store,
                "outputStore": output_store(),
                "executionRequestStore": exec_req_store,
            }

            envelope = load_envelope()
            live = restore(envelope["graph"])
            j_store = journal_store()
            result = j_store.read_entries_after_cursor(envelope["lastDrainedJournalId"])
            undrained = result["events"]
            new_cursor = result["newCursor"]

            tx: list[dict] = list(undrained)
            cx: list[dict] = []
            dx: list[dict] = []
            # NX: card refresh notifications keyed by card id; last write wins.
            nx: dict[str, dict] = {}

            def task_completed_fn(task_name: str, data: dict) -> None:
                tx.append({"type": "task-completed", "taskName": task_name, "data": data, "timestamp": _now_iso()})

            def task_failed_fn(task_name: str, error: str) -> None:
                append_journal_event({"type": "task-failed", "taskName": task_name, "error": error, "timestamp": _now_iso()})

            def write_cv_fn(card_id: str, values: dict) -> None:
                cx.append({"cardId": card_id, "values": values})

            def write_do_fn(data: dict) -> None:
                dx.append(data)

            handler_fn = create_card_handler_fn(
                base_ref, new_cursor, card_handler_adapters,
                task_completed_fn, task_failed_fn, write_cv_fn, write_do_fn,
            )

            rg = create_reactive_graph(live, {"handlers": {"card-handler": handler_fn}})

            while tx:
                pending = tx
                tx = []
                # Match JS parity: task-restart preloads refreshed card notifications.
                for ev in pending:
                    if ev.get("type") != "task-restart":
                        continue
                    task_name = ev.get("taskName")
                    if not isinstance(task_name, str) or not task_name:
                        continue
                    card = card_handler_adapters["cardStore"].read_card(task_name)
                    if card:
                        nx[task_name] = card
                rg.push_all(pending)
                rg.wait_for_handlers()

            final_live = rg.get_state()
            rg.dispose()

            current_version = snapshot_store().read_snapshot(base_ref["value"]).get("version")
            commit_envelope({"lastDrainedJournalId": new_cursor, "graph": snapshot(final_live)}, current_version)

            out = output_store()
            for item in cx:
                out.write_computed_values(item["cardId"], item["values"])
            for data in dx:
                out.write_data_objects(data)

            status_obj = None
            try:
                status_obj = build_board_status_object(board_path, final_live)
                out.write_status_snapshot(status_obj)
            except Exception as e:
                warn(f"[board-live-cards-public] status publish failed: {e}")

            batch: list[dict] = []
            for item in cx:
                batch.append({"kind": "computed_values", "cardId": item["cardId"], "values": item["values"]})
            for data in dx:
                for key, payload in data.items():
                    if key:
                        batch.append({"kind": "data_object", "key": key, "payload": payload})
            for card_id, card in nx.items():
                batch.append({"kind": "card_refreshed", "cardId": card_id, "card": card})
            if status_obj is not None:
                batch.append({"kind": "status", "status": status_obj})

            publish_fn = getattr(adapter, "publish_board_change_notifications", None)
            if callable(publish_fn) and batch:
                try:
                    publish_fn(batch)
                except Exception as e:
                    warn(f"[board-live-cards-public] publish_board_change_notifications failed: {e}")

            # Dispatch execution requests (source fetches) — detached, fire-and-forget
            executor_ref = config_store().read_task_executor_ref() or {
                "howToRun": "built-in",
                "whatToRun": serialize_ref({"kind": "built-in", "value": "source-cli-task-executor"}),
            }

            exec_req_store.dispatch_entries_for_journal_id(new_cursor, lambda entry: _dispatch_source_fetch(
                entry, executor_ref, base_ref, adapter, warn
            ))

        def upsert_card(self, input_data: dict | None = None) -> dict:
            try:
                params = (input_data or {}).get("params", {})
                card_id = params.get("cardId")
                upsert_all = params.get("all")
                restart = bool(params.get("restart"))

                if not card_id and not upsert_all:
                    return _fail("upsertCard requires --card-id <id> or --all")

                cs = card_store()
                ids = [c.get("id", "") for c in cs.read_all_cards()] if upsert_all else [card_id]

                for cid in ids:
                    if not cs.read_card(cid):
                        return _fail(f'Card "{cid}" not found in board at {base_ref["value"]}')

                for cid in ids:
                    card = cs.read_card(cid)
                    task_cfg = live_card_to_task_config(card)
                    task_config_hash = adapter.hash_fn(task_cfg)
                    upsert_kv = adapter.kv_storage("card-upsert")
                    existing = upsert_kv.read(cid)
                    changed = not existing or existing.get("taskConfigHash") != task_config_hash

                    if changed or restart:
                        append_journal_event({
                            "type": "task-upsert",
                            "taskName": cid,
                            "taskConfig": task_cfg,
                            "timestamp": _now_iso(),
                        })
                        upsert_kv.write(cid, {
                            "blobRef": "",
                            "taskConfigHash": task_config_hash,
                            "updatedAt": _now_iso(),
                        })

                    if restart:
                        append_journal_event({
                            "type": "task-restart",
                            "taskName": cid,
                            "timestamp": _now_iso(),
                        })

                self.process_accumulated_events()
                return _ok()
            except Exception as e:
                return _err(e)

        def task_failed(self, input_data: dict | None = None) -> dict:
            try:
                params = (input_data or {}).get("params", {})
                token = params.get("token")
                error_msg = params.get("error", "unknown error")
                if not token:
                    return _fail("taskFailed requires params.token")
                decoded = decode_callback_token(token)
                if not decoded:
                    return _fail("Invalid callback token")
                append_journal_event({
                    "type": "task-failed",
                    "taskName": decoded["taskName"],
                    "error": error_msg,
                    "timestamp": _now_iso(),
                })
                self.process_accumulated_events()
                return _ok()
            except Exception as e:
                return _err(e)

        def task_progress(self, input_data: dict | None = None) -> dict:
            try:
                params = (input_data or {}).get("params", {})
                token = params.get("token")
                if not token:
                    return _fail("taskProgress requires params.token")
                decoded = decode_callback_token(token)
                if not decoded:
                    return _fail("Invalid callback token")
                body = (input_data or {}).get("body") or {}
                append_journal_event({
                    "type": "task-progress",
                    "taskName": decoded["taskName"],
                    "update": body,
                    "timestamp": _now_iso(),
                })
                self.process_accumulated_events()
                return _ok()
            except Exception as e:
                return _err(e)

        def source_data_fetched(self, input_data: dict | None = None) -> dict:
            try:
                params = (input_data or {}).get("params", {})
                token = params.get("token")
                ref = params.get("ref")
                if not token:
                    return _fail("sourceDataFetched requires params.token")
                if not ref:
                    return _fail("sourceDataFetched requires params.ref")
                decoded = decode_source_token(token)
                if not decoded:
                    return _fail("Invalid source token")

                # Stage the fetched source data (matches TS ingestSourceDataStaged)
                fetched_sources_store = create_fetched_sources_store(
                    adapter.blob_storage("sources"),
                    lambda r: adapter.resolve_blob(r),
                )
                delivery_token = adapter.gen_id()
                fetched_sources_store.ingest_source_data_staged(
                    decoded["cid"], decoded["d"], parse_ref(ref), delivery_token
                )

                # Decode the callback token to get taskName
                cbk_decoded = decode_callback_token(decoded["cbk"])
                if not cbk_decoded:
                    return _fail("Invalid callback token embedded in source token")

                fetched_at = _now_iso()
                append_journal_event({
                    "type": "task-progress",
                    "taskName": cbk_decoded["taskName"],
                    "update": {
                        "bindTo": decoded["b"],
                        "outputFile": decoded["d"],
                        "fetchedAt": fetched_at,
                        "deliveryToken": delivery_token,
                        "sourceChecksum": decoded.get("cs"),
                        "rqt": decoded.get("rqt", ""),
                    },
                    "timestamp": fetched_at,
                })
                self.process_accumulated_events()
                return _ok()
            except Exception as e:
                return _err(e)

        def source_data_fetch_failure(self, input_data: dict | None = None) -> dict:
            try:
                params = (input_data or {}).get("params", {})
                token = params.get("token")
                reason = params.get("reason", "unknown")
                if not token:
                    return _fail("sourceDataFetchFailure requires params.token")
                decoded = decode_source_token(token)
                if not decoded:
                    return _fail("Invalid source token")

                cbk_decoded = decode_callback_token(decoded["cbk"])
                if not cbk_decoded:
                    return _fail("Invalid callback token embedded in source token")

                append_journal_event({
                    "type": "task-progress",
                    "taskName": cbk_decoded["taskName"],
                    "update": {
                        "bindTo": decoded["b"],
                        "outputFile": decoded["d"],
                        "failure": True,
                        "reason": reason,
                        "sourceChecksum": decoded.get("cs"),
                    },
                    "timestamp": _now_iso(),
                })
                self.process_accumulated_events()
                return _ok()
            except Exception as e:
                return _err(e)

        def _validate_card_object(self, card_id: str, card: dict) -> dict:
            """Port of validateCardObject — structural + runtime expression validation."""
            result = CardCompute.validate_live_card_definition(card)
            return _ok({"cardId": card_id, "isValid": result["ok"], "issues": result["errors"]})

        def validate_card(self, input_data: dict | None = None) -> dict:
            """Port of validateCard — validate one or all cards in the board store."""
            try:
                params = (input_data or {}).get("params", {})
                card_id = params.get("cardId") or params.get("id")
                all_cards = params.get("all")
                if not card_id and not all_cards:
                    return _fail("validateCard requires --card-id <id> or --all")
                ids = [c["id"] for c in card_store().read_all_cards()] if all_cards else [card_id]
                results = []
                for cid in ids:
                    card = card_store().read_card(cid)
                    if not card:
                        results.append({"cardId": cid, "isValid": False, "issues": [f'Card "{cid}" not found']})
                        continue
                    r = self._validate_card_object(cid, card)
                    if r.get("status") != "success":
                        return r
                    results.append(r["data"])
                return _ok(results)
            except Exception as e:
                return _err(e)

        def validate_card_preflight(self, input_data: dict | None = None) -> dict:
            """Port of validateCardPreflight — validate a card passed directly in the body.

            Performs structural validation first, then calls the task-executor's
            validate-card-preflight subcommand (if registered) and merges any
            additional issues.
            """
            try:
                body = (input_data or {}).get("body")
                if not body or not isinstance(body, dict):
                    return _fail("validateCardPreflight requires card JSON object in body")
                card = body.get("card-content", body)
                if not isinstance(card, dict):
                    return _fail("validateCardPreflight requires card JSON object in body")
                card_id = card.get("id", "(unknown)")

                # Structural validation (always runs inline).
                struct_result = self._validate_card_object(card_id, card)

                # Pluggable executor hook: if a task-executor is registered and supports
                # validate-card-preflight, call it and merge any additional issues.
                te_ref = config_store().read_task_executor_ref()
                if te_ref:
                    try:
                        stdout = adapter.invoke_executor_sync(
                            te_ref, "validate-card-preflight", [],
                            {"timeout": 10_000, "input": json.dumps(card)},
                        )
                        exec_result = json.loads(stdout.strip())
                        if not exec_result.get("ok") and isinstance(exec_result.get("errors"), list) and exec_result["errors"]:
                            struct_issues = (
                                struct_result["data"]["issues"]
                                if struct_result.get("status") == "success"
                                else []
                            )
                            merged = struct_issues + exec_result["errors"]
                            return _ok({"cardId": card_id, "isValid": False, "issues": merged})
                    except Exception:
                        pass  # executor doesn't support subcommand — fall through

                return struct_result
            except Exception as e:
                return _err(e)

        def _run_source_probe(self, src: dict, mock_projections: dict, out_ref: str | None) -> dict:
            """Port of runSourceProbe — invoke the task executor for a source fetch probe."""
            te_ref = config_store().read_task_executor_ref()
            if not te_ref:
                return _fail("No task-executor registered for this board")

            bind_to = src.get("bindTo", "source") if isinstance(src.get("bindTo"), str) else "source"
            in_file = adapter.make_temp_file_path(f"probe-in-{bind_to}")
            out_file = adapter.make_temp_file_path(f"probe-out-{bind_to}")
            err_file = adapter.make_temp_file_path(f"probe-err-{bind_to}", ".txt")

            in_payload = {
                **src,
                "boardDir": base_ref["value"],
                "_projections": mock_projections,
            }
            in_ref_str = serialize_ref({"kind": "fs-path", "value": in_file})
            out_ref_str = serialize_ref({"kind": "fs-path", "value": out_file})
            err_ref_str = serialize_ref({"kind": "fs-path", "value": err_file})

            adapter.absolute_blob.write(in_file, json.dumps(in_payload, indent=2))

            result_text = None
            try:
                adapter.invoke_executor_sync(
                    te_ref,
                    "run-source-fetch",
                    ["--in-ref", in_ref_str, "--out-ref", out_ref_str, "--err-ref", err_ref_str],
                    {"timeout": src.get("timeout", 30_000)},
                )
                result_text = adapter.absolute_blob.read(out_file)
                if result_text is None:
                    return _fail("Executor produced no output file")
            except Exception as ex:
                err_msg = (adapter.absolute_blob.read(err_file) or "").strip() or str(ex)
                return _fail(f"Probe failed: {err_msg}")
            finally:
                try: adapter.absolute_blob.remove(in_file)
                except Exception: pass
                try: adapter.absolute_blob.remove(err_file)
                except Exception: pass

            if out_ref:
                parsed = parse_ref(out_ref)
                adapter.absolute_blob.write(parsed["value"], result_text)
            else:
                try: adapter.absolute_blob.remove(out_file)
                except Exception: pass

            return _ok({"bindTo": bind_to, "resultSizeBytes": len(result_text)})

        def probe_source(self, input_data: dict | None = None) -> dict:
            """Port of probeSource — probe a named source_def of a card."""
            try:
                params = (input_data or {}).get("params", {})
                card_id = params.get("cardId")
                source_idx = params.get("sourceIdx")
                out_ref = params.get("outRef")
                if not card_id:
                    return _fail("probeSource requires params.cardId")
                if source_idx is None:
                    return _fail("probeSource requires params.sourceIdx")
                source_idx = int(source_idx)
                b = (input_data or {}).get("body") or {}
                mock_projections = b.get("mock-projections", {})
                card = card_store().read_card(card_id)
                if not card:
                    return _fail(f'Card "{card_id}" not found')
                source_defs = card.get("source_defs") or []
                if source_idx < 0 or source_idx >= len(source_defs):
                    return _fail(f"sourceIdx {source_idx} out of range (card has {len(source_defs)} source(s))")
                return self._run_source_probe(source_defs[source_idx], mock_projections, out_ref)
            except Exception as e:
                return _err(e)

        def probe_tmp_source(self, input_data: dict | None = None) -> dict:
            """Port of probeTmpSource — probe a source_def supplied directly in the body."""
            try:
                params = (input_data or {}).get("params", {})
                out_ref = params.get("outRef")
                b = (input_data or {}).get("body")
                if not b:
                    return _fail('probeTmpSource requires body with "source-def" and "mock-projections"')
                source_def = b.get("source-def")
                mock_projections = b.get("mock-projections", {})
                if not source_def:
                    return _fail('probeTmpSource body requires "source-def"')
                return self._run_source_probe(source_def, mock_projections, out_ref)
            except Exception as e:
                return _err(e)

        def probe_source_preflight(self, input_data: dict | None = None) -> dict:
            """Port of probeSourcePreflight — lightweight preflight probe for a source.

            Accepts card JSON + sourceIdx in the body/params. Tries the executor's
            probe-source-preflight subcommand first, falls back to a full source
            probe via _run_source_probe.
            """
            try:
                params = (input_data or {}).get("params", {})
                source_idx = params.get("sourceIdx")
                out_ref = params.get("outRef")
                if source_idx is None:
                    return _fail("probeSourcePreflight requires params.sourceIdx")
                source_idx = int(source_idx)
                body = (input_data or {}).get("body")
                if not body or not isinstance(body, dict):
                    return _fail("probeSourcePreflight requires card JSON object in body")
                card = body.get("card-content", body)
                if not isinstance(card, dict):
                    return _fail("probeSourcePreflight requires card JSON object in body")
                mock_projections = body.get("mock-projections", {})
                source_defs = card.get("source_defs") or []
                if source_idx < 0 or source_idx >= len(source_defs):
                    return _fail(
                        f"sourceIdx {source_idx} out of range (card has {len(source_defs)} source(s))"
                    )
                src = source_defs[source_idx]

                # Try the lightweight probe-source-preflight executor hook first.
                te_ref = config_store().read_task_executor_ref()
                if te_ref:
                    bind_to = src.get("bindTo", "source") if isinstance(src.get("bindTo"), str) else "source"
                    try:
                        in_payload = {**src, "_projections": mock_projections}
                        stdout = adapter.invoke_executor_sync(
                            te_ref, "probe-source-preflight", [],
                            {"timeout": src.get("timeout", 10_000), "input": json.dumps(in_payload)},
                        )
                        result = json.loads(stdout.strip())
                        if not result.get("ok"):
                            return _fail(result.get("error", "Preflight probe failed"))
                        return _ok({
                            "bindTo": bind_to,
                            "reachable": result.get("reachable"),
                            "latencyMs": result.get("latencyMs"),
                            "note": result.get("note"),
                        })
                    except Exception:
                        pass  # executor doesn't support subcommand — fall through

                # Fallback: full source execution (original behaviour).
                return self._run_source_probe(src, mock_projections, out_ref)
            except Exception as e:
                return _err(e)

        def eval_card_compute(self, input_data: dict | None = None) -> dict:
            """Port of evalCardCompute — run compute steps with mock data, no board state needed.

            Body shape:
              { "card-content": <card>, "mock-fetched-sources": {...}, "mock-requires": {...} }
            Returns:
              { cardId, ok, computed_values, errors }
            """
            try:
                body = (input_data or {}).get("body")
                if not body or not isinstance(body, dict):
                    return _fail("evalCardCompute requires a JSON object in body")
                card = body.get("card-content", body)
                if not isinstance(card, dict):
                    return _fail("evalCardCompute requires a JSON object in body")
                card_id = card.get("id", "(unknown)")
                mock_fetched_sources = body.get("mock-fetched-sources") or {}
                mock_requires = body.get("mock-requires") or {}

                compute_steps = card.get("compute")
                if not compute_steps or not isinstance(compute_steps, list) or len(compute_steps) == 0:
                    return _ok({"cardId": card_id, "ok": True, "computed_values": {}, "errors": []})

                node = {
                    "id": card_id,
                    "card_data": card.get("card_data") or {},
                    "requires": mock_requires,
                    "source_defs": card.get("source_defs"),
                    "compute": compute_steps,
                }

                result = CardCompute.run_sync(node, {"sourcesData": mock_fetched_sources})
                computed = result["node"].get("computed_values") or {}
                errors = result.get("errors") or []
                return _ok({"cardId": card_id, "ok": len(errors) == 0, "computed_values": computed, "errors": errors})
            except Exception as e:
                return _err(e)

        def simulate_card_cycle(self, input_data: dict | None = None) -> dict:
            """Port of simulateCardCycle — full pipeline simulation with mock data.

            Steps: validate → resolve projections → probe sources → compute.

            Body shape:
              { "card-content": <card>, "mock-fetched-sources": {...}, "mock-requires": {...} }
            Returns:
              { cardId, ok, validation, source_probes, projection_errors, computed_values, compute_errors }
            """
            try:
                body = (input_data or {}).get("body")
                if not body or not isinstance(body, dict):
                    return _fail("simulateCardCycle requires a JSON object in body")
                card = body.get("card-content", body)
                if not isinstance(card, dict):
                    return _fail("simulateCardCycle requires a JSON object in body")
                card_id = card.get("id", "(unknown)")
                mock_fetched_sources = body.get("mock-fetched-sources") or {}
                mock_requires = body.get("mock-requires") or {}

                # 1. Structural validation
                struct_result = self._validate_card_object(card_id, card)
                if struct_result.get("status") == "success":
                    validation = {
                        "isValid": struct_result["data"]["isValid"],
                        "issues": struct_result["data"]["issues"],
                    }
                else:
                    err_msg = struct_result.get("error", "internal error") if struct_result.get("status") == "fail" else "internal error"
                    validation = {"isValid": False, "issues": [err_msg]}

                # 2. Resolve projections via enrich_sources_sync
                source_defs = card.get("source_defs") or []
                card_data = card.get("card_data") or {}
                enriched_sources: list[dict] = []
                projection_errors: list[dict] = []
                if source_defs:
                    enriched_sources = CardCompute.enrich_sources_sync(
                        source_defs,
                        {"card_data": card_data, "requires": mock_requires},
                    )
                    for src in enriched_sources:
                        projections = src.get("projections")
                        resolved = src.get("_projections")
                        if isinstance(projections, dict) and isinstance(resolved, dict):
                            for key in projections:
                                if resolved.get(key) is None:
                                    bind_to = src.get("bindTo", "(unknown)") if isinstance(src.get("bindTo"), str) else "(unknown)"
                                    projection_errors.append({
                                        "bindTo": bind_to,
                                        "key": key,
                                        "error": f'Projection "{key}" resolved to undefined',
                                    })

                # 3. Probe each source (if executor is registered)
                source_probes: list[dict] = []
                te_ref = config_store().read_task_executor_ref()
                for i, src in enumerate(enriched_sources):
                    bind_to = src.get("bindTo", f"source_{i}") if isinstance(src.get("bindTo"), str) else f"source_{i}"
                    if not te_ref:
                        source_probes.append({"bindTo": bind_to, "skipped": True, "error": "No task-executor registered"})
                        continue
                    try:
                        in_payload = {**src}
                        stdout = adapter.invoke_executor_sync(
                            te_ref, "probe-source-preflight", [],
                            {"timeout": src.get("timeout", 10_000), "input": json.dumps(in_payload)},
                        )
                        result = json.loads(stdout.strip())
                        source_probes.append({
                            "bindTo": bind_to,
                            "reachable": result.get("reachable"),
                            "latencyMs": result.get("latencyMs"),
                            "error": None if result.get("ok") else result.get("error"),
                        })
                    except Exception:
                        source_probes.append({"bindTo": bind_to, "skipped": True, "error": "Executor does not support probe-source-preflight"})

                # 4. Run compute expressions
                compute_steps = card.get("compute")
                computed_values: dict = {}
                compute_errors: list[dict] = []
                if compute_steps and isinstance(compute_steps, list) and len(compute_steps) > 0:
                    node = {
                        "id": card_id,
                        "card_data": card_data,
                        "requires": mock_requires,
                        "source_defs": card.get("source_defs"),
                        "compute": compute_steps,
                    }
                    result = CardCompute.run_sync(node, {"sourcesData": mock_fetched_sources})
                    computed_values = result["node"].get("computed_values") or {}
                    compute_errors = result.get("errors") or []

                all_ok = (
                    validation["isValid"]
                    and len(projection_errors) == 0
                    and len(compute_errors) == 0
                    and all(p.get("reachable") is not False for p in source_probes)
                )

                return _ok({
                    "cardId": card_id,
                    "ok": all_ok,
                    "validation": validation,
                    "source_probes": source_probes,
                    "projection_errors": projection_errors,
                    "computed_values": computed_values,
                    "compute_errors": compute_errors,
                })
            except Exception as e:
                return _err(e)

        def describe_task_executor_capabilities(self, input_data: dict | None = None) -> dict:
            """Port of describeTaskExecutorCapabilities — query the executor's capability manifest."""
            try:
                te_ref = config_store().read_task_executor_ref()
                if not te_ref:
                    return _fail("No task-executor registered for this board")
                stdout = adapter.invoke_executor_sync(te_ref, "describe-capabilities", [], {"timeout": 10_000})
                return _ok(json.loads(stdout.strip()))
            except Exception as e:
                return _err(e)

    return _BoardLiveCardsPublic()
