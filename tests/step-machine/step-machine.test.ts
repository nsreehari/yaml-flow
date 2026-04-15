/**
 * Step Machine — Integration Tests
 *
 * End-to-end tests using the StepMachine class with a MemoryStore.
 */

import { describe, it, expect } from 'vitest';
import { StepMachine, createStepMachine } from '../../src/step-machine/StepMachine.js';
import { MemoryStore } from '../../src/stores/memory.js';
import type { StepFlowConfig, StepHandler, StepMachineResult } from '../../src/step-machine/types.js';

// ============================================================================
// Fixtures
// ============================================================================

const simpleFlow: StepFlowConfig = {
  settings: { start_step: 'start', max_total_steps: 10 },
  steps: {
    start: {
      produces_data: ['message'],
      transitions: { success: 'end_success', failure: 'end_error' },
    },
  },
  terminal_states: {
    end_success: { return_intent: 'success', return_artifacts: ['message'] },
    end_error: { return_intent: 'error', return_artifacts: false },
  },
};

const multiStepFlow: StepFlowConfig = {
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

// ============================================================================
// createStepMachine / constructor
// ============================================================================

describe('StepMachine', () => {
  describe('construction', () => {
    it('should create via factory function', () => {
      const handlers = { start: async () => ({ result: 'success', data: { message: 'hi' } }) };
      const sm = createStepMachine(simpleFlow, handlers);
      expect(sm).toBeInstanceOf(StepMachine);
    });

    it('should throw on missing start_step', () => {
      const bad = { settings: {}, steps: { a: { transitions: {} } }, terminal_states: { z: { return_intent: 'done' } } } as StepFlowConfig;
      expect(() => createStepMachine(bad, {})).toThrow('start_step');
    });

    it('should throw on empty steps', () => {
      const bad = { settings: { start_step: 'a' }, steps: {}, terminal_states: { z: { return_intent: 'done' } } } as StepFlowConfig;
      expect(() => createStepMachine(bad, {})).toThrow('at least one step');
    });

    it('should throw on missing terminal_states', () => {
      const bad = { settings: { start_step: 'a' }, steps: { a: { transitions: { s: 'z' } } }, terminal_states: {} } as StepFlowConfig;
      expect(() => createStepMachine(bad, {})).toThrow('at least one terminal_state');
    });

    it('should throw on dangling transition target', () => {
      const bad: StepFlowConfig = {
        settings: { start_step: 'a' },
        steps: { a: { transitions: { s: 'nonexistent' } } },
        terminal_states: { z: { return_intent: 'done' } },
      };
      expect(() => createStepMachine(bad, {})).toThrow('unknown step "nonexistent"');
    });
  });

  // ============================================================================
  // run
  // ============================================================================

  describe('run', () => {
    it('should execute a simple flow to completion', async () => {
      const handlers: Record<string, StepHandler> = {
        start: async (input) => ({ result: 'success', data: { message: `Hello, ${input.name ?? 'World'}!` } }),
      };
      const sm = createStepMachine(simpleFlow, handlers);
      const result = await sm.run({ name: 'Test' });

      expect(result.status).toBe('completed');
      expect(result.intent).toBe('success');
      expect(result.data.message).toBe('Hello, Test!');
      expect(result.stepHistory).toEqual(['start']);
    });

    it('should handle failure transitions', async () => {
      const handlers: Record<string, StepHandler> = {
        start: async () => ({ result: 'failure' }),
      };
      const sm = createStepMachine(simpleFlow, handlers);
      const result = await sm.run();

      expect(result.status).toBe('completed');
      expect(result.intent).toBe('error');
    });

    it('should respect max_total_steps', async () => {
      const loopFlow: StepFlowConfig = {
        settings: { start_step: 'loop', max_total_steps: 5 },
        steps: { loop: { transitions: { continue: 'loop', done: 'end' } } },
        terminal_states: { end: { return_intent: 'done' } },
      };
      const handlers: Record<string, StepHandler> = {
        loop: async () => ({ result: 'continue' }),
      };
      const sm = createStepMachine(loopFlow, handlers);
      const result = await sm.run();

      expect(result.status).toBe('max_iterations');
    });

    it('should pass data between steps', async () => {
      const handlers: Record<string, StepHandler> = {
        step1: async () => ({ result: 'success', data: { value1: 'one' } }),
        step2: async (input) => ({ result: 'success', data: { value2: `${input.value1}-two` } }),
      };
      const sm = createStepMachine(multiStepFlow, handlers);
      const result = await sm.run();

      expect(result.data.value1).toBe('one');
      expect(result.data.value2).toBe('one-two');
    });
  });

  // ============================================================================
  // circuit breaker
  // ============================================================================

  describe('circuit breaker', () => {
    it('should redirect when max iterations hit', async () => {
      const flow: StepFlowConfig = {
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
      const handlers: Record<string, StepHandler> = {
        retry_step: async () => ({ result: 'retry' }),
      };

      const sm = createStepMachine(flow, handlers);
      const result = await sm.run();

      expect(result.intent).toBe('circuit_breaker_triggered');
    });
  });

  // ============================================================================
  // component injection
  // ============================================================================

  describe('component injection', () => {
    it('should make components available to handlers', async () => {
      const mockDb = { query: () => 'db_result' };
      const handlers: Record<string, StepHandler> = {
        start: async (_input, ctx) => ({
          result: 'success',
          data: { message: (ctx.components.db as { query: () => string }).query() },
        }),
      };

      const sm = createStepMachine(simpleFlow, handlers, { components: { db: mockDb } });
      const result = await sm.run();

      expect(result.data.message).toBe('db_result');
    });
  });

  // ============================================================================
  // events
  // ============================================================================

  describe('events', () => {
    it('should emit step events', async () => {
      const events: string[] = [];
      const handlers: Record<string, StepHandler> = {
        start: async () => ({ result: 'success', data: { message: 'hi' } }),
      };

      const sm = createStepMachine(simpleFlow, handlers);
      sm.on('step:start', () => events.push('start'));
      sm.on('step:complete', () => events.push('complete'));
      sm.on('flow:start', () => events.push('flow:start'));
      sm.on('flow:complete', () => events.push('flow:complete'));

      await sm.run();

      expect(events).toContain('start');
      expect(events).toContain('complete');
      expect(events).toContain('flow:start');
      expect(events).toContain('flow:complete');
    });
  });

  // ============================================================================
  // backward compatibility (aliases)
  // ============================================================================

  describe('backward compatibility', () => {
    it('should be importable via the old FlowEngine/createEngine aliases', async () => {
      // Dynamic import to test export aliases from the root
      const { FlowEngine, createEngine } = await import('../../src/index.js');
      expect(FlowEngine).toBe(StepMachine);
      expect(typeof createEngine).toBe('function');
    });
  });
});
