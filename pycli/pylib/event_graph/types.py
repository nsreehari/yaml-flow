"""
Event Graph — Core Types and Constants

Type definitions for the stateless event-graph engine.
Pure: f(state, event) -> newState

Port of src/event-graph/types.ts and src/event-graph/constants.ts
"""
from __future__ import annotations

from typing import Any, TypedDict


# ============================================================================
# Constants
# ============================================================================

TASK_STATUS = {
    "NOT_STARTED": "not-started",
    "RUNNING": "running",
    "COMPLETED": "completed",
    "FAILED": "failed",
    "INACTIVATED": "inactivated",
}

EXECUTION_STATUS = {
    "CREATED": "created",
    "RUNNING": "running",
    "PAUSED": "paused",
    "STOPPED": "stopped",
    "COMPLETED": "completed",
    "FAILED": "failed",
}

COMPLETION_STRATEGIES = {
    "ALL_TASKS_DONE": "all-tasks-done",
    "ALL_OUTPUTS_DONE": "all-outputs-done",
    "ONLY_RESOLVED": "only-resolved",
    "GOAL_REACHED": "goal-reached",
    "MANUAL": "manual",
}

EXECUTION_MODES = {
    "DEPENDENCY_MODE": "dependency-mode",
    "ELIGIBILITY_MODE": "eligibility-mode",
}

CONFLICT_STRATEGIES = {
    "ALPHABETICAL": "alphabetical",
    "PRIORITY_FIRST": "priority-first",
    "DURATION_FIRST": "duration-first",
    "COST_OPTIMIZED": "cost-optimized",
    "RESOURCE_AWARE": "resource-aware",
    "RANDOM_SELECT": "random-select",
    "USER_CHOICE": "user-choice",
    "PARALLEL_ALL": "parallel-all",
    "SKIP_CONFLICTS": "skip-conflicts",
    "ROUND_ROBIN": "round-robin",
}


# ============================================================================
# Graph Configuration Types (YAML structure)
# ============================================================================

class TaskRetryConfig(TypedDict, total=False):
    max_attempts: int
    delay_ms: int
    backoff_multiplier: float


class TaskCircuitBreakerConfig(TypedDict):
    max_executions: int
    on_break: list[str]


class TaskConfig(TypedDict, total=False):
    requires: list[str]
    provides: list[str]
    on: dict[str, list[str]]
    on_failure: list[str]
    method: str
    taskHandlers: list[str]
    config: dict[str, Any]
    priority: int
    estimatedDuration: int
    estimatedCost: float
    estimatedResources: dict[str, float]
    retry: TaskRetryConfig
    refreshStrategy: str
    refreshInterval: int
    maxExecutions: int
    circuit_breaker: TaskCircuitBreakerConfig
    description: str
    inference: dict[str, Any]


class GraphSettings(TypedDict, total=False):
    completion: str
    conflict_strategy: str
    execution_mode: str
    refreshStrategy: str
    goal: list[str]
    max_iterations: int
    timeout_ms: int


class GraphConfig(TypedDict, total=False):
    id: str
    settings: GraphSettings
    tasks: dict[str, TaskConfig]


# ============================================================================
# Execution State
# ============================================================================

class TaskMessage(TypedDict):
    message: str
    timestamp: str
    status: str


class GraphEngineStore(TypedDict, total=False):
    status: str
    executionCount: int
    retryCount: int
    lastEpoch: int
    lastDataHash: str
    data: dict[str, Any]
    lastConsumedHashes: dict[str, str]
    startConsumedHashes: dict[str, str]
    startedAt: str
    completedAt: str
    failedAt: str
    lastUpdated: str
    error: str
    messages: list[TaskMessage]
    progress: float | None


class StuckDetection(TypedDict):
    is_stuck: bool
    stuck_description: str | None
    outputs_unresolvable: list[str]
    tasks_blocked: list[str]


class ExecutionConfig(TypedDict):
    executionMode: str
    conflictStrategy: str
    completionStrategy: str


class ExecutionState(TypedDict, total=False):
    status: str
    tasks: dict[str, GraphEngineStore]
    availableOutputs: list[str]
    stuckDetection: StuckDetection
    lastUpdated: str
    executionId: str | None
    executionConfig: ExecutionConfig


# ============================================================================
# Event Types — string literal constants
# ============================================================================

EVENT_TYPES = [
    "task-started",
    "task-completed",
    "task-failed",
    "task-progress",
    "task-restart",
    "inject-tokens",
    "agent-action",
    "task-upsert",
    "task-removal",
    "node-requires-add",
    "node-requires-remove",
    "node-provides-add",
    "node-provides-remove",
]
