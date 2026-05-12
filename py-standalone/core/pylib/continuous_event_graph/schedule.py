"""
Continuous Event Graph — Schedule

Pure read-only projection: LiveGraph -> ScheduleResult

Classifies every non-terminal task into one of:
  - eligible: all requires satisfied, ready to dispatch
  - pending: requires not yet met, but a viable producer exists
  - unresolved: requires not met, NO task can produce them
  - blocked: requires not met because the producing task FAILED

Port of src/continuous-event-graph/schedule.ts
"""
from __future__ import annotations

import time
from datetime import datetime, timezone
from typing import Any

from ..event_graph.graph_helpers import (
    get_provides,
    get_requires,
    get_all_tasks,
    is_non_active_task,
    compute_available_outputs,
    get_max_executions,
    get_refresh_strategy,
    group_tasks_by_provides,
)
from ..event_graph.types import TASK_STATUS


def schedule(live: dict) -> dict:
    """
    Compute the scheduling status of every task in the live graph.
    Pure function — no side effects.

    Returns ScheduleResult dict with: eligible, pending, unresolved, blocked, conflicts
    """
    config = live["config"]
    state = live["state"]
    graph_tasks = get_all_tasks(config)
    task_names = list(graph_tasks.keys())

    if not task_names:
        return {"eligible": [], "pending": [], "unresolved": [], "blocked": [], "conflicts": {}}

    # Build producer map
    producer_map = _build_producer_map(graph_tasks)

    # Available outputs: from completed tasks + injected tokens
    computed_outputs = compute_available_outputs(config, state.get("tasks", {}))
    available_outputs = set(computed_outputs) | set(state.get("availableOutputs", []))

    eligible: list[str] = []
    pending: list[dict] = []
    unresolved: list[dict] = []
    blocked: list[dict] = []

    settings = config.get("settings", {})

    for task_name, task_config in graph_tasks.items():
        task_state = state.get("tasks", {}).get(task_name)
        strategy = get_refresh_strategy(task_config, settings)
        rerunnable = strategy != "once"

        # Always skip running or inactive tasks
        if task_state and task_state.get("status") == TASK_STATUS["RUNNING"]:
            continue
        if is_non_active_task(task_state):
            continue

        # Max executions cap
        max_exec = get_max_executions(task_config)
        if max_exec is not None and task_state and task_state.get("executionCount", 0) >= max_exec:
            continue

        # Circuit breaker
        cb = task_config.get("circuit_breaker")
        if cb and task_state and task_state.get("executionCount", 0) >= cb["max_executions"]:
            continue

        # For once-only tasks: skip if completed
        if not rerunnable and task_state and task_state.get("status") == TASK_STATUS["COMPLETED"]:
            continue

        # For re-runnable tasks that already completed: check strategy
        if rerunnable and task_state and task_state.get("status") == TASK_STATUS["COMPLETED"]:
            requires = get_requires(task_config)
            should_skip = False

            if strategy == "data-changed":
                if requires:
                    has_changed = False
                    for req in requires:
                        for other_name, other_config in graph_tasks.items():
                            if req in get_provides(other_config):
                                other_state = state.get("tasks", {}).get(other_name)
                                if not other_state:
                                    continue
                                consumed = (task_state.get("lastConsumedHashes") or {}).get(req)
                                if other_state.get("lastDataHash") is None:
                                    if other_state.get("executionCount", 0) > task_state.get("lastEpoch", 0):
                                        has_changed = True
                                else:
                                    if other_state["lastDataHash"] != consumed:
                                        has_changed = True
                                break
                        if has_changed:
                            break
                    if not has_changed:
                        should_skip = True
                else:
                    should_skip = True

            elif strategy == "epoch-changed":
                if requires:
                    has_refreshed = False
                    for req in requires:
                        for other_name, other_config in graph_tasks.items():
                            if req in get_provides(other_config):
                                other_state = state.get("tasks", {}).get(other_name)
                                if other_state and other_state.get("executionCount", 0) > task_state.get("lastEpoch", 0):
                                    has_refreshed = True
                                break
                        if has_refreshed:
                            break
                    if not has_refreshed:
                        should_skip = True
                else:
                    should_skip = True

            elif strategy == "time-based":
                interval = task_config.get("refreshInterval", 0)
                if interval <= 0:
                    should_skip = True
                else:
                    completed_at = task_state.get("completedAt")
                    if not completed_at:
                        should_skip = True
                    else:
                        try:
                            dt = datetime.fromisoformat(completed_at.replace("Z", "+00:00"))
                            elapsed_sec = (datetime.now(timezone.utc) - dt).total_seconds()
                            if elapsed_sec < interval:
                                should_skip = True
                        except (ValueError, TypeError):
                            should_skip = True

            elif strategy == "manual":
                should_skip = True

            if should_skip:
                continue

        requires = get_requires(task_config)

        # No requires -> eligible (entry point)
        if not requires:
            eligible.append(task_name)
            continue

        # Check each required token
        missing_tokens: list[str] = []
        pending_tokens: list[str] = []
        failed_token_info: list[dict] = []

        for token in requires:
            if token in available_outputs:
                continue

            producers = producer_map.get(token, [])

            if not producers:
                missing_tokens.append(token)
            else:
                all_failed = all(
                    is_non_active_task(state.get("tasks", {}).get(p))
                    for p in producers
                )
                if all_failed:
                    failed_token_info.append({"token": token, "failedProducer": producers[0]})
                else:
                    pending_tokens.append(token)

        if missing_tokens:
            unresolved.append({"taskName": task_name, "missingTokens": missing_tokens})
        elif failed_token_info:
            blocked.append({
                "taskName": task_name,
                "failedTokens": [f["token"] for f in failed_token_info],
                "failedProducers": list(dict.fromkeys(f["failedProducer"] for f in failed_token_info)),
            })
        elif pending_tokens:
            pending.append({"taskName": task_name, "waitingOn": pending_tokens})
        else:
            eligible.append(task_name)

    # Detect conflicts among eligible tasks
    conflicts: dict[str, list[str]] = {}
    if len(eligible) > 1:
        output_groups = group_tasks_by_provides(eligible, graph_tasks)
        for output_key, group_tasks_list in output_groups.items():
            if len(group_tasks_list) > 1:
                conflicts[output_key] = group_tasks_list

    return {
        "eligible": eligible,
        "pending": pending,
        "unresolved": unresolved,
        "blocked": blocked,
        "conflicts": conflicts,
    }


def _build_producer_map(tasks: dict) -> dict[str, list[str]]:
    """Build a map: token -> tasks that produce it (via provides, on, on_failure)."""
    producer_map: dict[str, list[str]] = {}

    for name, config in tasks.items():
        for token in get_provides(config):
            if token not in producer_map:
                producer_map[token] = []
            producer_map[token].append(name)
        if config.get("on"):
            for tokens_list in config["on"].values():
                for token in tokens_list:
                    if token not in producer_map:
                        producer_map[token] = []
                    if name not in producer_map[token]:
                        producer_map[token].append(name)
        if config.get("on_failure"):
            for token in config["on_failure"]:
                if token not in producer_map:
                    producer_map[token] = []
                if name not in producer_map[token]:
                    producer_map[token].append(name)

    return producer_map
