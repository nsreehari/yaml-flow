"""
Continuous Event Graph — Reactive Layer

Push-based, self-sustaining execution wrapper.

Pattern:
  1. Register handlers for tasks
  2. Push an event (or inject tokens)
  3. The graph drives itself: drain journal -> applyEvents -> schedule -> dispatch -> repeat

Dispatch is synchronous. No daemon, no polling. Each handler callback
appends to the journal, which triggers a drain cycle that may dispatch
the next wave.

Port of src/continuous-event-graph/reactive.ts
"""
from __future__ import annotations

import base64
import json
import time
from datetime import datetime, timezone
from typing import Any, Callable

from .core import create_live_graph, apply_events, snapshot
from .schedule import schedule
from .journal import MemoryJournal


# ============================================================================
# Internal helpers
# ============================================================================

def compute_data_hash(data: dict) -> str:
    """
    Deterministic hash of a data payload.
    Recursively-sorted JSON -> stable 64-bit hex (FNV-1a).
    """
    json_str = _stable_stringify(data)
    return _fnv1a_64_hex(json_str)


def _stable_stringify(value: Any) -> str:
    """Recursively produce a JSON string with sorted keys at every level."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return json.dumps(value)
    if isinstance(value, str):
        return json.dumps(value)
    if isinstance(value, list):
        return "[" + ",".join(_stable_stringify(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        return "{" + ",".join(
            json.dumps(k) + ":" + _stable_stringify(value[k]) for k in keys
        ) + "}"
    return json.dumps(value)


def _fnv1a_64_hex(input_str: str) -> str:
    """Stable 64-bit FNV-1a hash as 16-char hex."""
    h = 0xCBF29CE484222325
    prime = 0x100000001B3
    mask = 0xFFFFFFFFFFFFFFFF
    for ch in input_str:
        h ^= ord(ch)
        h = (h * prime) & mask
    return format(h, "016x")


def _to_base64_url(s: str) -> str:
    """Encode string to base64url (no padding)."""
    return base64.urlsafe_b64encode(s.encode("utf-8")).rstrip(b"=").decode("ascii")


def _from_base64_url(s: str) -> str:
    """Decode base64url string."""
    padded = s + "=" * ((4 - len(s) % 4) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")


def _encode_callback_token(task_name: str) -> str:
    """Encode a callback token for a task."""
    import random
    nonce = format(int(time.time() * 1000), "x") + format(random.getrandbits(32), "x")
    payload = json.dumps({"t": task_name, "n": nonce})
    return _to_base64_url(payload)


def _decode_callback_token(token: str) -> dict | None:
    """Decode a callback token -> {"taskName": str} or None."""
    try:
        payload = json.loads(_from_base64_url(token))
        if isinstance(payload, dict) and isinstance(payload.get("t"), str):
            return {"taskName": payload["t"]}
        return None
    except Exception:
        return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# ============================================================================
# ReactiveGraph
# ============================================================================

class ReactiveGraph:
    """
    Push-based, self-sustaining execution wrapper with synchronous handlers.
    """

    def __init__(
        self,
        live: dict,
        handlers: dict[str, Callable],
        on_drain: Callable | None = None,
    ) -> None:
        self._live = live
        self._handlers = dict(handlers)
        self._on_drain = on_drain
        self._disposed = False
        self._input_queue = MemoryJournal()
        self._internal_journal = MemoryJournal()
        self._draining = False
        self._drain_queued = False

    def push(self, event: dict) -> None:
        """Push an event into the graph via journal. Triggers drain."""
        if self._disposed:
            return
        if event.get("type") == "task-completed" and event.get("data") and not event.get("dataHash"):
            event = {**event, "dataHash": compute_data_hash(event["data"])}
        self._input_queue.append(event)
        self._drain()

    def push_all(self, events: list[dict]) -> None:
        """Push multiple events. Single drain cycle after all are journaled."""
        if self._disposed:
            return
        for event in events:
            if event.get("type") == "task-completed" and event.get("data") and not event.get("dataHash"):
                self._input_queue.append({**event, "dataHash": compute_data_hash(event["data"])})
            else:
                self._input_queue.append(event)
        self._drain()

    def resolve_callback(
        self,
        callback_token: str,
        data: dict,
        errors: list[str] | None = None,
    ) -> None:
        """Resolve a callback token — complete (or fail) a task."""
        if self._disposed:
            return

        decoded = _decode_callback_token(callback_token)
        if not decoded:
            return

        task_name = decoded["taskName"]
        if task_name not in self._live["config"].get("tasks", {}):
            return

        if errors and len(errors) > 0:
            self._input_queue.append({
                "type": "task-failed",
                "taskName": task_name,
                "error": "; ".join(errors),
                "timestamp": _now_iso(),
            })
        else:
            data_hash = compute_data_hash(data) if data and len(data) > 0 else None
            self._input_queue.append({
                "type": "task-completed",
                "taskName": task_name,
                "data": data,
                "dataHash": data_hash,
                "timestamp": _now_iso(),
            })
        self._drain()

    def add_node(self, name: str, config: dict) -> None:
        """Add a node to the graph."""
        if self._disposed:
            return
        self._input_queue.append({"type": "task-upsert", "taskName": name, "taskConfig": config, "timestamp": _now_iso()})
        self._drain()

    def remove_node(self, name: str) -> None:
        """Remove a node from the graph."""
        if self._disposed:
            return
        self._input_queue.append({"type": "task-removal", "taskName": name, "timestamp": _now_iso()})
        self._drain()

    def retrigger(self, task_name: str) -> None:
        """Re-trigger a task: journals a task-restart event, then drains."""
        if self._disposed:
            return
        if task_name not in self._live["config"].get("tasks", {}):
            return
        self._input_queue.append({"type": "task-restart", "taskName": task_name, "timestamp": _now_iso()})
        self._drain()

    def snapshot(self) -> dict:
        """Serialize current state to a snapshot."""
        return snapshot(self._live)

    def get_state(self) -> dict:
        """Read-only snapshot of current LiveGraph state."""
        return self._live

    def get_schedule(self) -> dict:
        """Current schedule projection."""
        return schedule(self._live)

    def wait_for_handlers(self) -> None:
        """No-op in sync mode — all handlers complete synchronously."""
        pass

    def dispose(self, **kwargs: Any) -> None:
        """Stop accepting events."""
        self._disposed = True

    # --------------------------------------------------------------------------
    # Core drain cycle
    # --------------------------------------------------------------------------

    def _drain(self) -> None:
        if self._disposed:
            return
        if self._draining:
            self._drain_queued = True
            return

        self._draining = True
        try:
            while True:
                self._drain_queued = False
                self._drain_once()
                if not self._drain_queued:
                    break
        finally:
            self._draining = False

    def _drain_once(self) -> None:
        # 1. Read all pending events
        internal_events = self._internal_journal.drain()
        input_events = self._input_queue.drain()
        events = [*internal_events, *input_events]

        # 2. Apply events atomically
        if events:
            self._live = apply_events(self._live, events)

        # 3. Schedule
        result = schedule(self._live)

        # 4. Observability callback
        if events and self._on_drain:
            self._on_drain(events, self._live, result)

        # 5. Dispatch eligible tasks
        for task_name in result.get("eligible", []):
            self._dispatch_task(task_name)

        # 6. Re-invoke handlers for task-progress events
        for event in events:
            if event.get("type") == "task-progress":
                t_name = event["taskName"]
                task_config = self._live["config"].get("tasks", {}).get(t_name)
                if not task_config:
                    continue
                task_state = self._live["state"].get("tasks", {}).get(t_name)
                if not task_state or task_state.get("status") != "running":
                    continue
                callback_token = _encode_callback_token(t_name)
                try:
                    self._run_pipeline(t_name, callback_token, event.get("update"))
                except Exception as error:
                    if self._disposed:
                        return
                    self._internal_journal.append({
                        "type": "task-failed",
                        "taskName": t_name,
                        "error": str(error),
                        "timestamp": _now_iso(),
                    })
                    self._drain()

    def _resolve_upstream_state(self, task_name: str) -> dict:
        """Resolve upstream state for a task's requires."""
        task_config = self._live["config"].get("tasks", {}).get(task_name, {})
        requires = task_config.get("requires") or []

        token_to_task: dict[str, str] = {}
        for name, cfg in self._live["config"].get("tasks", {}).items():
            for token in cfg.get("provides") or []:
                token_to_task[token] = name

        upstream: dict[str, Any] = {}
        for token in requires:
            producer = token_to_task.get(token)
            if producer:
                upstream[token] = self._live["state"].get("tasks", {}).get(producer, {}).get("data")
            else:
                upstream[token] = None
        return upstream

    def _run_pipeline(self, task_name: str, callback_token: str, update: dict | None = None) -> None:
        """Run the handler pipeline for a task."""
        task_config = self._live["config"].get("tasks", {}).get(task_name, {})
        handler_names = task_config.get("taskHandlers") or []
        upstream_state = self._resolve_upstream_state(task_name)

        for handler_name in handler_names:
            handler = self._handlers.get(handler_name)
            if not handler:
                raise ValueError(f"Handler '{handler_name}' not found in registry (task '{task_name}')")

            handler_input = {
                "nodeId": task_name,
                "state": upstream_state,
                "taskState": self._live["state"].get("tasks", {}).get(task_name, {}),
                "config": task_config,
                "callbackToken": callback_token,
                "update": update,
            }

            status = handler(handler_input)

            if status == "task-initiate-failure":
                raise ValueError(f"Handler '{handler_name}' returned task-initiate-failure (task '{task_name}')")

    def _dispatch_task(self, task_name: str) -> None:
        """Dispatch a single task."""
        task_config = self._live["config"].get("tasks", {}).get(task_name, {})
        handler_names = task_config.get("taskHandlers")

        if not handler_names:
            return

        # Write task-started to internal journal
        self._internal_journal.append({
            "type": "task-started",
            "taskName": task_name,
            "timestamp": _now_iso(),
        })
        self._drain()

        callback_token = _encode_callback_token(task_name)

        try:
            self._run_pipeline(task_name, callback_token)
        except Exception as error:
            if self._disposed:
                return
            self._internal_journal.append({
                "type": "task-failed",
                "taskName": task_name,
                "error": str(error),
                "timestamp": _now_iso(),
            })
            self._drain()


# ============================================================================
# Factory
# ============================================================================

def create_reactive_graph(
    config_or_live: dict,
    options: dict,
    execution_id: str | None = None,
) -> ReactiveGraph:
    """
    Create a reactive graph from either a GraphConfig or an existing LiveGraph.

    options = {
        "handlers": dict[str, Callable],  # named handler registry
        "onDrain": Callable | None,       # observability callback
    }
    """
    handlers = options.get("handlers", {})
    on_drain = options.get("onDrain")

    if "state" in config_or_live and "config" in config_or_live:
        live = config_or_live
    else:
        live = create_live_graph(config_or_live, execution_id)

    return ReactiveGraph(live, handlers, on_drain)
