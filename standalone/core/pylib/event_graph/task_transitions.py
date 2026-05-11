"""
Event Graph — Task State Transitions

Pure functions for applying task lifecycle events to execution state.
Each function: f(state, ...) -> newState

Port of src/event-graph/task-transitions.ts
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .graph_helpers import get_provides, get_requires


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


def apply_task_start(state: dict, task_name: str, graph: dict | None = None) -> dict:
    """Apply task start to execution state. Pure function."""
    existing_task = state.get("tasks", {}).get(task_name) or _create_default_graph_engine_store()

    # Snapshot upstream hashes at start time
    start_consumed_hashes: dict[str, str] = {}
    if graph:
        task_config = graph.get("tasks", {}).get(task_name)
        requires = get_requires(task_config)
        for token in requires:
            for other_name, other_config in graph.get("tasks", {}).items():
                if token in get_provides(other_config):
                    other_state = state.get("tasks", {}).get(other_name)
                    if other_state and other_state.get("lastDataHash"):
                        start_consumed_hashes[token] = other_state["lastDataHash"]
                    break

    now = _now_iso()
    updated_task = {
        **existing_task,
        "status": "running",
        "startedAt": now,
        "lastUpdated": now,
        "progress": 0,
        "startConsumedHashes": start_consumed_hashes,
    }
    updated_task.pop("error", None)

    return {
        **state,
        "tasks": {**state.get("tasks", {}), task_name: updated_task},
        "lastUpdated": now,
    }


def apply_task_completion(
    state: dict,
    graph: dict,
    task_name: str,
    result: str | None = None,
    data_hash: str | None = None,
    data: dict | None = None,
) -> dict:
    """
    Apply task completion to execution state.
    Handles: default provides, conditional provides (on), refresh strategy, data hash tracking.
    Pure function.
    """
    existing_task = state.get("tasks", {}).get(task_name) or _create_default_graph_engine_store()
    task_config = graph.get("tasks", {}).get(task_name)
    if not task_config:
        raise ValueError(f'Task "{task_name}" not found in graph')

    # Determine which outputs to produce
    if result and task_config.get("on") and task_config["on"].get(result):
        output_tokens = task_config["on"][result]
    else:
        output_tokens = get_provides(task_config)

    # Use hashes snapshotted at task-start time as lastConsumedHashes
    if existing_task.get("startConsumedHashes"):
        last_consumed_hashes = {**existing_task["startConsumedHashes"]}
    else:
        last_consumed_hashes = {**(existing_task.get("lastConsumedHashes") or {})}
        # Legacy fallback: populate from current upstream state
        requires = task_config.get("requires") or []
        for token in requires:
            for other_name, other_config in graph.get("tasks", {}).items():
                if token in get_provides(other_config):
                    other_state = state.get("tasks", {}).get(other_name)
                    if other_state and other_state.get("lastDataHash"):
                        last_consumed_hashes[token] = other_state["lastDataHash"]
                    break

    now = _now_iso()
    execution_count = existing_task.get("executionCount", 0) + 1
    updated_task = {
        **existing_task,
        "status": "completed",
        "completedAt": now,
        "lastUpdated": now,
        "executionCount": execution_count,
        "lastEpoch": execution_count,
        "lastDataHash": data_hash,
        "data": data,
        "lastConsumedHashes": last_consumed_hashes,
    }
    updated_task.pop("error", None)

    # Merge new outputs with existing
    new_outputs = list(dict.fromkeys([*state.get("availableOutputs", []), *output_tokens]))

    return {
        **state,
        "tasks": {**state.get("tasks", {}), task_name: updated_task},
        "availableOutputs": new_outputs,
        "lastUpdated": now,
    }


def apply_task_failure(
    state: dict,
    graph: dict,
    task_name: str,
    error: str,
) -> dict:
    """
    Apply task failure to execution state.
    Handles: retry logic, on_failure token injection, circuit breaker.
    Pure function.
    """
    existing_task = state.get("tasks", {}).get(task_name) or _create_default_graph_engine_store()
    task_config = graph.get("tasks", {}).get(task_name)

    # Check retry
    if task_config and task_config.get("retry"):
        retry_count = existing_task.get("retryCount", 0) + 1
        if retry_count <= task_config["retry"]["max_attempts"]:
            now = _now_iso()
            updated_task = {
                **existing_task,
                "status": "not-started",
                "retryCount": retry_count,
                "lastUpdated": now,
                "error": error,
            }
            return {
                **state,
                "tasks": {**state.get("tasks", {}), task_name: updated_task},
                "lastUpdated": now,
            }

    # No more retries — mark as failed
    now = _now_iso()
    updated_task = {
        **existing_task,
        "status": "failed",
        "failedAt": now,
        "lastUpdated": now,
        "error": error,
        "executionCount": existing_task.get("executionCount", 0) + 1,
    }

    # Inject failure tokens if configured
    new_outputs = list(state.get("availableOutputs", []))
    if task_config and task_config.get("on_failure"):
        for token in task_config["on_failure"]:
            if token not in new_outputs:
                new_outputs.append(token)

    # Check circuit breaker
    if (
        task_config
        and task_config.get("circuit_breaker")
        and updated_task["executionCount"] >= task_config["circuit_breaker"]["max_executions"]
    ):
        for token in task_config["circuit_breaker"].get("on_break", []):
            if token not in new_outputs:
                new_outputs.append(token)

    return {
        **state,
        "tasks": {**state.get("tasks", {}), task_name: updated_task},
        "availableOutputs": new_outputs,
        "lastUpdated": now,
    }


def apply_task_progress(
    state: dict,
    task_name: str,
    message: str | None = None,
    progress: float | None = None,
) -> dict:
    """Apply task progress update. Pure function."""
    existing_task = state.get("tasks", {}).get(task_name) or _create_default_graph_engine_store()
    now = _now_iso()

    messages = list(existing_task.get("messages") or [])
    if message:
        messages.append({
            "message": message,
            "timestamp": now,
            "status": existing_task.get("status", "not-started"),
        })

    updated_task = {
        **existing_task,
        "progress": progress if isinstance(progress, (int, float)) else existing_task.get("progress"),
        "messages": messages,
        "lastUpdated": now,
    }

    return {
        **state,
        "tasks": {**state.get("tasks", {}), task_name: updated_task},
        "lastUpdated": now,
    }


def apply_task_restart(state: dict, task_name: str) -> dict:
    """
    Apply task restart to execution state.
    Resets the task to not-started, preserving executionCount and lastEpoch.
    Pure function.
    """
    existing_task = state.get("tasks", {}).get(task_name)
    if not existing_task:
        return state

    now = _now_iso()
    updated_task = {
        **existing_task,
        "status": "not-started",
        "lastUpdated": now,
        "progress": None,
    }
    # Clear volatile fields
    updated_task.pop("startedAt", None)
    updated_task.pop("completedAt", None)
    updated_task.pop("failedAt", None)
    updated_task.pop("error", None)
    updated_task.pop("data", None)

    return {
        **state,
        "tasks": {**state.get("tasks", {}), task_name: updated_task},
        "lastUpdated": now,
    }
