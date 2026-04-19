/**
 * Step Machine Reducer — Pure Functions
 *
 * currentState + stepResult → newState
 * No I/O, no side effects, deterministic.
 */

import type {
  StepFlowConfig,
  StepMachineState,
  StepResult,
  StepReducerResult,
} from './types.js';

/**
 * Apply a step result to the current state and compute the next state.
 * Pure function: no side effects.
 */
export function applyStepResult(
  flow: StepFlowConfig,
  state: StepMachineState,
  stepName: string,
  stepResult: StepResult
): StepReducerResult {
  const stepConfig = flow.steps[stepName];

  if (!stepConfig) {
    throw new Error(`Step "${stepName}" not found in flow configuration`);
  }

  // Check retry
  if (stepResult.result === 'failure' && stepConfig.retry) {
    const retryCount = state.retryCounts[stepName] ?? 0;
    if (retryCount < stepConfig.retry.max_attempts) {
      return {
        newState: {
          ...state,
          retryCounts: {
            ...state.retryCounts,
            [stepName]: retryCount + 1,
          },
          updatedAt: Date.now(),
        },
        nextStep: stepName,
        isTerminal: false,
        isCircuitBroken: false,
        shouldRetry: true,
      };
    }
  }

  // Find transition. Failure transitions are explicit error-path overrides.
  const nextStep =
    stepConfig.failure_transitions?.[stepResult.result] ??
    stepConfig.transitions[stepResult.result];
  if (!nextStep) {
    throw new Error(
      `No transition defined for result "${stepResult.result}" in step "${stepName}"`
    );
  }

  // Check if next is terminal
  const isTerminal = !!flow.terminal_states[nextStep];

  return {
    newState: {
      ...state,
      currentStep: nextStep,
      stepHistory: [...state.stepHistory, stepName],
      retryCounts: {
        ...state.retryCounts,
        [stepName]: 0,
      },
      updatedAt: Date.now(),
    },
    nextStep,
    isTerminal,
    isCircuitBroken: false,
    shouldRetry: false,
  };
}

/**
 * Check circuit breaker for a step. Returns the redirected step if broken.
 * Pure function.
 */
export function checkCircuitBreaker(
  flow: StepFlowConfig,
  state: StepMachineState,
  stepName: string
): { broken: boolean; redirectStep?: string; newState: StepMachineState } {
  const stepConfig = flow.steps[stepName];
  if (!stepConfig?.circuit_breaker) {
    return {
      broken: false,
      newState: {
        ...state,
        iterationCounts: {
          ...state.iterationCounts,
          [stepName]: (state.iterationCounts[stepName] ?? 0) + 1,
        },
        updatedAt: Date.now(),
      },
    };
  }

  const count = state.iterationCounts[stepName] ?? 0;
  if (count >= stepConfig.circuit_breaker.max_iterations) {
    return {
      broken: true,
      redirectStep: stepConfig.circuit_breaker.on_open,
      newState: {
        ...state,
        currentStep: stepConfig.circuit_breaker.on_open,
        updatedAt: Date.now(),
      },
    };
  }

  return {
    broken: false,
    newState: {
      ...state,
      iterationCounts: {
        ...state.iterationCounts,
        [stepName]: count + 1,
      },
      updatedAt: Date.now(),
    },
  };
}

/**
 * Compute what a step needs as input. Pure function.
 */
export function computeStepInput(
  flow: StepFlowConfig,
  stepName: string,
  allData: Record<string, unknown>
): Record<string, unknown> {
  const stepConfig = flow.steps[stepName];
  if (!stepConfig) {
    throw new Error(`Step "${stepName}" not found`);
  }

  if (stepConfig.expects_data) {
    const input: Record<string, unknown> = {};
    for (const key of stepConfig.expects_data) {
      input[key] = allData[key];
    }
    return input;
  }

  // If no expects_data, pass all data
  return { ...allData };
}

/**
 * Extract return data from terminal state. Pure function.
 */
export function extractReturnData(
  returnArtifacts: string | string[] | false | undefined,
  allData: Record<string, unknown>
): Record<string, unknown> {
  if (returnArtifacts === false || returnArtifacts === undefined) {
    return {};
  }

  if (typeof returnArtifacts === 'string') {
    return { [returnArtifacts]: allData[returnArtifacts] };
  }

  if (Array.isArray(returnArtifacts)) {
    const result: Record<string, unknown> = {};
    for (const key of returnArtifacts) {
      result[key] = allData[key];
    }
    return result;
  }

  return {};
}

/**
 * Create initial state for a new run. Pure function.
 */
export function createInitialState(
  flow: StepFlowConfig,
  runId: string
): StepMachineState {
  const now = Date.now();
  return {
    runId,
    flowId: flow.id ?? 'unnamed',
    currentStep: flow.settings.start_step,
    status: 'running',
    stepHistory: [],
    iterationCounts: {},
    retryCounts: {},
    startedAt: now,
    updatedAt: now,
  };
}
