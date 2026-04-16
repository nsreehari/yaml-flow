import { describe, it, expect } from 'vitest';
import {
  createLiveGraph,
  applyEvent,
} from '../../src/continuous-event-graph/core.js';
import { validateLiveGraph, validateReactiveGraph } from '../../src/continuous-event-graph/validate.js';
import type { GraphConfig, TaskConfig } from '../../src/event-graph/types.js';

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(tasks: Record<string, TaskConfig>): GraphConfig {
  return {
    settings: { completion: 'manual' as any },
    tasks,
  };
}

function ts(): string {
  return new Date().toISOString();
}

// ============================================================================
// validateLiveGraph
// ============================================================================

describe('validateLiveGraph', () => {
  it('returns valid for a fresh LiveGraph', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
      process: { requires: ['data'], provides: ['result'] },
    });
    const live = createLiveGraph(config);
    const result = validateLiveGraph(live);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects MISSING_STATE when state entry is removed', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
    });
    const live = createLiveGraph(config);
    // Artificially remove the state entry
    const corrupted = {
      ...live,
      state: {
        ...live.state,
        tasks: {},
      },
    };
    const result = validateLiveGraph(corrupted);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'MISSING_STATE')).toBe(true);
    expect(result.errors[0].tasks).toEqual(['fetch']);
  });

  it('detects ORPHAN_STATE for state entries without config', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
    });
    const live = createLiveGraph(config);
    // Add an orphan state entry
    const corrupted = {
      ...live,
      state: {
        ...live.state,
        tasks: {
          ...live.state.tasks,
          ghost: {
            status: 'completed' as any,
            executionCount: 1,
            retryCount: 0,
            lastEpoch: 0,
          },
        },
      },
    };
    const result = validateLiveGraph(corrupted);

    expect(result.warnings.some(w => w.code === 'ORPHAN_STATE')).toBe(true);
    expect(result.warnings.find(w => w.code === 'ORPHAN_STATE')!.tasks).toEqual(['ghost']);
  });

  it('detects RUNNING_WITHOUT_START', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
    });
    const live = createLiveGraph(config);
    const corrupted = {
      ...live,
      state: {
        ...live.state,
        tasks: {
          fetch: {
            ...live.state.tasks['fetch'],
            status: 'running' as any,
            // no startedAt
          },
        },
      },
    };
    const result = validateLiveGraph(corrupted);

    expect(result.warnings.some(w => w.code === 'RUNNING_WITHOUT_START')).toBe(true);
  });

  it('detects COMPLETED_WITHOUT_TIMESTAMP', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
    });
    const live = createLiveGraph(config);
    const corrupted = {
      ...live,
      state: {
        ...live.state,
        tasks: {
          fetch: {
            ...live.state.tasks['fetch'],
            status: 'completed' as any,
            executionCount: 1,
            // no completedAt
          },
        },
      },
    };
    const result = validateLiveGraph(corrupted);

    expect(result.warnings.some(w => w.code === 'COMPLETED_WITHOUT_TIMESTAMP')).toBe(true);
  });

  it('detects FAILED_WITHOUT_INFO', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
    });
    const live = createLiveGraph(config);
    const corrupted = {
      ...live,
      state: {
        ...live.state,
        tasks: {
          fetch: {
            ...live.state.tasks['fetch'],
            status: 'failed' as any,
            // no failedAt, no error
          },
        },
      },
    };
    const result = validateLiveGraph(corrupted);

    expect(result.issues.some(i => i.code === 'FAILED_WITHOUT_INFO')).toBe(true);
  });

  it('detects MISSING_OUTPUT when completed task tokens not available', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
    });
    const live = createLiveGraph(config);
    const corrupted = {
      ...live,
      state: {
        ...live.state,
        tasks: {
          fetch: {
            ...live.state.tasks['fetch'],
            status: 'completed' as any,
            executionCount: 1,
            completedAt: ts(),
          },
        },
        availableOutputs: [], // should have 'data'
      },
    };
    const result = validateLiveGraph(corrupted);

    expect(result.warnings.some(w => w.code === 'MISSING_OUTPUT')).toBe(true);
    expect(result.warnings.find(w => w.code === 'MISSING_OUTPUT')!.tokens).toEqual(['data']);
  });

  it('detects INJECTED_TOKEN for tokens no task can produce', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
    });
    const live = createLiveGraph(config);
    const corrupted = {
      ...live,
      state: {
        ...live.state,
        availableOutputs: ['external-signal'],
      },
    };
    const result = validateLiveGraph(corrupted);

    expect(result.issues.some(i => i.code === 'INJECTED_TOKEN')).toBe(true);
  });

  it('detects INVALID_EXECUTION_COUNT', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
    });
    const live = createLiveGraph(config);
    const corrupted = {
      ...live,
      state: {
        ...live.state,
        tasks: {
          fetch: {
            ...live.state.tasks['fetch'],
            executionCount: -1,
          },
        },
      },
    };
    const result = validateLiveGraph(corrupted);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_EXECUTION_COUNT')).toBe(true);
  });

  it('detects EXCEEDED_MAX_EXECUTIONS', () => {
    const config = makeConfig({
      fetch: { provides: ['data'], maxExecutions: 3 },
    });
    const live = createLiveGraph(config);
    const corrupted = {
      ...live,
      state: {
        ...live.state,
        tasks: {
          fetch: {
            ...live.state.tasks['fetch'],
            executionCount: 5,
          },
        },
      },
    };
    const result = validateLiveGraph(corrupted);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'EXCEEDED_MAX_EXECUTIONS')).toBe(true);
  });

  it('valid = true for a properly completed graph', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
      process: { requires: ['data'], provides: ['result'] },
    });
    let live = createLiveGraph(config);
    live = applyEvent(live, { type: 'task-started', taskName: 'fetch', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'fetch', timestamp: ts() });
    live = applyEvent(live, { type: 'task-started', taskName: 'process', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'process', timestamp: ts() });

    const result = validateLiveGraph(live);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
  });
});

// ============================================================================
// validateReactiveGraph
// ============================================================================

describe('validateReactiveGraph', () => {
  // Create a mock reactive graph for testing
  function createMockReactiveGraph(
    config: GraphConfig,
    handlers: Record<string, unknown>,
  ) {
    const live = createLiveGraph(config);
    return {
      graph: {
        getState: () => live,
        getSchedule: () => ({ eligible: [], pending: [], unresolved: [], blocked: [], conflicts: {} }),
        push: () => {},
        pushAll: () => {},
        addNode: () => {},
        removeNode: () => {},
        dispose: () => {},
      } as any,
      handlers,
    };
  }

  it('returns valid when all taskHandlers references exist in registry', () => {
    const config = makeConfig({
      fetch: { provides: ['data'], taskHandlers: ['fetch'] },
      process: { requires: ['data'], provides: ['result'], taskHandlers: ['process'] },
    });
    const input = createMockReactiveGraph(config, {
      fetch: async () => 'task-initiated',
      process: async () => 'task-initiated',
    });
    const result = validateReactiveGraph(input);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('detects MISSING_HANDLER when taskHandlers references missing handler', () => {
    const config = makeConfig({
      fetch: { provides: ['data'], taskHandlers: ['fetch'] },
      process: { requires: ['data'], provides: ['result'], taskHandlers: ['process'] },
    });
    const input = createMockReactiveGraph(config, {
      fetch: async () => 'task-initiated',
      // missing 'process' handler in registry
    });
    const result = validateReactiveGraph(input);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'MISSING_HANDLER')).toBe(true);
    expect(result.errors.find(e => e.code === 'MISSING_HANDLER')!.message).toContain('process');
  });

  it('no MISSING_HANDLER for tasks without taskHandlers (externally driven)', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] }, // no taskHandlers — externally driven
    });
    const input = createMockReactiveGraph(config, {});
    const result = validateReactiveGraph(input);

    expect(result.errors.some(e => e.code === 'MISSING_HANDLER')).toBe(false);
  });

  it('detects ORPHAN_HANDLER for unreferenced registry entries', () => {
    const config = makeConfig({
      fetch: { provides: ['data'], taskHandlers: ['fetch'] },
    });
    const input = createMockReactiveGraph(config, {
      fetch: async () => 'task-initiated',
      ghost: async () => 'task-initiated', // not referenced by any task's taskHandlers
    });
    const result = validateReactiveGraph(input);

    expect(result.warnings.some(w => w.code === 'ORPHAN_HANDLER')).toBe(true);
    expect(result.warnings.find(w => w.code === 'ORPHAN_HANDLER')!.tasks).toEqual(['ghost']);
  });

  it('includes underlying LiveGraph validation issues', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
    });
    // Create mock with corrupted state
    const live = createLiveGraph(config);
    const corruptedLive = {
      ...live,
      state: {
        ...live.state,
        tasks: {
          fetch: {
            ...live.state.tasks['fetch'],
            executionCount: -1,
          },
        },
      },
    };
    const input = {
      graph: {
        getState: () => corruptedLive,
        getSchedule: () => ({ eligible: [], pending: [], unresolved: [], blocked: [], conflicts: {} }),
        push: () => {},
        pushAll: () => {},
        addNode: () => {},
        removeNode: () => {},
        dispose: () => {},
      } as any,
      handlers: { fetch: async () => 'task-initiated' },
    };
    const result = validateReactiveGraph(input);

    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.code === 'INVALID_EXECUTION_COUNT')).toBe(true);
  });
});
