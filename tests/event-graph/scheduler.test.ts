/**
 * Event Graph — Scheduler Tests
 *
 * Tests for the pure scheduler: f(graph, state) → eligible tasks
 */

import { describe, it, expect } from 'vitest';
import { next, getCandidateTasks } from '../../src/event-graph/scheduler.js';
import { apply } from '../../src/event-graph/reducer.js';
import { createInitialExecutionState } from '../../src/event-graph/graph-helpers.js';
import type { GraphConfig, ExecutionState } from '../../src/event-graph/types.js';

// ============================================================================
// Fixtures
// ============================================================================

function makeLinearGraph(): GraphConfig {
  return {
    settings: { completion: 'all-tasks-done' },
    tasks: {
      fetch: { provides: ['raw-data'] },
      parse: { requires: ['raw-data'], provides: ['parsed-data'] },
      store: { requires: ['parsed-data'], provides: ['stored-data'] },
    },
  };
}

function makeDiamondGraph(): GraphConfig {
  return {
    settings: { completion: 'all-tasks-done', conflict_strategy: 'parallel-all' },
    tasks: {
      fetch: { provides: ['raw-data'] },
      transformA: { requires: ['raw-data'], provides: ['result-a'] },
      transformB: { requires: ['raw-data'], provides: ['result-b'] },
      merge: { requires: ['result-a', 'result-b'], provides: ['merged'] },
    },
  };
}

function makeState(graph: GraphConfig): ExecutionState {
  return createInitialExecutionState(graph, 'exec-1');
}

const ts = () => new Date().toISOString();

// ============================================================================
// getCandidateTasks
// ============================================================================

describe('getCandidateTasks', () => {
  it('should find root tasks (no requires) as initial candidates', () => {
    const graph = makeLinearGraph();
    const state = makeState(graph);
    const candidates = getCandidateTasks(graph, state);

    expect(candidates).toEqual(['fetch']);
  });

  it('should find next tasks after dependencies met', () => {
    const graph = makeLinearGraph();
    let state = makeState(graph);

    // Complete fetch → parse becomes eligible
    state = apply(state, { type: 'task-started', taskName: 'fetch', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-completed', taskName: 'fetch', timestamp: ts() }, graph);

    const candidates = getCandidateTasks(graph, state);
    expect(candidates).toContain('parse');
    expect(candidates).not.toContain('fetch'); // already completed
    expect(candidates).not.toContain('store'); // deps not met
  });

  it('should not include running tasks', () => {
    const graph = makeLinearGraph();
    let state = makeState(graph);
    state = apply(state, { type: 'task-started', taskName: 'fetch', timestamp: ts() }, graph);

    const candidates = getCandidateTasks(graph, state);
    expect(candidates).not.toContain('fetch');
  });

  it('should not include failed tasks', () => {
    const graph = makeLinearGraph();
    let state = makeState(graph);
    state = apply(state, { type: 'task-started', taskName: 'fetch', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-failed', taskName: 'fetch', error: 'oops', timestamp: ts() }, graph);

    const candidates = getCandidateTasks(graph, state);
    expect(candidates).not.toContain('fetch');
  });
});

// ============================================================================
// next() — full scheduler
// ============================================================================

describe('next', () => {
  it('should return eligible tasks for linear graph', () => {
    const graph = makeLinearGraph();
    const state = makeState(graph);
    const result = next(graph, state);

    expect(result.eligibleTasks).toEqual(['fetch']);
    expect(result.isComplete).toBe(false);
    expect(result.stuckDetection.is_stuck).toBe(false);
  });

  it('should return parallel tasks in diamond graph', () => {
    const graph = makeDiamondGraph();
    let state = makeState(graph);

    // Complete fetch
    state = apply(state, { type: 'task-started', taskName: 'fetch', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-completed', taskName: 'fetch', timestamp: ts() }, graph);

    const result = next(graph, state);
    expect(result.eligibleTasks).toContain('transformA');
    expect(result.eligibleTasks).toContain('transformB');
    expect(result.eligibleTasks).not.toContain('merge');
  });

  it('should detect completion when all tasks done', () => {
    const graph = makeLinearGraph();
    let state = makeState(graph);

    // Complete all tasks
    for (const taskName of ['fetch', 'parse', 'store']) {
      state = apply(state, { type: 'task-started', taskName, timestamp: ts() }, graph);
      state = apply(state, { type: 'task-completed', taskName, timestamp: ts() }, graph);
    }

    const result = next(graph, state);
    expect(result.isComplete).toBe(true);
    expect(result.eligibleTasks).toEqual([]);
  });

  it('should detect stuck state when task fails without on_failure tokens', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-done' },
      tasks: {
        a: { provides: ['x'] },
        b: { requires: ['x'], provides: ['y'] },
      },
    };
    let state = makeState(graph);

    // Fail task a → x never available → b blocked forever
    state = apply(state, { type: 'task-started', taskName: 'a', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-failed', taskName: 'a', error: 'crash', timestamp: ts() }, graph);

    const result = next(graph, state);
    expect(result.stuckDetection.is_stuck).toBe(true);
  });

  it('should handle empty graph', () => {
    const graph: GraphConfig = { settings: { completion: 'all-tasks-done' }, tasks: {} };
    const state = createInitialExecutionState(graph, 'exec-1');
    const result = next(graph, state);

    expect(result.isComplete).toBe(true);
    expect(result.eligibleTasks).toEqual([]);
  });

  it('should unblock tasks when tokens are injected', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-done' },
      tasks: {
        process: { requires: ['external-input'], provides: ['result'] },
      },
    };
    let state = makeState(graph);

    // Initially no candidates
    let result = next(graph, state);
    expect(result.eligibleTasks).toEqual([]);

    // Inject the required token
    state = apply(state, { type: 'inject-tokens', tokens: ['external-input'], timestamp: ts() }, graph);

    result = next(graph, state);
    expect(result.eligibleTasks).toContain('process');
  });
});

// ============================================================================
// Conflict resolution — basic coverage
// ============================================================================

describe('conflict resolution', () => {
  it('should use alphabetical strategy by default', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-done', execution_mode: 'eligibility-mode', conflict_strategy: 'alphabetical' },
      tasks: {
        beta: { provides: ['output'] },
        alpha: { provides: ['output'] },
      },
    };
    const state = makeState(graph);
    const result = next(graph, state);

    // Alphabetical: alpha before beta
    expect(result.eligibleTasks[0]).toBe('alpha');
  });

  it('should run all tasks with parallel-all strategy', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-done', execution_mode: 'eligibility-mode', conflict_strategy: 'parallel-all' },
      tasks: {
        a: { provides: ['output'] },
        b: { provides: ['output'] },
        c: { provides: ['output'] },
      },
    };
    const state = makeState(graph);
    const result = next(graph, state);

    expect(result.eligibleTasks).toHaveLength(3);
  });

  it('should prefer higher priority with priority-first strategy', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-done', execution_mode: 'eligibility-mode', conflict_strategy: 'priority-first' },
      tasks: {
        low: { provides: ['output'], priority: 1 },
        high: { provides: ['output'], priority: 10 },
      },
    };
    const state = makeState(graph);
    const result = next(graph, state);

    expect(result.eligibleTasks).toEqual(['high']);
  });
});

// ============================================================================
// Repeatable tasks
// ============================================================================

describe('repeatable tasks', () => {
  it('should allow repeatable tasks to re-execute when inputs refresh', () => {
    const graph: GraphConfig = {
      settings: { completion: 'goal-reached', goal: ['final'], conflict_strategy: 'parallel-all' },
      tasks: {
        source: { provides: ['data'] },
        processor: { requires: ['data'], provides: ['result'], repeatable: true },
        finalize: { requires: ['result'], provides: ['final'] },
      },
    };
    let state = makeState(graph);

    // Complete source → data available
    state = apply(state, { type: 'task-started', taskName: 'source', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-completed', taskName: 'source', timestamp: ts() }, graph);

    // Complete processor first time
    state = apply(state, { type: 'task-started', taskName: 'processor', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-completed', taskName: 'processor', timestamp: ts() }, graph);

    // After first completion, repeatable task status should be reset to not-started
    expect(state.tasks.processor.status).toBe('not-started');
    expect(state.tasks.processor.executionCount).toBe(1);
  });

  it('should respect max execution limit on repeatable tasks', () => {
    const graph: GraphConfig = {
      settings: { completion: 'all-tasks-done', conflict_strategy: 'parallel-all' },
      tasks: {
        trigger: { provides: ['signal'] },
        repeater: { requires: ['signal'], provides: ['output'], repeatable: { max: 2 } },
      },
    };
    let state = makeState(graph);

    // Complete trigger
    state = apply(state, { type: 'task-started', taskName: 'trigger', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-completed', taskName: 'trigger', timestamp: ts() }, graph);

    // Execute repeater twice
    state = apply(state, { type: 'task-started', taskName: 'repeater', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-completed', taskName: 'repeater', timestamp: ts() }, graph);
    // After first: executionCount=1, but it needs inputs refreshed for re-execution
    // Simulate trigger running again
    state = apply(state, { type: 'task-started', taskName: 'trigger', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-completed', taskName: 'trigger', timestamp: ts() }, graph);

    state = apply(state, { type: 'task-started', taskName: 'repeater', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-completed', taskName: 'repeater', timestamp: ts() }, graph);

    expect(state.tasks.repeater.executionCount).toBe(2);

    // After max reached, should not be eligible again
    // Simulate another trigger
    state = apply(state, { type: 'task-started', taskName: 'trigger', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-completed', taskName: 'trigger', timestamp: ts() }, graph);

    const candidates = getCandidateTasks(graph, state);
    expect(candidates).not.toContain('repeater');
  });
});

// ============================================================================
// Goal-based completion
// ============================================================================

describe('goal-based completion', () => {
  it('should complete when goal outputs are available', () => {
    const graph: GraphConfig = {
      settings: { completion: 'goal-reached', goal: ['final-answer'] },
      tasks: {
        compute: { provides: ['final-answer'] },
        optional: { requires: ['final-answer'], provides: ['extra'] },
      },
    };
    let state = makeState(graph);

    state = apply(state, { type: 'task-started', taskName: 'compute', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-completed', taskName: 'compute', timestamp: ts() }, graph);

    const result = next(graph, state);
    expect(result.isComplete).toBe(true);
  });
});
