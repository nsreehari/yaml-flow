"""
Continuous Event Graph — Core

All functions are pure: f(LiveGraph, input) -> LiveGraph

Port of src/continuous-event-graph/core.ts
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from ..event_graph.graph_helpers import get_provides, get_requires
from ..event_graph.task_transitions import (
    apply_task_start,
    apply_task_completion,
    apply_task_failure,
    apply_task_progress,
    apply_task_restart,
)


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _create_default_graph_engine_store() -> dict:
    return {
        "status": "not-started",
        "executionCount": 0,
        "retryCount": 0,
        "lastEpoch": 0,
        "messages": [],
        "progress": None,
    }


# ============================================================================
# Create
# ============================================================================

def create_live_graph(config: dict, execution_id: str | None = None) -> dict:
    """
    Create a LiveGraph from a GraphConfig.
    Initialises execution state for all tasks in the config.
    """
    eid = execution_id or f"live-{int(time.time() * 1000)}"
    tasks: dict[str, dict] = {}

    for task_name in config.get("tasks", {}).keys():
        tasks[task_name] = _create_default_graph_engine_store()

    settings = config.get("settings", {})

    state = {
        "status": "running",
        "tasks": tasks,
        "availableOutputs": [],
        "stuckDetection": {
            "is_stuck": False,
            "stuck_description": None,
            "outputs_unresolvable": [],
            "tasks_blocked": [],
        },
        "lastUpdated": _now_iso(),
        "executionId": eid,
        "executionConfig": {
            "executionMode": settings.get("execution_mode", "eligibility-mode"),
            "conflictStrategy": settings.get("conflict_strategy", "alphabetical"),
            "completionStrategy": settings.get("completion", "manual"),
        },
    }

    return {"config": config, "state": state}


# ============================================================================
# Event Reducer
# ============================================================================

def apply_event(live: dict, event: dict) -> dict:
    """
    Apply an event to the LiveGraph, producing a new LiveGraph.
    Pure function: f(LiveGraph, GraphEvent) -> LiveGraph
    """
    config = live["config"]
    state = live["state"]

    # Ghost event filtering
    if "executionId" in event and event.get("executionId") and event["executionId"] != state.get("executionId"):
        return live

    event_type = event.get("type")

    # --- Execution state transitions ---
    if event_type == "task-started":
        return {"config": config, "state": apply_task_start(state, event["taskName"], config)}

    if event_type == "task-completed":
        return {
            "config": config,
            "state": apply_task_completion(
                state, config, event["taskName"],
                event.get("result"), event.get("dataHash"), event.get("data"),
            ),
        }

    if event_type == "task-failed":
        return {"config": config, "state": apply_task_failure(state, config, event["taskName"], event["error"])}

    if event_type == "task-progress":
        return {"config": config, "state": apply_task_progress(state, event["taskName"], event.get("message"), event.get("progress"))}

    if event_type == "task-restart":
        return {"config": config, "state": apply_task_restart(state, event["taskName"])}

    if event_type == "inject-tokens":
        new_outputs = list(dict.fromkeys([*state.get("availableOutputs", []), *event["tokens"]]))
        return {
            "config": config,
            "state": {**state, "availableOutputs": new_outputs, "lastUpdated": _now_iso()},
        }

    if event_type == "agent-action":
        return {"config": config, "state": _apply_agent_action(state, event["action"])}

    # --- Structural mutations ---
    if event_type == "task-upsert":
        return add_node(live, event["taskName"], event["taskConfig"])

    if event_type == "task-removal":
        return remove_node(live, event["taskName"])

    if event_type == "node-requires-add":
        return add_requires(live, event["nodeName"], event["tokens"])

    if event_type == "node-requires-remove":
        return remove_requires(live, event["nodeName"], event["tokens"])

    if event_type == "node-provides-add":
        return add_provides(live, event["nodeName"], event["tokens"])

    if event_type == "node-provides-remove":
        return remove_provides(live, event["nodeName"], event["tokens"])

    return live


def apply_events(live: dict, events: list[dict]) -> dict:
    """
    Apply multiple events atomically to a LiveGraph.
    Events are reduced sequentially.
    """
    current = live
    for event in events:
        current = apply_event(current, event)
    return current


# ============================================================================
# Graph Mutations — node-level
# ============================================================================

def add_node(live: dict, name: str, task_config: dict) -> dict:
    """Upsert a node (task) in the live graph."""
    exists = name in live["config"].get("tasks", {})
    return {
        "config": {
            **live["config"],
            "tasks": {**live["config"].get("tasks", {}), name: task_config},
        },
        "state": {
            **live["state"],
            "tasks": {
                **live["state"].get("tasks", {}),
                name: live["state"]["tasks"][name] if exists else _create_default_graph_engine_store(),
            },
            "lastUpdated": _now_iso(),
        },
    }


def remove_node(live: dict, name: str) -> dict:
    """Remove a node (task) from the live graph."""
    if name not in live["config"].get("tasks", {}):
        return live

    remaining_config = {k: v for k, v in live["config"]["tasks"].items() if k != name}
    remaining_state = {k: v for k, v in live["state"]["tasks"].items() if k != name}

    return {
        "config": {**live["config"], "tasks": remaining_config},
        "state": {**live["state"], "tasks": remaining_state, "lastUpdated": _now_iso()},
    }


# ============================================================================
# Graph Mutations — wiring
# ============================================================================

def add_requires(live: dict, node_name: str, tokens: list[str]) -> dict:
    """Add requires tokens to a node."""
    task = live["config"].get("tasks", {}).get(node_name)
    if not task:
        return live

    current = get_requires(task)
    to_add = [t for t in tokens if t not in current]
    if not to_add:
        return live

    return {
        "config": {
            **live["config"],
            "tasks": {
                **live["config"]["tasks"],
                node_name: {**task, "requires": [*current, *to_add]},
            },
        },
        "state": live["state"],
    }


def remove_requires(live: dict, node_name: str, tokens: list[str]) -> dict:
    """Remove requires tokens from a node."""
    task = live["config"].get("tasks", {}).get(node_name)
    if not task:
        return live

    current = get_requires(task)
    remaining = [t for t in current if t not in tokens]
    if len(remaining) == len(current):
        return live

    return {
        "config": {
            **live["config"],
            "tasks": {
                **live["config"]["tasks"],
                node_name: {**task, "requires": remaining},
            },
        },
        "state": live["state"],
    }


def add_provides(live: dict, node_name: str, tokens: list[str]) -> dict:
    """Add provides tokens to a node."""
    task = live["config"].get("tasks", {}).get(node_name)
    if not task:
        return live

    current = get_provides(task)
    to_add = [t for t in tokens if t not in current]
    if not to_add:
        return live

    return {
        "config": {
            **live["config"],
            "tasks": {
                **live["config"]["tasks"],
                node_name: {**task, "provides": [*current, *to_add]},
            },
        },
        "state": live["state"],
    }


def remove_provides(live: dict, node_name: str, tokens: list[str]) -> dict:
    """Remove provides tokens from a node."""
    task = live["config"].get("tasks", {}).get(node_name)
    if not task:
        return live

    current = get_provides(task)
    remaining = [t for t in current if t not in tokens]
    if len(remaining) == len(current):
        return live

    return {
        "config": {
            **live["config"],
            "tasks": {
                **live["config"]["tasks"],
                node_name: {**task, "provides": remaining},
            },
        },
        "state": live["state"],
    }


# ============================================================================
# Convenience — inject/drain tokens
# ============================================================================

def inject_tokens(live: dict, tokens: list[str]) -> dict:
    """Inject tokens into the live graph's available outputs."""
    return apply_event(live, {
        "type": "inject-tokens",
        "tokens": tokens,
        "timestamp": _now_iso(),
    })


def drain_tokens(live: dict, tokens: list[str]) -> dict:
    """
    Drain (remove) tokens from the live graph's available outputs.
    Tokens that aren't currently available are silently ignored.
    """
    to_remove = set(tokens)
    remaining = [t for t in live["state"].get("availableOutputs", []) if t not in to_remove]

    if len(remaining) == len(live["state"].get("availableOutputs", [])):
        return live

    return {
        "config": live["config"],
        "state": {
            **live["state"],
            "availableOutputs": remaining,
            "lastUpdated": _now_iso(),
        },
    }


# ============================================================================
# Node lifecycle
# ============================================================================

def reset_node(live: dict, name: str) -> dict:
    """Reset a node's state back to not-started."""
    if name not in live["config"].get("tasks", {}) or name not in live["state"].get("tasks", {}):
        return live

    return {
        "config": live["config"],
        "state": {
            **live["state"],
            "tasks": {
                **live["state"]["tasks"],
                name: _create_default_graph_engine_store(),
            },
            "lastUpdated": _now_iso(),
        },
    }


# ============================================================================
# Persistence: snapshot / restore
# ============================================================================

def snapshot(live: dict) -> dict:
    """Serialize a LiveGraph to a plain JSON-safe object."""
    return {
        "version": 1,
        "config": live["config"],
        "state": live["state"],
        "snapshotAt": _now_iso(),
    }


def restore(data: Any) -> dict:
    """Restore a LiveGraph from a snapshot. Validates the shape."""
    if not data or not isinstance(data, dict):
        raise ValueError("Invalid snapshot: expected an object")

    if not data.get("config") or not isinstance(data["config"], dict):
        raise ValueError('Invalid snapshot: missing or invalid "config"')
    if not data.get("state") or not isinstance(data["state"], dict):
        raise ValueError('Invalid snapshot: missing or invalid "state"')

    config = data["config"]
    state = data["state"]

    if not config.get("settings") or not isinstance(config["settings"], dict):
        raise ValueError("Invalid snapshot: config.settings missing")
    if not config.get("tasks") or not isinstance(config.get("tasks"), dict):
        raise ValueError("Invalid snapshot: config.tasks missing")
    if not state.get("tasks") or not isinstance(state.get("tasks"), dict):
        raise ValueError("Invalid snapshot: state.tasks missing")
    if not isinstance(state.get("availableOutputs"), list):
        raise ValueError("Invalid snapshot: state.availableOutputs must be an array")

    return {"config": config, "state": state}


# ============================================================================
# Internals
# ============================================================================

def _apply_agent_action(state: dict, action: str) -> dict:
    now = _now_iso()
    if action == "stop":
        return {**state, "status": "stopped", "lastUpdated": now}
    if action == "pause":
        return {**state, "status": "paused", "lastUpdated": now}
    if action == "resume":
        return {**state, "status": "running", "lastUpdated": now}
    return state
