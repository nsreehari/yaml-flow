/**
 * yaml-flow - Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { FlowEngine, createEngine, validateFlowConfig } from '../src/core/index.js';
import { MemoryStore } from '../src/stores/memory.js';
import type { FlowConfig, StepHandler } from '../src/core/types.js';

describe('FlowEngine', () => {
  const simpleFlow: FlowConfig = {
    settings: {
      start_step: 'start',
      max_total_steps: 10,
    },
    steps: {
      start: {
        produces_data: ['message'],
        transitions: {
          success: 'end_success',
          failure: 'end_error',
        },
      },
    },
    terminal_states: {
      end_success: {
        return_intent: 'success',
        return_artifacts: ['message'],
      },
      end_error: {
        return_intent: 'error',
        return_artifacts: false,
      },
    },
  };

  const simpleHandlers: Record<string, StepHandler> = {
    start: async (input) => ({
      result: 'success',
      data: { message: `Hello, ${input.name || 'World'}!` },
    }),
  };

  describe('createEngine', () => {
    it('should create an engine instance', () => {
      const engine = createEngine(simpleFlow, simpleHandlers);
      expect(engine).toBeInstanceOf(FlowEngine);
    });

    it('should throw on invalid flow', () => {
      const invalidFlow = { settings: {} } as FlowConfig;
      expect(() => createEngine(invalidFlow, {})).toThrow();
    });
  });

  describe('run', () => {
    it('should execute a simple flow to completion', async () => {
      const engine = createEngine(simpleFlow, simpleHandlers);
      const result = await engine.run({ name: 'Test' });

      expect(result.status).toBe('completed');
      expect(result.intent).toBe('success');
      expect(result.data.message).toBe('Hello, Test!');
      expect(result.stepHistory).toEqual(['start']);
    });

    it('should handle failure transitions', async () => {
      const failingHandlers = {
        start: async () => ({ result: 'failure' }),
      };

      const engine = createEngine(simpleFlow, failingHandlers);
      const result = await engine.run();

      expect(result.status).toBe('completed');
      expect(result.intent).toBe('error');
    });

    it('should respect max_total_steps', async () => {
      const loopingFlow: FlowConfig = {
        settings: { start_step: 'loop', max_total_steps: 5 },
        steps: {
          loop: {
            transitions: { continue: 'loop', done: 'end' },
          },
        },
        terminal_states: {
          end: { return_intent: 'done' },
        },
      };

      const loopHandlers = {
        loop: async () => ({ result: 'continue' }),
      };

      const engine = createEngine(loopingFlow, loopHandlers);
      const result = await engine.run();

      expect(result.status).toBe('max_iterations');
    });
  });

  describe('circuit breaker', () => {
    it('should trigger circuit breaker after max iterations', async () => {
      const flowWithBreaker: FlowConfig = {
        settings: { start_step: 'retry_step', max_total_steps: 20 },
        steps: {
          retry_step: {
            transitions: { retry: 'retry_step', done: 'end' },
            circuit_breaker: { max_iterations: 3, on_open: 'breaker_open' },
          },
        },
        terminal_states: {
          end: { return_intent: 'success' },
          breaker_open: { return_intent: 'circuit_breaker_triggered' },
        },
      };

      const retryHandlers = {
        retry_step: async () => ({ result: 'retry' }),
      };

      const engine = createEngine(flowWithBreaker, retryHandlers);
      const result = await engine.run();

      expect(result.intent).toBe('circuit_breaker_triggered');
    });
  });

  describe('data flow', () => {
    it('should pass data between steps', async () => {
      const multiStepFlow: FlowConfig = {
        settings: { start_step: 'step1' },
        steps: {
          step1: {
            produces_data: ['value1'],
            transitions: { success: 'step2' },
          },
          step2: {
            expects_data: ['value1'],
            produces_data: ['value2'],
            transitions: { success: 'end' },
          },
        },
        terminal_states: {
          end: { return_intent: 'success', return_artifacts: ['value1', 'value2'] },
        },
      };

      const handlers = {
        step1: async () => ({ result: 'success', data: { value1: 'one' } }),
        step2: async (input) => ({
          result: 'success',
          data: { value2: `${input.value1}-two` },
        }),
      };

      const engine = createEngine(multiStepFlow, handlers);
      const result = await engine.run();

      expect(result.data.value1).toBe('one');
      expect(result.data.value2).toBe('one-two');
    });
  });

  describe('component injection', () => {
    it('should make components available to handlers', async () => {
      const mockDb = { query: () => 'db_result' };

      const handlers = {
        start: async (input, ctx) => ({
          result: 'success',
          data: { message: ctx.components.db.query() },
        }),
      };

      const engine = createEngine(simpleFlow, handlers, {
        components: { db: mockDb },
      });

      const result = await engine.run();
      expect(result.data.message).toBe('db_result');
    });
  });

  describe('events', () => {
    it('should emit step events', async () => {
      const events: string[] = [];

      const engine = createEngine(simpleFlow, simpleHandlers);
      engine.on('step:start', () => events.push('start'));
      engine.on('step:complete', () => events.push('complete'));

      await engine.run();

      expect(events).toContain('start');
      expect(events).toContain('complete');
    });
  });
});

describe('validateFlowConfig', () => {
  it('should return empty array for valid flow', () => {
    const flow = {
      settings: { start_step: 'start' },
      steps: { start: { transitions: { success: 'end' } } },
      terminal_states: { end: { return_intent: 'done' } },
    };

    const errors = validateFlowConfig(flow);
    expect(errors).toEqual([]);
  });

  it('should detect missing settings', () => {
    const flow = {
      steps: {},
      terminal_states: {},
    };

    const errors = validateFlowConfig(flow);
    expect(errors.some(e => e.includes('settings'))).toBe(true);
  });

  it('should detect missing start_step', () => {
    const flow = {
      settings: {},
      steps: { start: { transitions: {} } },
      terminal_states: { end: { return_intent: 'done' } },
    };

    const errors = validateFlowConfig(flow);
    expect(errors.some(e => e.includes('start_step'))).toBe(true);
  });
});

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it('should save and load run state', async () => {
    const state = {
      runId: 'test-run',
      flowId: 'test-flow',
      currentStep: 'start',
      status: 'running' as const,
      stepHistory: [],
      iterationCounts: {},
      retryCounts: {},
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };

    await store.saveRunState('test-run', state);
    const loaded = await store.loadRunState('test-run');

    expect(loaded).toEqual(state);
  });

  it('should set and get data', async () => {
    await store.setData('run1', 'key1', 'value1');
    const value = await store.getData('run1', 'key1');

    expect(value).toBe('value1');
  });

  it('should get all data', async () => {
    await store.setData('run1', 'key1', 'value1');
    await store.setData('run1', 'key2', 'value2');

    const allData = await store.getAllData('run1');

    expect(allData).toEqual({ key1: 'value1', key2: 'value2' });
  });

  it('should clear data', async () => {
    await store.setData('run1', 'key1', 'value1');
    await store.clearData('run1');

    const allData = await store.getAllData('run1');
    expect(allData).toEqual({});
  });

  it('should list runs', async () => {
    const state = {
      runId: 'run1',
      flowId: 'flow',
      currentStep: 'start',
      status: 'running' as const,
      stepHistory: [],
      iterationCounts: {},
      retryCounts: {},
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };

    await store.saveRunState('run1', state);
    await store.saveRunState('run2', { ...state, runId: 'run2' });

    const runs = await store.listRuns();
    expect(runs).toContain('run1');
    expect(runs).toContain('run2');
  });
});
