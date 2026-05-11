"""
Step Machine Types

All type definitions for the step-machine workflow engine.
The step machine is a stateful sequential executor:
  currentState + stepResult -> newState (via transitions)

Port of src/step-machine/types.ts
"""
from __future__ import annotations

from typing import Any, Callable, List, Optional, TypedDict


# ============================================================================
# Flow Configuration Types (YAML structure)
# ============================================================================

class RetryConfig(TypedDict, total=False):
    max_attempts: int
    delay_ms: int
    backoff_multiplier: float


class CircuitBreakerConfig(TypedDict):
    max_iterations: int
    on_open: str


class StepConfig(TypedDict, total=False):
    description: str
    expects_data: list[str]
    produces_data: list[str]
    transitions: dict[str, str]
    failure_transitions: dict[str, str]
    retry: RetryConfig
    circuit_breaker: CircuitBreakerConfig


class StepFlowSettings(TypedDict, total=False):
    start_step: str
    max_total_steps: int
    timeout_ms: int


class TerminalStateConfig(TypedDict, total=False):
    description: str
    return_intent: str
    return_artifacts: Any  # str | list[str] | False | None
    expects_data: list[str]


class StepFlowConfig(TypedDict, total=False):
    id: str
    settings: StepFlowSettings
    steps: dict[str, StepConfig]
    terminal_states: dict[str, TerminalStateConfig]


# ============================================================================
# Runtime Types
# ============================================================================

class StepResult(TypedDict, total=False):
    result: str
    data: dict[str, Any]


# ============================================================================
# State Types
# ============================================================================

class StepMachineState(TypedDict, total=False):
    runId: str
    flowId: str
    currentStep: str
    status: str  # 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'
    stepHistory: list[str]
    iterationCounts: dict[str, int]
    retryCounts: dict[str, int]
    startedAt: int
    updatedAt: int
    pausedAt: int


# ============================================================================
# Reducer Types — pure: state + stepResult -> newState
# ============================================================================

class StepReducerResult(TypedDict):
    newState: StepMachineState
    nextStep: str
    isTerminal: bool
    isCircuitBroken: bool
    shouldRetry: bool


# ============================================================================
# Engine Types
# ============================================================================

class StepMachineOptions(TypedDict, total=False):
    store: Any  # StepMachineStore
    components: dict[str, Any]
    onStep: Callable  # (stepName: str, result: StepResult) -> None
    onTransition: Callable  # (from_step: str, to_step: str) -> None
    onComplete: Callable  # (result: StepMachineResult) -> None
    onError: Callable  # (error: Exception) -> None


class StepMachineResult(TypedDict, total=False):
    runId: str
    status: str  # 'completed' | 'failed' | 'cancelled' | 'timeout' | 'max_iterations'
    intent: str
    data: dict[str, Any]
    finalStep: str
    stepHistory: list[str]
    durationMs: int
    error: Exception


# ============================================================================
# Event Types
# ============================================================================

STEP_EVENT_TYPES = [
    'flow:start',
    'flow:complete',
    'flow:error',
    'flow:paused',
    'flow:resumed',
    'step:start',
    'step:complete',
    'step:error',
    'transition',
]


class StepEvent(TypedDict, total=False):
    type: str
    runId: str
    timestamp: int
    data: dict[str, Any]
