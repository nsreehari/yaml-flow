"""
Continuous Event Graph — Types

A long-lived, evolving event-graph where both config and state
mutate over time. The single LiveGraph type bundles them.

Port of src/continuous-event-graph/types.ts

LiveGraph = {"config": GraphConfig, "state": ExecutionState}

ScheduleResult = {
    "eligible": list[str],
    "pending": list[{"taskName": str, "waitingOn": list[str]}],
    "unresolved": list[{"taskName": str, "missingTokens": list[str]}],
    "blocked": list[{"taskName": str, "failedTokens": list[str], "failedProducers": list[str]}],
    "conflicts": dict[str, list[str]],
}

LiveGraphSnapshot = {
    "version": int,
    "config": GraphConfig,
    "state": ExecutionState,
    "snapshotAt": str,
}
"""
from __future__ import annotations

# Re-export event-graph types for consumer convenience
from ..event_graph.types import (
    GraphConfig,
    GraphSettings,
    TaskConfig,
    ExecutionState,
    GraphEngineStore,
    ExecutionConfig,
    StuckDetection,
    TASK_STATUS,
    EXECUTION_STATUS,
)
