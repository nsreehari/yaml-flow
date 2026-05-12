"""
Step Machine — Convenience Driver Class

Wraps the pure reducer with a run loop and store I/O.
This is the framework layer. The reducer is the pure core.

Port of src/step-machine/StepMachine.ts
"""
from __future__ import annotations

import time
import uuid
from typing import Any, Callable

from .reducer import (
    apply_step_result,
    check_circuit_breaker,
    compute_step_input,
    create_initial_state,
    extract_return_data,
)
from ..stores.memory import MemoryStore


def _time_ms() -> int:
    return int(time.time() * 1000)


def _generate_run_id() -> str:
    return uuid.uuid4().hex


class StepMachine:
    """
    Step Machine — drives a step flow by executing handlers and applying
    reducer transitions.
    """

    def __init__(
        self,
        flow: dict,
        handlers: dict[str, Callable],
        options: dict | None = None,
    ) -> None:
        self._flow = flow
        self._handlers: dict[str, Callable] = dict(handlers)
        self._options = options or {}
        self._store = self._options.get("store") or MemoryStore()
        self._components: dict[str, Any] = self._options.get("components", {})
        self._listeners: dict[str, set] = {}
        self._aborted = False

        self._validate_flow()

    def _validate_flow(self) -> None:
        settings = self._flow.get("settings", {})
        steps = self._flow.get("steps", {})
        terminal_states = self._flow.get("terminal_states", {})

        if not settings.get("start_step"):
            raise ValueError("Flow must have settings.start_step defined")
        if not steps:
            raise ValueError("Flow must have at least one step defined")
        if not terminal_states:
            raise ValueError("Flow must have at least one terminal_state defined")
        start = settings["start_step"]
        if start not in steps and start not in terminal_states:
            raise ValueError(f'Start step "{start}" not found')

        for step_name, step_config in steps.items():
            for result_key, target in step_config.get("transitions", {}).items():
                if target not in steps and target not in terminal_states:
                    raise ValueError(
                        f'Step "{step_name}" transition "{result_key}" points to unknown step "{target}"'
                    )
            for result_key, target in (step_config.get("failure_transitions") or {}).items():
                if target not in steps and target not in terminal_states:
                    raise ValueError(
                        f'Step "{step_name}" failure_transition "{result_key}" points to unknown step "{target}"'
                    )

    def on(self, event_type: str, listener: Callable) -> None:
        if event_type not in self._listeners:
            self._listeners[event_type] = set()
        self._listeners[event_type].add(listener)

    def off(self, event_type: str, listener: Callable) -> None:
        listeners = self._listeners.get(event_type)
        if listeners:
            listeners.discard(listener)

    def _emit(self, event: dict) -> None:
        listeners = self._listeners.get(event.get("type", ""))
        if listeners:
            for listener in list(listeners):
                try:
                    listener(event)
                except Exception:
                    pass  # swallow listener errors

    def run(self, initial_data: dict | None = None) -> dict:
        """Run the step machine from the beginning."""
        run_id = _generate_run_id()
        run_state = create_initial_state(self._flow, run_id)

        self._store.save_run_state(run_id, run_state)

        if initial_data:
            for key, value in initial_data.items():
                self._store.set_data(run_id, key, value)

        self._emit({
            "type": "flow:start",
            "runId": run_id,
            "timestamp": run_state["startedAt"],
            "data": {"initialData": initial_data or {}},
        })

        try:
            return self._execute_loop(run_id, run_state)
        except Exception as error:
            self._emit({
                "type": "flow:error",
                "runId": run_id,
                "timestamp": _time_ms(),
                "data": {"error": str(error)},
            })
            on_error = self._options.get("onError")
            if on_error:
                on_error(error)

            run_state = {**run_state, "status": "failed", "updatedAt": _time_ms()}
            self._store.save_run_state(run_id, run_state)

            return {
                "runId": run_id,
                "status": "failed",
                "data": self._store.get_all_data(run_id),
                "finalStep": run_state["currentStep"],
                "stepHistory": run_state["stepHistory"],
                "durationMs": _time_ms() - run_state["startedAt"],
                "error": error,
            }

    def resume(self, run_id: str) -> dict:
        """Resume a paused run."""
        run_state = self._store.load_run_state(run_id)
        if not run_state:
            raise ValueError(f"No run found with ID: {run_id}")
        if run_state["status"] in ("completed", "failed"):
            raise ValueError(f"Cannot resume a {run_state['status']} run")

        updated = {
            **run_state,
            "status": "running",
            "updatedAt": _time_ms(),
        }
        updated.pop("pausedAt", None)
        self._store.save_run_state(run_id, updated)
        self._emit({
            "type": "flow:resumed",
            "runId": run_id,
            "timestamp": _time_ms(),
            "data": {"currentStep": updated["currentStep"]},
        })
        return self._execute_loop(run_id, updated)

    def pause(self, run_id: str) -> None:
        """Pause a running run."""
        run_state = self._store.load_run_state(run_id)
        if not run_state:
            raise ValueError(f"No run found with ID: {run_id}")

        updated = {
            **run_state,
            "status": "paused",
            "pausedAt": _time_ms(),
            "updatedAt": _time_ms(),
        }
        self._store.save_run_state(run_id, updated)
        self._emit({
            "type": "flow:paused",
            "runId": run_id,
            "timestamp": _time_ms(),
            "data": {"currentStep": updated["currentStep"]},
        })

    def _execute_loop(self, run_id: str, run_state: dict) -> dict:
        max_steps = self._flow.get("settings", {}).get("max_total_steps", 100)
        timeout_ms = self._flow.get("settings", {}).get("timeout_ms")
        current = run_state
        iterations = 0

        while iterations < max_steps:
            # Check abort
            if self._aborted:
                current = {**current, "status": "cancelled", "updatedAt": _time_ms()}
                self._store.save_run_state(run_id, current)
                return {
                    "runId": run_id,
                    "status": "cancelled",
                    "data": self._store.get_all_data(run_id),
                    "finalStep": current["currentStep"],
                    "stepHistory": current["stepHistory"],
                    "durationMs": _time_ms() - current["startedAt"],
                }

            # Check timeout
            if timeout_ms and _time_ms() - current["startedAt"] > timeout_ms:
                current = {**current, "status": "completed", "updatedAt": _time_ms()}
                self._store.save_run_state(run_id, current)
                return {
                    "runId": run_id,
                    "status": "timeout",
                    "intent": "timeout",
                    "data": self._store.get_all_data(run_id),
                    "finalStep": current["currentStep"],
                    "stepHistory": current["stepHistory"],
                    "durationMs": _time_ms() - current["startedAt"],
                }

            step_name = current["currentStep"]

            # Terminal state check
            terminal_state = self._flow.get("terminal_states", {}).get(step_name)
            if terminal_state is not None:
                current = {**current, "status": "completed", "updatedAt": _time_ms()}
                self._store.save_run_state(run_id, current)
                all_data = self._store.get_all_data(run_id)
                result = {
                    "runId": run_id,
                    "status": "completed",
                    "intent": terminal_state.get("return_intent"),
                    "data": extract_return_data(
                        terminal_state.get("return_artifacts"), all_data
                    ),
                    "finalStep": step_name,
                    "stepHistory": current["stepHistory"],
                    "durationMs": _time_ms() - current["startedAt"],
                }
                self._emit({
                    "type": "flow:complete",
                    "runId": run_id,
                    "timestamp": _time_ms(),
                    "data": {**result},
                })
                on_complete = self._options.get("onComplete")
                if on_complete:
                    on_complete(result)
                return result

            # Circuit breaker (pure)
            cb_result = check_circuit_breaker(self._flow, current, step_name)
            if cb_result["broken"]:
                current = cb_result["newState"]
                self._store.save_run_state(run_id, current)
                iterations += 1
                continue
            current = cb_result["newState"]

            # Execute step handler
            all_data = self._store.get_all_data(run_id)
            step_input = compute_step_input(self._flow, step_name, all_data)
            context = {
                "runId": run_id,
                "stepName": step_name,
                "components": self._components,
                "store": self._store,
            }

            self._emit({
                "type": "step:start",
                "runId": run_id,
                "timestamp": _time_ms(),
                "data": {"step": step_name, "input": step_input},
            })

            try:
                handler = self._handlers.get(step_name)
                if not handler:
                    raise ValueError(f'No handler registered for step "{step_name}"')
                step_result = handler(step_input, context)
            except Exception as error:
                self._emit({
                    "type": "step:error",
                    "runId": run_id,
                    "timestamp": _time_ms(),
                    "data": {"step": step_name, "error": str(error)},
                })
                step_result = {"result": "failure", "data": {"error": str(error)}}

            # Store produced data
            if step_result.get("data"):
                for key, value in step_result["data"].items():
                    self._store.set_data(run_id, key, value)

            self._emit({
                "type": "step:complete",
                "runId": run_id,
                "timestamp": _time_ms(),
                "data": {"step": step_name, "result": step_result.get("result")},
            })
            on_step = self._options.get("onStep")
            if on_step:
                on_step(step_name, step_result)

            # Apply step result (pure reducer)
            reducer_result = apply_step_result(
                self._flow, current, step_name, step_result
            )
            current = reducer_result["newState"]

            if reducer_result["shouldRetry"]:
                self._store.save_run_state(run_id, current)
                step_config = self._flow["steps"][step_name]
                retry_cfg = step_config.get("retry", {})
                delay_ms = retry_cfg.get("delay_ms")
                if delay_ms:
                    retry_count = current.get("retryCounts", {}).get(step_name, 0)
                    backoff = retry_cfg.get("backoff_multiplier")
                    if backoff:
                        actual_delay = delay_ms * (backoff ** (retry_count - 1))
                    else:
                        actual_delay = delay_ms
                    time.sleep(actual_delay / 1000.0)
                iterations += 1
                continue

            self._store.save_run_state(run_id, current)
            self._emit({
                "type": "transition",
                "runId": run_id,
                "timestamp": _time_ms(),
                "data": {
                    "from": step_name,
                    "to": current["currentStep"],
                    "result": step_result.get("result"),
                },
            })
            on_transition = self._options.get("onTransition")
            if on_transition:
                on_transition(step_name, current["currentStep"])
            iterations += 1

        # Max iterations reached
        current = {**current, "status": "completed", "updatedAt": _time_ms()}
        self._store.save_run_state(run_id, current)
        return {
            "runId": run_id,
            "status": "max_iterations",
            "intent": "max_iterations",
            "data": self._store.get_all_data(run_id),
            "finalStep": current["currentStep"],
            "stepHistory": current["stepHistory"],
            "durationMs": _time_ms() - current["startedAt"],
        }


def create_step_machine(
    flow: dict,
    handlers: dict[str, Callable],
    options: dict | None = None,
) -> StepMachine:
    """Convenience factory."""
    return StepMachine(flow, handlers, options)
