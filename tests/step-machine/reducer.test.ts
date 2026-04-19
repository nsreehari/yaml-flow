/**
 * Step Machine Reducer — Unit Tests
 *
 * Tests for the pure reducer functions: f(state, event) → newState
 */

import { describe, it, expect } from 'vitest';
import {
  applyStepResult,
  checkCircuitBreaker,
  computeStepInput,
  extractReturnData,
  createInitialState,
} from '../../src/step-machine/reducer.js';
import type { StepFlowConfig, StepMachineState } from '../../src/step-machine/types.js';

// ============================================================================
// Fixtures
// ============================================================================

const simpleFlow: StepFlowConfig = {
  id: 'test-flow',
  settings: { start_step: 'step1', max_total_steps: 10 },
  steps: {
    step1: {
      produces_data: ['value1'],
      transitions: { success: 'step2', failure: 'end_error' },
    },
    step2: {
      expects_data: ['value1'],
      produces_data: ['value2'],
      transitions: { success: 'end_ok', retry: 'step2' },
      failure_transitions: { failure: 'end_error' },
      retry: { max_attempts: 2, delay_ms: 100 },
    },
    loop_step: {
      transitions: { continue: 'loop_step', done: 'end_ok' },
      circuit_breaker: { max_iterations: 3, on_open: 'end_error' },
    },
  },
  terminal_states: {
    end_ok: { return_intent: 'success', return_artifacts: ['value1', 'value2'] },
    end_error: { return_intent: 'error', return_artifacts: false },
  },
};

function makeState(overrides: Partial<StepMachineState> = {}): StepMachineState {
  return {
    runId: 'test-run',
    flowId: 'test-flow',
    currentStep: 'step1',
    status: 'running',
    stepHistory: [],
    iterationCounts: {},
    retryCounts: {},
    startedAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

// ============================================================================
// createInitialState
// ============================================================================

describe('createInitialState', () => {
  it('should create an initial state with correct defaults', () => {
    const state = createInitialState(simpleFlow, 'run-123');
    expect(state.runId).toBe('run-123');
    expect(state.flowId).toBe('test-flow');
    expect(state.currentStep).toBe('step1');
    expect(state.status).toBe('running');
    expect(state.stepHistory).toEqual([]);
    expect(state.iterationCounts).toEqual({});
    expect(state.retryCounts).toEqual({});
  });

  it('should use "unnamed" when flow has no id', () => {
    const noIdFlow = { ...simpleFlow, id: undefined };
    const state = createInitialState(noIdFlow, 'run-x');
    expect(state.flowId).toBe('unnamed');
  });
});

// ============================================================================
// applyStepResult
// ============================================================================

describe('applyStepResult', () => {
  it('should transition to the next step on success', () => {
    const state = makeState({ currentStep: 'step1' });
    const result = applyStepResult(simpleFlow, state, 'step1', { result: 'success' });

    expect(result.nextStep).toBe('step2');
    expect(result.isTerminal).toBe(false);
    expect(result.isCircuitBroken).toBe(false);
    expect(result.shouldRetry).toBe(false);
    expect(result.newState.currentStep).toBe('step2');
    expect(result.newState.stepHistory).toEqual(['step1']);
  });

  it('should recognize terminal states', () => {
    const state = makeState({ currentStep: 'step1' });
    const result = applyStepResult(simpleFlow, state, 'step1', { result: 'failure' });

    expect(result.nextStep).toBe('end_error');
    expect(result.isTerminal).toBe(true);
  });

  it('should trigger retry when configured and under max attempts', () => {
    const state = makeState({ currentStep: 'step2', retryCounts: { step2: 0 } });
    const result = applyStepResult(simpleFlow, state, 'step2', { result: 'failure' });

    expect(result.shouldRetry).toBe(true);
    expect(result.nextStep).toBe('step2');
    expect(result.newState.retryCounts.step2).toBe(1);
  });

  it('should NOT retry when max attempts exceeded', () => {
    const state = makeState({ currentStep: 'step2', retryCounts: { step2: 2 } });
    // step2 has retry.max_attempts=2, retryCount is already 2, so no more retries.
    // failure_transitions.failure should be used after retries are exhausted.
    const result = applyStepResult(simpleFlow, state, 'step2', { result: 'failure' });
    expect(result.shouldRetry).toBe(false);
    expect(result.nextStep).toBe('end_error');
  });

  it('should reset retry count on non-failure result', () => {
    const state = makeState({ currentStep: 'step2', retryCounts: { step2: 1 } });
    const result = applyStepResult(simpleFlow, state, 'step2', { result: 'success' });

    expect(result.newState.retryCounts.step2).toBe(0);
  });

  it('should throw on unknown step', () => {
    const state = makeState();
    expect(() => applyStepResult(simpleFlow, state, 'nonexistent', { result: 'success' }))
      .toThrow('Step "nonexistent" not found');
  });

  it('should throw on unknown transition result', () => {
    const state = makeState({ currentStep: 'step1' });
    expect(() => applyStepResult(simpleFlow, state, 'step1', { result: 'unknown' }))
      .toThrow('No transition defined for result "unknown"');
  });

  it('should use normal transitions when failure_transitions does not contain the result', () => {
    const state = makeState({ currentStep: 'step1' });
    const result = applyStepResult(simpleFlow, state, 'step1', { result: 'failure' });

    expect(result.nextStep).toBe('end_error');
    expect(result.isTerminal).toBe(true);
  });
});

// ============================================================================
// checkCircuitBreaker
// ============================================================================

describe('checkCircuitBreaker', () => {
  it('should increment iteration count for steps without circuit breaker', () => {
    const state = makeState({ currentStep: 'step1', iterationCounts: {} });
    const result = checkCircuitBreaker(simpleFlow, state, 'step1');

    expect(result.broken).toBe(false);
    expect(result.newState.iterationCounts.step1).toBe(1);
  });

  it('should NOT break when under max iterations', () => {
    const state = makeState({ currentStep: 'loop_step', iterationCounts: { loop_step: 1 } });
    const result = checkCircuitBreaker(simpleFlow, state, 'loop_step');

    expect(result.broken).toBe(false);
    expect(result.newState.iterationCounts.loop_step).toBe(2);
  });

  it('should break when max iterations reached', () => {
    const state = makeState({ currentStep: 'loop_step', iterationCounts: { loop_step: 3 } });
    const result = checkCircuitBreaker(simpleFlow, state, 'loop_step');

    expect(result.broken).toBe(true);
    expect(result.redirectStep).toBe('end_error');
    expect(result.newState.currentStep).toBe('end_error');
  });
});

// ============================================================================
// computeStepInput
// ============================================================================

describe('computeStepInput', () => {
  it('should filter data to expects_data keys', () => {
    const allData = { value1: 'one', value2: 'two', extra: 'ignored' };
    const input = computeStepInput(simpleFlow, 'step2', allData);

    expect(input).toEqual({ value1: 'one' });
  });

  it('should pass all data when expects_data is not specified', () => {
    const allData = { a: 1, b: 2 };
    const input = computeStepInput(simpleFlow, 'step1', allData);

    expect(input).toEqual({ a: 1, b: 2 });
  });

  it('should throw on unknown step', () => {
    expect(() => computeStepInput(simpleFlow, 'nonexistent', {}))
      .toThrow('Step "nonexistent" not found');
  });
});

// ============================================================================
// extractReturnData
// ============================================================================

describe('extractReturnData', () => {
  it('should extract named artifacts', () => {
    const allData = { value1: 'one', value2: 'two', extra: 'x' };
    const result = extractReturnData(['value1', 'value2'], allData);
    expect(result).toEqual({ value1: 'one', value2: 'two' });
  });

  it('should extract a single string artifact', () => {
    const result = extractReturnData('value1', { value1: 'one', value2: 'two' });
    expect(result).toEqual({ value1: 'one' });
  });

  it('should return empty when false', () => {
    expect(extractReturnData(false, { value1: 'one' })).toEqual({});
  });

  it('should return empty when undefined', () => {
    expect(extractReturnData(undefined, { value1: 'one' })).toEqual({});
  });
});
