import { describe, it, expect } from 'vitest';
import { validateGraphSchema } from '../../src/event-graph/schema-validator.js';

describe('validateGraphSchema', () => {

  // ---------- valid configs ----------

  describe('valid configs', () => {
    it('minimal valid graph', () => {
      const r = validateGraphSchema({
        settings: { completion: 'all-tasks-done' },
        tasks: {
          a: { provides: ['token-a'] },
        },
      });
      expect(r.ok).toBe(true);
      expect(r.errors).toHaveLength(0);
    });

    it('graph with requires and on', () => {
      const r = validateGraphSchema({
        settings: { completion: 'all-tasks-done' },
        tasks: {
          fetch: { provides: ['data-ready'] },
          process: {
            requires: ['data-ready'],
            provides: ['processed'],
            on: { partial: ['partial-data'] },
          },
        },
      });
      expect(r.ok).toBe(true);
    });

    it('goal-reached with goal array', () => {
      const r = validateGraphSchema({
        settings: { completion: 'goal-reached', goal: ['done'] },
        tasks: {
          a: { provides: ['done'] },
        },
      });
      expect(r.ok).toBe(true);
    });

    it('all completion strategies accepted', () => {
      const strategies = ['all-tasks-done', 'all-outputs-done', 'only-resolved', 'goal-reached', 'manual'];
      for (const completion of strategies) {
        const config: Record<string, unknown> = {
          settings: { completion },
          tasks: { a: { provides: ['x'] } },
        };
        if (completion === 'goal-reached') {
          (config.settings as Record<string, unknown>).goal = ['x'];
        }
        const r = validateGraphSchema(config);
        expect(r.ok, `strategy "${completion}" should be valid`).toBe(true);
      }
    });

    it('all conflict strategies accepted', () => {
      const strategies = [
        'alphabetical', 'priority-first', 'duration-first', 'cost-optimized',
        'resource-aware', 'random-select', 'user-choice', 'parallel-all',
        'skip-conflicts', 'round-robin',
      ];
      for (const conflict_strategy of strategies) {
        const r = validateGraphSchema({
          settings: { completion: 'all-tasks-done', conflict_strategy },
          tasks: { a: { provides: ['x'] } },
        });
        expect(r.ok, `conflict strategy "${conflict_strategy}" should be valid`).toBe(true);
      }
    });

    it('task with all optional fields', () => {
      const r = validateGraphSchema({
        id: 'full-graph',
        settings: {
          completion: 'all-tasks-done',
          conflict_strategy: 'priority-first',
          execution_mode: 'dependency-mode',
          max_iterations: 500,
          timeout_ms: 60000,
        },
        tasks: {
          deploy: {
            requires: ['build-done'],
            provides: ['deployed'],
            on: { rollback: ['rollback-needed'] },
            on_failure: ['deploy-failed'],
            method: 'azure-pipeline',
            config: { region: 'us-east' },
            priority: 10,
            estimatedDuration: 5000,
            estimatedCost: 1.5,
            estimatedResources: { cpu: 2, memory: 4 },
            retry: { max_attempts: 3, delay_ms: 1000, backoff_multiplier: 2 },
            refreshStrategy: 'epoch-changed',
            maxExecutions: 3,
            circuit_breaker: { max_executions: 5, on_break: ['circuit-open'] },
            description: 'Deploy to production',
            inference: {
              criteria: 'Deployment logs show success',
              keywords: ['deploy', 'production'],
              suggestedChecks: ['Check deployment status'],
              autoDetectable: true,
            },
          },
          build: {
            provides: ['build-done'],
            refreshStrategy: 'data-changed',
          },
        },
      });
      expect(r.ok).toBe(true);
    });
  });

  // ---------- invalid configs ----------

  describe('invalid configs', () => {
    it('null input', () => {
      const r = validateGraphSchema(null);
      expect(r.ok).toBe(false);
    });

    it('missing settings', () => {
      const r = validateGraphSchema({
        tasks: { a: { provides: ['x'] } },
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('settings'))).toBe(true);
    });

    it('missing completion', () => {
      const r = validateGraphSchema({
        settings: {},
        tasks: { a: { provides: ['x'] } },
      });
      expect(r.ok).toBe(false);
    });

    it('invalid completion strategy', () => {
      const r = validateGraphSchema({
        settings: { completion: 'bogus' },
        tasks: { a: { provides: ['x'] } },
      });
      expect(r.ok).toBe(false);
    });

    it('goal-reached without goal array', () => {
      const r = validateGraphSchema({
        settings: { completion: 'goal-reached' },
        tasks: { a: { provides: ['x'] } },
      });
      expect(r.ok).toBe(false);
    });

    it('missing tasks', () => {
      const r = validateGraphSchema({
        settings: { completion: 'all-tasks-done' },
      });
      expect(r.ok).toBe(false);
    });

    it('empty tasks', () => {
      const r = validateGraphSchema({
        settings: { completion: 'all-tasks-done' },
        tasks: {},
      });
      expect(r.ok).toBe(false);
    });

    it('task missing provides', () => {
      const r = validateGraphSchema({
        settings: { completion: 'all-tasks-done' },
        tasks: { a: { requires: ['x'] } },
      });
      expect(r.ok).toBe(false);
    });

    it('unknown top-level key', () => {
      const r = validateGraphSchema({
        settings: { completion: 'all-tasks-done' },
        tasks: { a: { provides: ['x'] } },
        extra: true,
      });
      expect(r.ok).toBe(false);
    });

    it('unknown key in task', () => {
      const r = validateGraphSchema({
        settings: { completion: 'all-tasks-done' },
        tasks: { a: { provides: ['x'], bogus: true } },
      });
      expect(r.ok).toBe(false);
    });

    it('unknown key in settings', () => {
      const r = validateGraphSchema({
        settings: { completion: 'all-tasks-done', unknown: 1 },
        tasks: { a: { provides: ['x'] } },
      });
      expect(r.ok).toBe(false);
    });

    it('invalid conflict strategy', () => {
      const r = validateGraphSchema({
        settings: { completion: 'all-tasks-done', conflict_strategy: 'nope' },
        tasks: { a: { provides: ['x'] } },
      });
      expect(r.ok).toBe(false);
    });

    it('retry missing max_attempts', () => {
      const r = validateGraphSchema({
        settings: { completion: 'all-tasks-done' },
        tasks: { a: { provides: ['x'], retry: { delay_ms: 100 } } },
      });
      expect(r.ok).toBe(false);
    });

    it('circuit_breaker missing required fields', () => {
      const r = validateGraphSchema({
        settings: { completion: 'all-tasks-done' },
        tasks: { a: { provides: ['x'], circuit_breaker: {} } },
      });
      expect(r.ok).toBe(false);
    });

    it('on values must be arrays', () => {
      const r = validateGraphSchema({
        settings: { completion: 'all-tasks-done' },
        tasks: { a: { provides: ['x'], on: { result: 'not-array' } } },
      });
      expect(r.ok).toBe(false);
    });

    it('inference unknown field rejected', () => {
      const r = validateGraphSchema({
        settings: { completion: 'all-tasks-done' },
        tasks: { a: { provides: ['x'], inference: { bogus: true } } },
      });
      expect(r.ok).toBe(false);
    });
  });

  // ---------- error messages ----------

  describe('error messages', () => {
    it('reports multiple errors with allErrors', () => {
      const r = validateGraphSchema({});
      expect(r.ok).toBe(false);
      expect(r.errors.length).toBeGreaterThan(1);
    });

    it('includes instance path', () => {
      const r = validateGraphSchema({
        settings: { completion: 'all-tasks-done' },
        tasks: { a: { provides: ['x'], retry: {} } },
      });
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('retry'))).toBe(true);
    });
  });
});
