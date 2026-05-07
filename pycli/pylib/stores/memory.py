"""
yaml-flow - Memory Store

In-memory store implementation. Works in any Python environment.
Data is lost when the process exits - use for testing or short-lived flows.

Port of src/stores/memory.ts
"""
from __future__ import annotations


class MemoryStore:
    """In-memory implementation of the StepMachineStore protocol."""

    def __init__(self) -> None:
        self._runs: dict[str, dict] = {}      # runId -> state dict
        self._data: dict[str, dict] = {}       # runId -> {key: value}

    def save_run_state(self, run_id: str, state: dict) -> None:
        self._runs[run_id] = {**state}

    def load_run_state(self, run_id: str) -> dict | None:
        state = self._runs.get(run_id)
        return {**state} if state is not None else None

    def delete_run_state(self, run_id: str) -> None:
        self._runs.pop(run_id, None)
        self._data.pop(run_id, None)

    def set_data(self, run_id: str, key: str, value: object) -> None:
        if run_id not in self._data:
            self._data[run_id] = {}
        self._data[run_id][key] = value

    def get_data(self, run_id: str, key: str) -> object:
        run_data = self._data.get(run_id)
        if run_data is None:
            return None
        return run_data.get(key)

    def get_all_data(self, run_id: str) -> dict:
        return {**(self._data.get(run_id) or {})}

    def clear_data(self, run_id: str) -> None:
        self._data.pop(run_id, None)

    def list_runs(self) -> list[str]:
        return list(self._runs.keys())

    def clear(self) -> None:
        """Clear all data (useful for testing)."""
        self._runs.clear()
        self._data.clear()
