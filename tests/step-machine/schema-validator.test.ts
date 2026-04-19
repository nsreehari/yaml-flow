import { describe, it, expect } from 'vitest';
import { validateFlowSchema } from '../../src/step-machine/schema-validator.js';

describe('validateFlowSchema', () => {

  // ---------- valid configs ----------

  describe('valid configs', () => {
    it('minimal valid flow', () => {
      const r = validateFlowSchema({
        settings: { start_step: 'step1' },
        steps: {
          step1: { transitions: { success: 'done' } },
        },
        terminal_states: {
          done: { return_intent: 'success' },
        },
      });
      expect(r.ok).toBe(true);
      expect(r.errors).toHaveLength(0);
    });

    it('flow with all optional step fields', () => {
      const r = validateFlowSchema({
        id: 'my-flow',
        settings: { start_step: 'a', max_total_steps: 50, timeout_ms: 30000 },
        steps: {
          a: {
            description: 'First step',
            expects_data: ['input'],
            produces_data: ['output'],
            transitions: { success: 'b', error: 'fail' },
            failure_transitions: { failure: 'fail', timeout: 'fail' },
            retry: { max_attempts: 3, delay_ms: 1000, backoff_multiplier: 2 },
            circuit_breaker: { max_iterations: 5, on_open: 'fail' },
          },
          b: {
            transitions: { done: 'success' },
          },
        },
        terminal_states: {
          success: { return_intent: 'success', return_artifacts: ['output'], description: 'All good' },
          fail: { return_intent: 'error', return_artifacts: false },
        },
      });
      expect(r.ok).toBe(true);
    });

    it('return_artifacts as string', () => {
      const r = validateFlowSchema({
        settings: { start_step: 's' },
        steps: { s: { transitions: { ok: 'done' } } },
        terminal_states: { done: { return_intent: 'ok', return_artifacts: 'result' } },
      });
      expect(r.ok).toBe(true);
    });

    it('return_artifacts as array', () => {
      const r = validateFlowSchema({
        settings: { start_step: 's' },
        steps: { s: { transitions: { ok: 'done' } } },
        terminal_states: { done: { return_intent: 'ok', return_artifacts: ['a', 'b'] } },
      });
      expect(r.ok).toBe(true);
    });
  });

  // ---------- invalid configs ----------

  describe('invalid configs', () => {
    it('null input', () => {
      const r = validateFlowSchema(null);
      expect(r.ok).toBe(false);
    });

    it('missing settings', () => {
      const r = validateFlowSchema({
        steps: { s: { transitions: { ok: 'd' } } },
        terminal_states: { d: { return_intent: 'ok' } },
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('settings'))).toBe(true);
    });

    it('missing start_step', () => {
      const r = validateFlowSchema({
        settings: {},
        steps: { s: { transitions: { ok: 'd' } } },
        terminal_states: { d: { return_intent: 'ok' } },
      });
      expect(r.ok).toBe(false);
    });

    it('missing steps', () => {
      const r = validateFlowSchema({
        settings: { start_step: 's' },
        terminal_states: { d: { return_intent: 'ok' } },
      });
      expect(r.ok).toBe(false);
    });

    it('empty steps', () => {
      const r = validateFlowSchema({
        settings: { start_step: 's' },
        steps: {},
        terminal_states: { d: { return_intent: 'ok' } },
      });
      expect(r.ok).toBe(false);
    });

    it('missing terminal_states', () => {
      const r = validateFlowSchema({
        settings: { start_step: 's' },
        steps: { s: { transitions: { ok: 'd' } } },
      });
      expect(r.ok).toBe(false);
    });

    it('step missing transitions', () => {
      const r = validateFlowSchema({
        settings: { start_step: 's' },
        steps: { s: { description: 'no transitions' } },
        terminal_states: { d: { return_intent: 'ok' } },
      });
      expect(r.ok).toBe(false);
    });

    it('terminal_state missing return_intent', () => {
      const r = validateFlowSchema({
        settings: { start_step: 's' },
        steps: { s: { transitions: { ok: 'd' } } },
        terminal_states: { d: { description: 'missing intent' } },
      });
      expect(r.ok).toBe(false);
    });

    it('unknown top-level key', () => {
      const r = validateFlowSchema({
        settings: { start_step: 's' },
        steps: { s: { transitions: { ok: 'd' } } },
        terminal_states: { d: { return_intent: 'ok' } },
        extra: true,
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('additional'))).toBe(true);
    });

    it('unknown key in step', () => {
      const r = validateFlowSchema({
        settings: { start_step: 's' },
        steps: { s: { transitions: { ok: 'd' }, foo: 'bar' } },
        terminal_states: { d: { return_intent: 'ok' } },
      });
      expect(r.ok).toBe(false);
    });

    it('retry missing max_attempts', () => {
      const r = validateFlowSchema({
        settings: { start_step: 's' },
        steps: { s: { transitions: { ok: 'd' }, retry: { delay_ms: 100 } } },
        terminal_states: { d: { return_intent: 'ok' } },
      });
      expect(r.ok).toBe(false);
    });

    it('circuit_breaker missing required fields', () => {
      const r = validateFlowSchema({
        settings: { start_step: 's' },
        steps: { s: { transitions: { ok: 'd' }, circuit_breaker: {} } },
        terminal_states: { d: { return_intent: 'ok' } },
      });
      expect(r.ok).toBe(false);
    });

    it('failure_transitions must be an object', () => {
      const r = validateFlowSchema({
        settings: { start_step: 's' },
        steps: { s: { transitions: { ok: 'd' }, failure_transitions: 'bad' } },
        terminal_states: { d: { return_intent: 'ok' } },
      });
      expect(r.ok).toBe(false);
    });
  });

  // ---------- error messages ----------

  describe('error messages', () => {
    it('reports multiple errors with allErrors', () => {
      const r = validateFlowSchema({});
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThan(1);
    });
  });
});
