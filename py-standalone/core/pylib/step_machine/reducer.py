"""
Step Machine Reducer — Pure Functions

currentState + stepResult -> newState
No I/O, no side effects, deterministic.

Port of src/step-machine/reducer.ts
"""
from __future__ import annotations

import time
from typing import Any


def _time_ms() -> int:
    return int(time.time() * 1000)


def apply_step_result(
    flow: dict,
    state: dict,
    step_name: str,
    step_result: dict,
) -> dict:
    """
    Apply a step result to the current state and compute the next state.
    Pure function: no side effects.
    """
    step_config = flow.get("steps", {}).get(step_name)
    if step_config is None:
        raise ValueError(f'Step "{step_name}" not found in flow configuration')

    # Check retry
    if step_result.get("result") == "failure" and step_config.get("retry"):
        retry_count = state.get("retryCounts", {}).get(step_name, 0)
        if retry_count < step_config["retry"]["max_attempts"]:
            return {
                "newState": {
                    **state,
                    "retryCounts": {
                        **state.get("retryCounts", {}),
                        step_name: retry_count + 1,
                    },
                    "updatedAt": _time_ms(),
                },
                "nextStep": step_name,
                "isTerminal": False,
                "isCircuitBroken": False,
                "shouldRetry": True,
            }

    # Find transition. Failure transitions are explicit error-path overrides.
    failure_transitions = step_config.get("failure_transitions") or {}
    transitions = step_config.get("transitions", {})
    result_key = step_result.get("result", "")

    next_step = failure_transitions.get(result_key) or transitions.get(result_key)
    if next_step is None:
        raise ValueError(
            f'No transition defined for result "{result_key}" in step "{step_name}"'
        )

    # Check if next is terminal
    is_terminal = next_step in flow.get("terminal_states", {})

    return {
        "newState": {
            **state,
            "currentStep": next_step,
            "stepHistory": [*state.get("stepHistory", []), step_name],
            "retryCounts": {
                **state.get("retryCounts", {}),
                step_name: 0,
            },
            "updatedAt": _time_ms(),
        },
        "nextStep": next_step,
        "isTerminal": is_terminal,
        "isCircuitBroken": False,
        "shouldRetry": False,
    }


def check_circuit_breaker(
    flow: dict,
    state: dict,
    step_name: str,
) -> dict:
    """
    Check circuit breaker for a step. Returns the redirected step if broken.
    Pure function.
    """
    step_config = flow.get("steps", {}).get(step_name)
    cb = step_config.get("circuit_breaker") if step_config else None

    if not cb:
        return {
            "broken": False,
            "newState": {
                **state,
                "iterationCounts": {
                    **state.get("iterationCounts", {}),
                    step_name: state.get("iterationCounts", {}).get(step_name, 0) + 1,
                },
                "updatedAt": _time_ms(),
            },
        }

    count = state.get("iterationCounts", {}).get(step_name, 0)
    if count >= cb["max_iterations"]:
        return {
            "broken": True,
            "redirectStep": cb["on_open"],
            "newState": {
                **state,
                "currentStep": cb["on_open"],
                "updatedAt": _time_ms(),
            },
        }

    return {
        "broken": False,
        "newState": {
            **state,
            "iterationCounts": {
                **state.get("iterationCounts", {}),
                step_name: count + 1,
            },
            "updatedAt": _time_ms(),
        },
    }


def compute_step_input(
    flow: dict,
    step_name: str,
    all_data: dict,
) -> dict:
    """
    Compute what a step needs as input. Pure function.
    """
    step_config = flow.get("steps", {}).get(step_name)
    if step_config is None:
        raise ValueError(f'Step "{step_name}" not found')

    expects_data = step_config.get("expects_data")
    if expects_data:
        return {key: all_data.get(key) for key in expects_data}

    # If no expects_data, pass all data
    return {**all_data}


def extract_return_data(
    return_artifacts: Any,
    all_data: dict,
) -> dict:
    """
    Extract return data from terminal state. Pure function.
    """
    if return_artifacts is False or return_artifacts is None:
        return {}

    if isinstance(return_artifacts, str):
        return {return_artifacts: all_data.get(return_artifacts)}

    if isinstance(return_artifacts, list):
        return {key: all_data.get(key) for key in return_artifacts}

    return {}


def create_initial_state(flow: dict, run_id: str) -> dict:
    """
    Create initial state for a new run. Pure function.
    """
    now = _time_ms()
    return {
        "runId": run_id,
        "flowId": flow.get("id", "unnamed"),
        "currentStep": flow["settings"]["start_step"],
        "status": "running",
        "stepHistory": [],
        "iterationCounts": {},
        "retryCounts": {},
        "startedAt": now,
        "updatedAt": now,
    }
