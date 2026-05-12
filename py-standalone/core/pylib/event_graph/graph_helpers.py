"""
Event Graph — Graph Helpers

Pure functions for manipulating the requires/provides task dependency graph.
No I/O, no side effects.

Port of src/event-graph/graph-helpers.ts
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .types import TASK_STATUS


# ============================================================================
# Accessors — normalize requires/provides to always be lists
# ============================================================================

def get_provides(task: dict | None) -> list[str]:
    if not task:
        return []
    provides = task.get("provides")
    return list(provides) if isinstance(provides, list) else []


def get_requires(task: dict | None) -> list[str]:
    if not task:
        return []
    requires = task.get("requires")
    return list(requires) if isinstance(requires, list) else []


def get_all_tasks(graph: dict) -> dict:
    return graph.get("tasks") or {}


def get_task(graph: dict, task_name: str) -> dict | None:
    return graph.get("tasks", {}).get(task_name)


def has_task(graph: dict, task_name: str) -> bool:
    return task_name in graph.get("tasks", {})


# ============================================================================
# Task State Predicates
# ============================================================================

def is_non_active_task(task_state: dict | None) -> bool:
    if not task_state:
        return False
    return task_state.get("status") in (TASK_STATUS["FAILED"], TASK_STATUS["INACTIVATED"])


def is_task_completed(task_state: dict | None) -> bool:
    if not task_state:
        return False
    return task_state.get("status") == TASK_STATUS["COMPLETED"]


def is_task_running(task_state: dict | None) -> bool:
    if not task_state:
        return False
    return task_state.get("status") == TASK_STATUS["RUNNING"]


def get_refresh_strategy(task_config: dict, graph_settings: dict | None = None) -> str:
    strategy = task_config.get("refreshStrategy")
    if strategy:
        return strategy
    if graph_settings:
        strategy = graph_settings.get("refreshStrategy")
        if strategy:
            return strategy
    return "data-changed"


def is_rerunnable(task_config: dict, graph_settings: dict | None = None) -> bool:
    return get_refresh_strategy(task_config, graph_settings) != "once"


def get_max_executions(task_config: dict) -> int | None:
    return task_config.get("maxExecutions")


# ============================================================================
# Available Outputs Computation
# ============================================================================

def compute_available_outputs(graph: dict, task_states: dict) -> list[str]:
    """
    Dynamically compute available outputs from all completed tasks.
    Pure function.
    """
    outputs: set[str] = set()

    for task_name, task_state in task_states.items():
        if task_state.get("status") == TASK_STATUS["COMPLETED"]:
            task_config = graph.get("tasks", {}).get(task_name)
            if task_config:
                for output in get_provides(task_config):
                    outputs.add(output)

    return list(outputs)


# ============================================================================
# Conflict Detection
# ============================================================================

def group_tasks_by_provides(
    candidate_task_names: list[str],
    tasks: dict,
) -> dict[str, list[str]]:
    """
    Group candidate tasks by the outputs they provide.
    Used to detect conflicts.
    """
    output_groups: dict[str, list[str]] = {}

    for task_name in candidate_task_names:
        task = tasks.get(task_name)
        if not task:
            continue
        for output in get_provides(task):
            if output not in output_groups:
                output_groups[output] = []
            output_groups[output].append(task_name)

    return output_groups


def has_output_conflict(
    task_name: str,
    task_provides: list[str],
    candidates: list[str],
    tasks: dict,
) -> bool:
    """Check if a task's outputs conflict with other candidates."""
    for other_name in candidates:
        if other_name == task_name:
            continue
        other_provides = get_provides(tasks.get(other_name))
        for output in task_provides:
            if output in other_provides:
                return True
    return False


# ============================================================================
# Default state factories
# ============================================================================

def create_default_graph_engine_store() -> dict:
    """Create default task state for a new task."""
    return {
        "status": "not-started",
        "executionCount": 0,
        "retryCount": 0,
        "lastEpoch": 0,
        "messages": [],
        "progress": None,
    }


def create_initial_execution_state(graph: dict, execution_id: str) -> dict:
    """Create the initial execution state for a graph."""
    tasks = {}
    for task_name in graph.get("tasks", {}).keys():
        tasks[task_name] = create_default_graph_engine_store()

    settings = graph.get("settings", {})

    return {
        "status": "running",
        "tasks": tasks,
        "availableOutputs": [],
        "stuckDetection": {
            "is_stuck": False,
            "stuck_description": None,
            "outputs_unresolvable": [],
            "tasks_blocked": [],
        },
        "lastUpdated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        "executionId": execution_id,
        "executionConfig": {
            "executionMode": settings.get("execution_mode", "eligibility-mode"),
            "conflictStrategy": settings.get("conflict_strategy", "alphabetical"),
            "completionStrategy": settings.get("completion", "manual"),
        },
    }
