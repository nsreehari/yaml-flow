"""
board-live-cards-lib — Pure logic library for the board-live-cards CLI.

Zero platform imports. All storage is injected via adapter interfaces.
Safe for any Python runtime.

Port of src/cli/common/board-live-cards-lib.ts
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any, Callable

from .storage_interface import serialize_ref, parse_ref
from .execution_interface import parse_execution_ref, serialize_execution_ref
from ..continuous_event_graph.schedule import schedule


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# ============================================================================
# Constants
# ============================================================================

SNAPSHOT_SCHEMA_VERSION_V1 = "v1"
BOARD_GRAPH_KEY = "board/graph"
BOARD_LAST_JOURNAL_PROCESSED_ID_KEY = "board/lastJournalProcessedId"

EMPTY_CONFIG: dict = {
    "settings": {"completion": "manual", "refreshStrategy": "data-changed"},
    "tasks": {},
}


# ============================================================================
# Card store
# ============================================================================

def create_card_store(adapter: Any, on_warn: Callable | None = None) -> Any:
    """
    Create a CardAdminStore from a CardStorageAdapter.

    adapter protocol:
        read_index() -> dict | None
        write_index(index: dict) -> None
        read_card(key: str) -> dict | None
        write_card(key: str, card: dict) -> str  (returns checksum)
        card_exists(key: str) -> bool
        default_card_key(card_id: str) -> str
    """

    def load_index() -> dict:
        return adapter.read_index() or {}

    def apply_json_path(obj: dict, json_path: str, value: Any) -> dict:
        segments = [s for s in (json_path or "").split(".") if s]
        if not segments:
            if isinstance(value, dict):
                return value
            return {"value": value}

        out = {**obj}
        target = out
        for i in range(len(segments) - 1):
            key = segments[i]
            cur = target.get(key)
            nxt = {**cur} if isinstance(cur, dict) else {}
            target[key] = nxt
            target = nxt
        target[segments[-1]] = value
        return out

    class _CardAdminStore:
        def read_card(self, card_id: str) -> dict | None:
            entry = load_index().get(card_id)
            if not entry or not adapter.card_exists(entry["key"]):
                return None
            return adapter.read_card(entry["key"])

        def read_card_key(self, card_id: str) -> str | None:
            entry = load_index().get(card_id)
            return entry["key"] if entry else None

        def read_all_cards(self) -> list[dict]:
            cards = []
            for card_id, entry in load_index().items():
                if not adapter.card_exists(entry["key"]):
                    continue
                card = adapter.read_card(entry["key"])
                if card:
                    cards.append(card)
                elif on_warn:
                    on_warn(f'[card-store] could not read card "{card_id}" at key "{entry["key"]}"')
            return cards

        def read_checksum_index(self) -> dict[str, str]:
            return {card_id: entry["checksum"] for card_id, entry in load_index().items()}

        def changed_since(self, snapshot_checksum_index: dict[str, str]) -> list[str]:
            local_index = load_index()
            changed = []
            for card_id, entry in local_index.items():
                if snapshot_checksum_index.get(card_id) != entry["checksum"]:
                    changed.append(card_id)
            for card_id in snapshot_checksum_index:
                if card_id not in local_index:
                    changed.append(card_id)
            return changed

        def validate_upsert(self, card_id: str, card_key: str) -> dict:
            index = load_index()
            existing_by_id = index.get(card_id)
            existing_by_key = None
            for eid, entry in index.items():
                if entry["key"] == card_key:
                    existing_by_key = (eid, entry)
                    break
            if existing_by_id and existing_by_id["key"] != card_key:
                return {"ok": False, "error": f'Card id "{card_id}" is already mapped to key "{existing_by_id["key"]}", cannot remap to "{card_key}"'}
            if existing_by_key and existing_by_key[0] != card_id:
                return {"ok": False, "error": f'Key "{card_key}" is already mapped to card id "{existing_by_key[0]}", cannot remap to "{card_id}"'}
            return {"ok": True}

        def write_card(self, card_id: str, card: dict, card_key: str | None = None) -> None:
            index = load_index()
            resolved_key = card_key or (index.get(card_id, {}).get("key")) or adapter.default_card_key(card_id)
            checksum = adapter.write_card(resolved_key, card)
            index[card_id] = {"key": resolved_key, "checksum": checksum, "updatedAt": _now_iso()}
            adapter.write_index(index)

        def patch_card(self, card_id: str, json_path: str, value: Any) -> None:
            index = load_index()
            entry = index.get(card_id)
            if not entry or not adapter.card_exists(entry["key"]):
                raise ValueError(f'card "{card_id}" not found')
            current = adapter.read_card(entry["key"])
            if not current or not isinstance(current, dict):
                raise ValueError(f'card "{card_id}" is not patchable')
            nxt = apply_json_path(current, json_path, value)
            checksum = adapter.write_card(entry["key"], nxt)
            index[card_id] = {"key": entry["key"], "checksum": checksum, "updatedAt": _now_iso()}
            adapter.write_index(index)

        def remove_card(self, card_id: str) -> None:
            index = load_index()
            if card_id not in index:
                return
            del index[card_id]
            adapter.write_index(index)

        def read_index(self) -> dict:
            return load_index()

    return _CardAdminStore()


# ============================================================================
# FetchedSourcesStore
# ============================================================================

def create_fetched_sources_store(blob: Any, resolve_ref: Callable) -> Any:
    """
    blob protocol: read(key) -> str|None, write(key, content) -> None, exists(key) -> bool, remove(key)
    resolve_ref: (ref_dict) -> str
    """

    class _FetchedSourcesStore:
        def read_source_data(self, card_id: str, output_file: str) -> Any:
            raw = blob.read(f"{card_id}/{output_file}")
            if raw is None:
                return None
            trimmed = raw.strip()
            if not trimmed:
                return None
            try:
                return json.loads(trimmed)
            except (json.JSONDecodeError, TypeError):
                return trimmed

        def ingest_source_data_staged(self, card_id: str, output_file: str, ref: dict, delivery_token: str) -> None:
            content = resolve_ref(ref)
            blob.write(f"{card_id}/.staged/{delivery_token}/{output_file}", content)

        def commit_source_data(self, card_id: str, output_file: str, delivery_token: str) -> bool:
            staged_key = f"{card_id}/.staged/{delivery_token}/{output_file}"
            content = blob.read(staged_key)
            if content is None:
                return False
            blob.write(f"{card_id}/{output_file}", content)
            blob.remove(staged_key)
            return True

        def has_source(self, card_id: str, output_file: str) -> bool:
            return blob.exists(f"{card_id}/{output_file}")

    return _FetchedSourcesStore()


# ============================================================================
# Journal store
# ============================================================================

def create_journal_store(adapter: Any) -> Any:
    """
    adapter protocol:
        read_all_entries() -> list[{"id": str, "event": dict}]
        append_entry(entry: {"id": str, "event": dict}) -> None
        generate_id() -> str
    """

    def entries_after_cursor(cursor: str) -> list[dict]:
        all_entries = adapter.read_all_entries()
        if not cursor:
            return all_entries
        idx = None
        for i, e in enumerate(all_entries):
            if e["id"] == cursor:
                idx = i
                break
        if idx is None:
            return all_entries
        return all_entries[idx + 1:]

    class _JournalAdminStore:
        def read_entries_after_cursor(self, cursor: str) -> dict:
            entries = entries_after_cursor(cursor)
            if not entries:
                return {"events": [], "newCursor": cursor}
            return {"events": [e["event"] for e in entries], "newCursor": entries[-1]["id"]}

        def pending_count(self, cursor: str) -> int:
            return len(entries_after_cursor(cursor))

        def append_event(self, event: dict) -> None:
            adapter.append_entry({"id": adapter.generate_id(), "event": event})

    return _JournalAdminStore()


# ============================================================================
# ExecutionRequest store
# ============================================================================

def create_execution_request_store(kv: Any, on_dispatch_failed: Callable) -> Any:
    """
    kv protocol: read(key) -> Any, write(key, value) -> None, delete(key) -> None
    on_dispatch_failed: (entry, error_str) -> None
    """

    class _ExecutionRequestStore:
        def append_entries(self, journal_id: str, entries: list[dict]) -> None:
            if not journal_id or not entries:
                return
            existing = kv.read(journal_id) or []
            kv.write(journal_id, [*existing, *entries])

        def dispatch_entries_for_journal_id(self, journal_id: str, processor_fn: Callable) -> None:
            if not journal_id:
                return
            entries = kv.read(journal_id)
            if not entries:
                return
            for entry in entries:
                try:
                    processor_fn(entry)
                except Exception as exc:
                    try:
                        on_dispatch_failed(entry, str(exc))
                    except Exception:
                        pass
            kv.delete(journal_id)

    return _ExecutionRequestStore()


# ============================================================================
# StateSnapshot store
# ============================================================================

def card_runtime_key(card_id: str) -> str:
    return f"cards/{card_id}/runtime"


def card_fetched_sources_manifest_key(card_id: str) -> str:
    return f"cards/{card_id}/fetched-sources-manifest"


def create_state_snapshot_store(adapter: Any) -> Any:
    """
    adapter protocol:
        read_values(scope_id: str) -> {"version": str|None, "values": dict}
        write_values(scope_id: str, next_values: dict, deleted_keys: list) -> str
    """

    class _StateSnapshotStore:
        def read_snapshot(self, scope_id: str) -> dict:
            return adapter.read_values(scope_id)

        def commit_snapshot(self, scope_id: str, envelope: dict) -> dict:
            if envelope.get("schemaVersion") != SNAPSHOT_SCHEMA_VERSION_V1:
                raise ValueError(f"Unsupported snapshot schema version: {envelope.get('schemaVersion')}")
            current = adapter.read_values(scope_id)
            if current["version"] != envelope.get("expectedVersion"):
                return {"ok": False, "reason": "version-mismatch", "currentVersion": current["version"]}
            next_values = apply_state_snapshot_commit_envelope(
                current["values"], envelope
            )
            new_version = adapter.write_values(scope_id, next_values, envelope.get("deleteKeys", []))
            return {"ok": True, "newVersion": new_version}

    return _StateSnapshotStore()


def apply_state_snapshot_commit_envelope(current: dict, envelope: dict) -> dict:
    nxt = {**current}
    for key in envelope.get("deleteKeys", []):
        nxt.pop(key, None)
    return {**nxt, **envelope.get("shallowMerge", {})}


# ============================================================================
# CardRuntimeStore
# ============================================================================

def create_card_runtime_store(kv: Any) -> Any:
    class _CardRuntimeStore:
        def read_runtime(self, card_id: str) -> dict:
            return kv.read(card_runtime_key(card_id)) or {"_sources": {}}

        def write_runtime(self, card_id: str, state: dict) -> None:
            kv.write(card_runtime_key(card_id), state)

    return _CardRuntimeStore()


# ============================================================================
# BoardConfigStore
# ============================================================================

def create_board_config_store(kv: Any) -> Any:
    def read_key(key: str) -> str | None:
        v = kv.read(key)
        if v is None:
            return None
        return v if isinstance(v, str) else json.dumps(v)

    class _BoardConfigStore:
        def read_task_executor_ref(self) -> dict | None:
            raw = read_key("task-executor")
            if not raw or not raw.strip():
                return None
            return parse_execution_ref(raw.strip())

        def write_task_executor_ref(self, ref: dict) -> None:
            kv.write("task-executor", serialize_execution_ref(ref))

        def read_chat_handler_ref(self) -> dict | None:
            raw = read_key("chat-handler")
            if not raw or not raw.strip():
                return None
            return parse_execution_ref(raw.strip())

        def write_chat_handler_ref(self, ref: dict) -> None:
            kv.write("chat-handler", serialize_execution_ref(ref))

        def read_card_store_ref(self) -> str | None:
            return read_key("card-store-ref")

        def write_card_store_ref(self, ref: str) -> None:
            kv.write("card-store-ref", ref)

        def read_outputs_store_ref(self) -> str | None:
            return read_key("outputs-store-ref")

        def write_outputs_store_ref(self, ref: str) -> None:
            kv.write("outputs-store-ref", ref)

        def read_chat_handler(self) -> str | None:
            raw = read_key("chat-handler")
            return raw.strip() if raw else None

        def write_chat_handler(self, value: str) -> None:
            kv.write("chat-handler", value)

    return _BoardConfigStore()


# ============================================================================
# PublishedOutputsStore
# ============================================================================

def create_published_outputs_store(kv: Any) -> Any:
    class _PublishedOutputsStore:
        def write_computed_values(self, card_id: str, values: dict) -> None:
            kv.write(f"cards/{card_id}/computed_values", values)

        def read_computed_values(self, card_id: str) -> Any:
            return kv.read(f"cards/{card_id}/computed_values")

        def read_all_computed_values(self) -> dict:
            import re
            out = {}
            for key in kv.list_keys("cards/"):
                m = re.match(r"^cards/([^/]+)/computed_values$", key)
                if m:
                    out[m.group(1)] = kv.read(key)
            return out

        def write_data_objects(self, data: dict) -> None:
            for token, payload in data.items():
                if not token:
                    continue
                kv.write(f"data-objects/{token}", payload)

        def read_data_object(self, key: str) -> Any:
            return kv.read(f"data-objects/{key}")

        def read_all_data_objects(self) -> dict:
            out = {}
            for key in kv.list_keys("data-objects/"):
                out[key[len("data-objects/"):]] = kv.read(key)
            return out

        def write_status_snapshot(self, status: Any) -> None:
            kv.write("status", status)

        def read_status_snapshot(self) -> Any:
            return kv.read("status")

    return _PublishedOutputsStore()


# ============================================================================
# Source runtime helpers
# ============================================================================

def is_source_in_flight(entry: dict | None) -> bool:
    if not entry or not entry.get("lastRequestedAt"):
        return False
    return not entry.get("lastFetchedAt") or entry["lastFetchedAt"] < entry["lastRequestedAt"]


def decide_source_action(entry: dict | None, queue_requested_at: str) -> str:
    if not entry or not entry.get("lastRequestedAt"):
        return "dispatch"
    if is_source_in_flight(entry):
        return "in-flight"
    if not entry.get("lastFetchedAt"):
        return "dispatch"
    if entry["lastFetchedAt"] < queue_requested_at:
        return "dispatch"
    return "idle"


def next_entry_after_fetch_delivery(entry: dict, fetched_at: str) -> dict:
    nxt = {**entry, "lastFetchedAt": fetched_at}
    nxt.pop("lastError", None)
    return nxt


def next_entry_after_fetch_failure(entry: dict, reason: str) -> dict:
    nxt = {**entry, "lastError": reason}
    nxt.pop("lastFetchedAt", None)
    return nxt


# ============================================================================
# BoardStatus builder
# ============================================================================

def build_board_status_object(board_path: str, live: dict) -> dict:
    """Build a board status summary object from a LiveGraph."""
    task_state = live["state"].get("tasks", {})
    task_config = live["config"].get("tasks", {})
    card_names = sorted(task_state.keys())
    sched = schedule(live)

    status_counts = {
        "completed": 0, "failed": 0, "in_progress": 0,
        "pending": 0, "blocked": 0, "unresolved": 0,
    }

    waiting_by_card: dict[str, list[str]] = {}
    for p in sched.get("pending", []):
        waiting_by_card[p["taskName"]] = p["waitingOn"]
    for u in sched.get("unresolved", []):
        waiting_by_card[u["taskName"]] = u["missingTokens"]
    for b in sched.get("blocked", []):
        waiting_by_card[b["taskName"]] = b["failedTokens"]

    dependents_by_token: dict[str, list[str]] = {}
    for name, cfg in task_config.items():
        for token in cfg.get("requires") or []:
            dependents_by_token.setdefault(token, []).append(name)

    cards = []
    for name in card_names:
        state = task_state[name]
        cfg = task_config.get(name, {"requires": [], "provides": []})

        st = state.get("status", "not-started")
        if st == "completed":
            status_counts["completed"] += 1
        elif st == "failed":
            status_counts["failed"] += 1
        elif st == "running":
            status_counts["in_progress"] += 1

        requires = cfg.get("requires") or []
        provides = cfg.get("provides") or []
        runtime_keys = sorted((state.get("data") or {}).keys())
        available = live["state"].get("availableOutputs", [])
        requires_satisfied = [t for t in requires if t in available]
        requires_missing = [t for t in requires if t not in available]
        blocked_by = waiting_by_card.get(name, requires_missing)

        unblocks = set()
        for token in provides:
            for dep in dependents_by_token.get(token, []):
                if dep != name:
                    unblocks.add(dep)

        card_obj: dict = {
            "name": name,
            "status": st,
        }
        if state.get("error"):
            card_obj["error"] = {
                "message": state["error"],
                "code": "TASK_FAILED",
                "at": state.get("failedAt"),
                "source": "task-runtime",
            }

        card_obj.update({
            "requires": requires,
            "requires_satisfied": requires_satisfied,
            "requires_missing": requires_missing,
            "provides_declared": provides,
            "provides_runtime": runtime_keys,
            "blocked_by": blocked_by,
            "unblocks": sorted(unblocks),
            "runtime": {
                "attempt_count": state.get("executionCount", 0),
                "restart_count": state.get("retryCount", 0),
                "in_progress_since": state.get("startedAt") if st == "running" else None,
                "last_transition_at": state.get("lastUpdated"),
                "last_completed_at": state.get("completedAt"),
                "last_restarted_at": state.get("startedAt"),
                "status_age_ms": 0 if state.get("lastUpdated") else None,
            },
        })
        cards.append(card_obj)

    status_counts["pending"] = len(sched.get("pending", []))
    status_counts["blocked"] = len(sched.get("blocked", []))
    status_counts["unresolved"] = len(sched.get("unresolved", []))

    fan_out = sorted(
        [{"name": c["name"], "fanOut": len(c["unblocks"])} for c in cards],
        key=lambda x: (-x["fanOut"], x["name"]),
    )
    max_fan_out = fan_out[0] if fan_out else {"name": None, "fanOut": 0}

    all_requires: set[str] = set()
    for cfg in task_config.values():
        for r in cfg.get("requires") or []:
            all_requires.add(r)

    orphan_cards = 0
    for name, cfg in task_config.items():
        requires_none = len(cfg.get("requires") or []) == 0
        provides_list = cfg.get("provides") or []
        feeds_any = any(
            any(d != name for d in dependents_by_token.get(p, []))
            for p in provides_list
        )
        if requires_none and not feeds_any:
            orphan_cards += 1

    return {
        "schema_version": "v1",
        "meta": {"board": {"path": board_path}},
        "summary": {
            "card_count": len(card_names),
            "completed": status_counts["completed"],
            "eligible": len(sched.get("eligible", [])),
            "pending": status_counts["pending"],
            "blocked": status_counts["blocked"],
            "unresolved": status_counts["unresolved"],
            "failed": status_counts["failed"],
            "in_progress": status_counts["in_progress"],
            "orphan_cards": orphan_cards,
            "topology": {
                "edge_count": len(all_requires),
                "max_fan_out_card": max_fan_out["name"],
                "max_fan_out": max_fan_out["fanOut"],
            },
        },
        "cards": cards,
    }


# ============================================================================
# Card handler factory
# ============================================================================

def create_card_handler_fn(
    base_ref: dict,
    journal_id: str,
    adapters: dict,
    task_completed_fn: Callable,
    task_failed_fn: Callable,
    write_computed_values_fn: Callable | None = None,
    write_data_objects_fn: Callable | None = None,
    notify_card_fn: Callable | None = None,
) -> Callable:
    """
    Create a card handler function for the reactive graph.

    adapters = {
        "cardStore": ...,
        "cardRuntimeStore": ...,
        "fetchedSourcesStore": ...,
        "outputStore": ...,
        "executionRequestStore": ...,
    }
    """
    try:
        from ..card_compute import CardCompute
    except Exception:
        CardCompute = None  # type: ignore[assignment]

    def handler(handler_input: dict) -> str:
        pending_requests: list[dict] = []
        card_store = adapters["cardStore"]
        card = card_store.read_card(handler_input["nodeId"])
        if not card:
            return "task-initiate-failure"

        card_id = card.get("id", handler_input["nodeId"])
        if not handler_input.get("update") and notify_card_fn:
            notify_card_fn(card_id, card)

        card_state = card.get("card_data") or {}
        all_sources = card.get("source_defs") or []
        required_sources = [s for s in all_sources if not s.get("optionalForCompletionGating")]

        runtime_store = adapters["cardRuntimeStore"]
        state = runtime_store.read_runtime(card_id)
        dirty = False

        def flush():
            nonlocal dirty
            if not dirty:
                return
            runtime_store.write_runtime(card_id, state)
            dirty = False

        def get_source_entry(output_file: str) -> dict:
            return {**(state.get("_sources", {}).get(output_file) or {})}

        def set_source_entry(output_file: str, entry: dict) -> None:
            nonlocal dirty
            state.setdefault("_sources", {})[output_file] = entry
            dirty = True

        current_exec_count = (handler_input.get("taskState") or {}).get("executionCount", 0)
        last_exec_count = state.get("_lastExecutionCount")
        if isinstance(last_exec_count, int) and last_exec_count != current_exec_count:
            state["_sources"] = {}
            dirty = True
        if last_exec_count != current_exec_count:
            state["_lastExecutionCount"] = current_exec_count
            dirty = True

        update = handler_input.get("update")
        if update:
            output_file = update.get("outputFile")
            if output_file:
                entry = get_source_entry(output_file)
                if update.get("failure"):
                    set_source_entry(output_file, next_entry_after_fetch_failure(entry, update.get("reason", "unknown")))
                else:
                    incoming_rqt = update.get("rqt", "")
                    if not entry.get("lastFetchedAt") or incoming_rqt > entry.get("lastFetchedAt", ""):
                        delivery_token = update.get("deliveryToken")
                        if isinstance(delivery_token, str):
                            adapters["fetchedSourcesStore"].commit_source_data(card_id, output_file, delivery_token)
                        set_source_entry(output_file, next_entry_after_fetch_delivery(entry, incoming_rqt))
                flush()

        # Load source data
        sources_data: dict[str, Any] = {}
        for src in all_sources:
            output_file = src.get("outputFile")
            if output_file:
                content = adapters["fetchedSourcesStore"].read_source_data(card_id, output_file)
                if content is not None:
                    sources_data[src["bindTo"]] = content

        # Build requires
        requires: dict[str, Any] = {}
        for token, task_data in (handler_input.get("state") or {}).items():
            if isinstance(task_data, dict):
                unwrapped = task_data.get(token)
                requires[token] = unwrapped if unwrapped is not None else task_data
            else:
                requires[token] = task_data

        # Run compute
        compute_node = {
            "id": card_id,
            "card_data": {**card_state},
            "requires": requires,
            "source_defs": all_sources,
            "compute": card.get("compute"),
            "_sourcesData": sources_data,
            "computed_values": {},
        }

        if card.get("compute") and CardCompute:
            result = CardCompute.run_sync(compute_node, {"sourcesData": sources_data})
            compute_node = result.get("node", compute_node)

        cv_fn = write_computed_values_fn or adapters["outputStore"].write_computed_values
        cv_fn(card_id, compute_node.get("computed_values") or {})

        # Enriched card for source dispatch
        enriched_card = {**card}
        if CardCompute:
            enriched_sources = CardCompute.enrich_sources_sync(
                all_sources,
                {"card_data": card.get("card_data") or {}, "requires": requires},
            )
        else:
            enriched_sources = all_sources
        enriched_card["source_defs"] = enriched_sources

        now = _now_iso()
        run_queued_at = None if update else now

        undelivered_required = []
        for s in required_sources:
            output_file = s.get("outputFile")
            if not isinstance(output_file, str) or not output_file:
                undelivered_required.append(s)
                continue
            entry = get_source_entry(output_file)
            if run_queued_at:
                entry = {**entry, "queueRequestedAt": run_queued_at}
                set_source_entry(output_file, entry)
            qrt = entry.get("queueRequestedAt") or entry.get("lastRequestedAt") or now
            action = decide_source_action(entry, qrt)
            if action == "in-flight":
                continue
            if action == "dispatch":
                undelivered_required.append(s)

        flush()

        if undelivered_required:
            stamped_any = False
            dispatch_rqt = now
            for src in undelivered_required:
                output_file = src.get("outputFile")
                if not isinstance(output_file, str) or not output_file:
                    continue
                entry = get_source_entry(output_file)
                queued_at = entry.get("queueRequestedAt") or now
                set_source_entry(output_file, {**entry, "lastRequestedAt": queued_at})
                dispatch_rqt = queued_at
                stamped_any = True
            if stamped_any:
                flush()
            if not stamped_any:
                return "task-initiated"

            pending_requests.append({
                "taskKind": "source-fetch",
                "payload": {
                    "boardRef": serialize_ref(base_ref),
                    "enrichedCard": enriched_card,
                    "callbackToken": handler_input.get("callbackToken", ""),
                    "rqt": dispatch_rqt,
                },
            })
            adapters["executionRequestStore"].append_entries(journal_id, pending_requests)
            return "task-initiated"

        # Compute provides data
        provides_bindings = card.get("provides") or []
        data: dict[str, Any] = {}
        for binding in provides_bindings:
            bind_to = binding.get("bindTo", "")
            ref = binding.get("ref", "")
            if CardCompute:
                data[bind_to] = CardCompute.resolve(compute_node, ref)
            else:
                data[bind_to] = _deep_get(compute_node, ref)

        do_fn = write_data_objects_fn or adapters["outputStore"].write_data_objects
        do_fn(data)

        task_completed_fn(handler_input["nodeId"], data)
        if pending_requests:
            adapters["executionRequestStore"].append_entries(journal_id, pending_requests)
        return "task-initiated"

    return handler


# ============================================================================
# Board envelope codec
# ============================================================================

def board_envelope_to_snapshot_entries(envelope: dict) -> dict:
    return {
        BOARD_GRAPH_KEY: envelope["graph"],
        BOARD_LAST_JOURNAL_PROCESSED_ID_KEY: envelope["lastDrainedJournalId"],
    }


def snapshot_entries_to_board_envelope(entries: dict) -> dict:
    graph = entries.get(BOARD_GRAPH_KEY)
    last_drained = entries.get(BOARD_LAST_JOURNAL_PROCESSED_ID_KEY)
    if not graph or not isinstance(graph, dict):
        raise ValueError(f"State snapshot is missing required key: {BOARD_GRAPH_KEY}")
    return {
        "graph": graph,
        "lastDrainedJournalId": last_drained if isinstance(last_drained, str) else "",
    }


# ============================================================================
# Card -> TaskConfig conversion
# ============================================================================

def live_card_to_task_config(card: dict) -> dict:
    """Transform a LiveCard into a TaskConfig for the reactive graph."""
    requires = card.get("requires")
    provides_raw = card.get("provides") or []
    provides = [p.get("bindTo", "") for p in provides_raw if isinstance(p, dict)]

    meta = card.get("meta") or {}
    description = meta.get("title", card.get("id", ""))

    result: dict[str, Any] = {
        "provides": provides,
        "taskHandlers": ["card-handler"],
        "description": description,
    }
    if requires and len(requires) > 0:
        result["requires"] = requires
    return result


# ============================================================================
# Internal helper
# ============================================================================

def _deep_get(obj: Any, path: str) -> Any:
    """Deep get with dot-separated path."""
    if not path or obj is None:
        return None
    parts = path.split(".")
    cur = obj
    for part in parts:
        if cur is None:
            return None
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            cur = getattr(cur, part, None)
    return cur
