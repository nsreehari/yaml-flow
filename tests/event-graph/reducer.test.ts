/**
 * Event Graph — Reducer Tests
 *
 * Tests for the pure reducer: f(state, event, graph) → newState
 */

import { describe, it, expect } from 'vitest';
import { apply, applyAll } from '../../src/event-graph/reducer.js';
import { createInitialExecutionState } from '../../src/event-graph/graph-helpers.js';
import type { GraphConfig, GraphEvent, ExecutionState } from '../../src/event-graph/types.js';

// ============================================================================
// Fixtures
// ============================================================================

function makeGraph(overrides: Partial<GraphConfig> = {}): GraphConfig {
  return {
    settings: { completion: 'all-tasks-done' },
    tasks: {
      fetch: { provides: ['raw-data'], description: 'Fetch data' },
      parse: { requires: ['raw-data'], provides: ['parsed-data'], description: 'Parse data' },
      store: { requires: ['parsed-data'], provides: ['stored-data'], description: 'Store data' },
    },
    ...overrides,
  };
}

function makeState(graph: GraphConfig): ExecutionState {
  return createInitialExecutionState(graph, 'exec-1');
}

const ts = () => new Date().toISOString();

// ============================================================================
// task-started event
// ============================================================================

describe('apply — task-started', () => {
  it('should set task status to running', () => {
    const graph = makeGraph();
    const state = makeState(graph);
    const event: GraphEvent = { type: 'task-started', taskName: 'fetch', timestamp: ts() };

    const next = apply(state, event, graph);
    expect(next.tasks.fetch.status).toBe('running');
    expect(next.tasks.fetch.startedAt).toBeTruthy();
  });

  it('should not mutate original state', () => {
    const graph = makeGraph();
    const state = makeState(graph);
    const event: GraphEvent = { type: 'task-started', taskName: 'fetch', timestamp: ts() };

    apply(state, event, graph);
    expect(state.tasks.fetch.status).toBe('not-started');
  });
});

// ============================================================================
// task-completed event
// ============================================================================

describe('apply — task-completed', () => {
  it('should mark task completed and add provides to available outputs', () => {
    const graph = makeGraph();
    let state = makeState(graph);
    state = apply(state, { type: 'task-started', taskName: 'fetch', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-completed', taskName: 'fetch', timestamp: ts() }, graph);

    expect(state.tasks.fetch.status).toBe('completed');
    expect(state.tasks.fetch.executionCount).toBe(1);
    expect(state.availableOutputs).toContain('raw-data');
  });

  it('should handle conditional provides via "on" routing', () => {
    const graph = makeGraph({
      tasks: {
        classify: {
          provides: ['default-result'],
          on: {
            positive: ['positive-result'],
            negative: ['negative-result'],
          },
        },
      },
    });
    let state = makeState(graph);
    state = apply(state, { type: 'task-started', taskName: 'classify', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-completed', taskName: 'classify', result: 'positive', timestamp: ts() }, graph);

    expect(state.availableOutputs).toContain('positive-result');
    expect(state.availableOutputs).not.toContain('default-result');
    expect(state.availableOutputs).not.toContain('negative-result');
  });

  it('should use default provides when result does not match any "on" key', () => {
    const graph = makeGraph({
      tasks: {
        classify: {
          provides: ['default-result'],
          on: { positive: ['positive-result'] },
        },
      },
    });
    let state = makeState(graph);
    state = apply(state, { type: 'task-started', taskName: 'classify', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-completed', taskName: 'classify', result: 'unknown', timestamp: ts() }, graph);

    expect(state.availableOutputs).toContain('default-result');
  });
});

// ============================================================================
// task-failed event
// ============================================================================

describe('apply — task-failed', () => {
  it('should mark task as failed with error', () => {
    const graph = makeGraph();
    let state = makeState(graph);
    state = apply(state, { type: 'task-started', taskName: 'fetch', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-failed', taskName: 'fetch', error: 'timeout', timestamp: ts() }, graph);

    expect(state.tasks.fetch.status).toBe('failed');
    expect(state.tasks.fetch.error).toBe('timeout');
  });

  it('should retry when under max_attempts', () => {
    const graph = makeGraph({
      tasks: {
        flaky: {
          provides: ['data'],
          retry: { max_attempts: 2 },
        },
      },
    });
    let state = makeState(graph);
    state = apply(state, { type: 'task-started', taskName: 'flaky', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-failed', taskName: 'flaky', error: 'error1', timestamp: ts() }, graph);

    // Should be set back to not-started for retry
    expect(state.tasks.flaky.status).toBe('not-started');
    expect(state.tasks.flaky.retryCount).toBe(1);
  });

  it('should fail after max retry attempts exceeded', () => {
    const graph = makeGraph({
      tasks: {
        flaky: {
          provides: ['data'],
          retry: { max_attempts: 1 },
        },
      },
    });
    let state = makeState(graph);

    // First attempt + failure → retry
    state = apply(state, { type: 'task-started', taskName: 'flaky', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-failed', taskName: 'flaky', error: 'e1', timestamp: ts() }, graph);
    expect(state.tasks.flaky.status).toBe('not-started'); // retrying

    // Second attempt + failure → actually failed (1 retry used up)
    state = apply(state, { type: 'task-started', taskName: 'flaky', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-failed', taskName: 'flaky', error: 'e2', timestamp: ts() }, graph);
    expect(state.tasks.flaky.status).toBe('failed');
  });

  it('should inject on_failure tokens', () => {
    const graph = makeGraph({
      tasks: {
        risky: {
          provides: ['data'],
          on_failure: ['data-unavailable'],
        },
      },
    });
    let state = makeState(graph);
    state = apply(state, { type: 'task-started', taskName: 'risky', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-failed', taskName: 'risky', error: 'crash', timestamp: ts() }, graph);

    expect(state.tasks.risky.status).toBe('failed');
    expect(state.availableOutputs).toContain('data-unavailable');
  });

  it('should inject circuit breaker tokens when limit hit', () => {
    const graph = makeGraph({
      tasks: {
        brittle: {
          provides: ['data'],
          circuit_breaker: { max_executions: 1, on_break: ['circuit-broken'] },
        },
      },
    });
    let state = makeState(graph);
    state = apply(state, { type: 'task-started', taskName: 'brittle', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-failed', taskName: 'brittle', error: 'boom', timestamp: ts() }, graph);

    expect(state.availableOutputs).toContain('circuit-broken');
  });
});

// ============================================================================
// task-progress event
// ============================================================================

describe('apply — task-progress', () => {
  it('should update progress and messages', () => {
    const graph = makeGraph();
    let state = makeState(graph);
    state = apply(state, { type: 'task-started', taskName: 'fetch', timestamp: ts() }, graph);
    state = apply(state, { type: 'task-progress', taskName: 'fetch', message: '50%', progress: 50, timestamp: ts() }, graph);

    expect(state.tasks.fetch.progress).toBe(50);
    expect(state.tasks.fetch.messages).toHaveLength(1);
    expect(state.tasks.fetch.messages![0].message).toBe('50%');
  });
});

// ============================================================================
// inject-tokens event
// ============================================================================

describe('apply — inject-tokens', () => {
  it('should add tokens to available outputs', () => {
    const graph = makeGraph();
    const state = makeState(graph);
    const next = apply(state, { type: 'inject-tokens', tokens: ['raw-data', 'extra-token'], timestamp: ts() }, graph);

    expect(next.availableOutputs).toContain('raw-data');
    expect(next.availableOutputs).toContain('extra-token');
  });

  it('should deduplicate tokens', () => {
    const graph = makeGraph();
    let state = makeState(graph);
    state = apply(state, { type: 'inject-tokens', tokens: ['a', 'b'], timestamp: ts() }, graph);
    state = apply(state, { type: 'inject-tokens', tokens: ['b', 'c'], timestamp: ts() }, graph);

    const aCount = state.availableOutputs.filter(t => t === 'b').length;
    expect(aCount).toBe(1);
    expect(state.availableOutputs).toContain('a');
    expect(state.availableOutputs).toContain('c');
  });
});

// ============================================================================
// agent-action event
// ============================================================================

describe('apply — agent-action', () => {
  it('should create fresh state on start', () => {
    const graph = makeGraph();
    const state = makeState(graph);
    const next = apply(state, { type: 'agent-action', action: 'start', timestamp: ts() }, graph);

    expect(next.status).toBe('running');
    expect(next.executionId).toBeTruthy();
    expect(next.availableOutputs).toEqual([]);
    expect(Object.keys(next.tasks)).toEqual(Object.keys(graph.tasks));
  });

  it('should stop execution', () => {
    const graph = makeGraph();
    const state = makeState(graph);
    const next = apply(state, { type: 'agent-action', action: 'stop', timestamp: ts() }, graph);

    expect(next.status).toBe('stopped');
    expect(next.executionId).toBeNull();
  });

  it('should pause and resume', () => {
    const graph = makeGraph();
    let state = makeState(graph);

    state = apply(state, { type: 'agent-action', action: 'pause', timestamp: ts() }, graph);
    expect(state.status).toBe('paused');

    state = apply(state, { type: 'agent-action', action: 'resume', timestamp: ts() }, graph);
    expect(state.status).toBe('running');
  });
});

// ============================================================================
// task-creation event
// ============================================================================

describe('apply — task-creation', () => {
  it('should add a new task to execution state', () => {
    const graph = makeGraph();
    const state = makeState(graph);
    const next = apply(state, {
      type: 'task-creation',
      taskName: 'new-task',
      taskConfig: { provides: ['new-output'] },
      timestamp: ts(),
    }, graph);

    expect(next.tasks['new-task']).toBeDefined();
    expect(next.tasks['new-task'].status).toBe('not-started');
  });

  it('should ignore invalid task creation', () => {
    const graph = makeGraph();
    const state = makeState(graph);
    const next = apply(state, {
      type: 'task-creation',
      taskName: '',
      taskConfig: { provides: [] as string[] },
      timestamp: ts(),
    }, graph);

    // Should be unchanged (empty name)
    expect(next).toBe(state);
  });
});

// ============================================================================
// Ghost event filtering
// ============================================================================

describe('ghost event filtering', () => {
  it('should skip events from a different execution', () => {
    const graph = makeGraph();
    const state = makeState(graph);

    const ghostEvent: GraphEvent = {
      type: 'task-started',
      taskName: 'fetch',
      timestamp: ts(),
      executionId: 'different-exec',
    };

    const next = apply(state, ghostEvent, graph);
    expect(next.tasks.fetch.status).toBe('not-started'); // unchanged
  });

  it('should apply events from the same execution', () => {
    const graph = makeGraph();
    const state = makeState(graph);

    const event: GraphEvent = {
      type: 'task-started',
      taskName: 'fetch',
      timestamp: ts(),
      executionId: 'exec-1', // matches state.executionId
    };

    const next = apply(state, event, graph);
    expect(next.tasks.fetch.status).toBe('running');
  });
});

// ============================================================================
// applyAll
// ============================================================================

describe('applyAll', () => {
  it('should apply multiple events in sequence', () => {
    const graph = makeGraph();
    const state = makeState(graph);

    const events: GraphEvent[] = [
      { type: 'task-started', taskName: 'fetch', timestamp: ts() },
      { type: 'task-completed', taskName: 'fetch', timestamp: ts() },
      { type: 'task-started', taskName: 'parse', timestamp: ts() },
      { type: 'task-completed', taskName: 'parse', timestamp: ts() },
    ];

    const final = applyAll(state, events, graph);

    expect(final.tasks.fetch.status).toBe('completed');
    expect(final.tasks.parse.status).toBe('completed');
    expect(final.availableOutputs).toContain('raw-data');
    expect(final.availableOutputs).toContain('parsed-data');
  });
});
