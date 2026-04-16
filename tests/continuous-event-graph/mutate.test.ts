import { describe, it, expect } from 'vitest';
import { createLiveGraph, applyEvent } from '../../src/continuous-event-graph/core.js';
import { mutateGraph } from '../../src/continuous-event-graph/mutate.js';
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
// mutateGraph
// ============================================================================

describe('mutateGraph', () => {
  it('returns unchanged graph for empty mutations', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
    });
    const live = createLiveGraph(config);
    const result = mutateGraph(live, []);

    expect(result).toBe(live);
  });

  it('applies a single add-node mutation', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
    });
    const live = createLiveGraph(config);
    const result = mutateGraph(live, [
      { type: 'add-node', name: 'process', config: { requires: ['data'], provides: ['result'] } },
    ]);

    expect(result.config.tasks['process']).toBeDefined();
    expect(result.state.tasks['process']).toBeDefined();
    expect(result.state.tasks['process'].status).toBe('not-started');
  });

  it('applies a single remove-node mutation', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
      process: { requires: ['data'], provides: ['result'] },
    });
    const live = createLiveGraph(config);
    const result = mutateGraph(live, [
      { type: 'remove-node', name: 'process' },
    ]);

    expect(result.config.tasks['process']).toBeUndefined();
    expect(result.state.tasks['process']).toBeUndefined();
  });

  it('applies inject-tokens mutation', () => {
    const config = makeConfig({
      process: { requires: ['data'], provides: ['result'] },
    });
    const live = createLiveGraph(config);
    const result = mutateGraph(live, [
      { type: 'inject-tokens', tokens: ['data'] },
    ]);

    expect(result.state.availableOutputs).toContain('data');
  });

  it('applies drain-tokens mutation', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
    });
    let live = createLiveGraph(config);
    live = applyEvent(live, { type: 'task-started', taskName: 'fetch', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'fetch', timestamp: ts() });

    const result = mutateGraph(live, [
      { type: 'drain-tokens', tokens: ['data'] },
    ]);

    expect(result.state.availableOutputs).not.toContain('data');
  });

  it('applies add-requires and remove-requires', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
      process: { requires: ['data'], provides: ['result'] },
    });
    const live = createLiveGraph(config);

    // Add a new requires
    let result = mutateGraph(live, [
      { type: 'add-requires', taskName: 'process', tokens: ['extra'] },
    ]);
    expect(result.config.tasks['process'].requires).toContain('extra');
    expect(result.config.tasks['process'].requires).toContain('data');

    // Remove the new requires
    result = mutateGraph(result, [
      { type: 'remove-requires', taskName: 'process', tokens: ['extra'] },
    ]);
    expect(result.config.tasks['process'].requires).not.toContain('extra');
    expect(result.config.tasks['process'].requires).toContain('data');
  });

  it('applies add-provides and remove-provides', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
    });
    const live = createLiveGraph(config);

    let result = mutateGraph(live, [
      { type: 'add-provides', taskName: 'fetch', tokens: ['extra'] },
    ]);
    expect(result.config.tasks['fetch'].provides).toContain('extra');
    expect(result.config.tasks['fetch'].provides).toContain('data');

    result = mutateGraph(result, [
      { type: 'remove-provides', taskName: 'fetch', tokens: ['extra'] },
    ]);
    expect(result.config.tasks['fetch'].provides).not.toContain('extra');
  });

  it('applies reset-node, disable-node, enable-node', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
    });
    let live = createLiveGraph(config);
    live = applyEvent(live, { type: 'task-started', taskName: 'fetch', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'fetch', timestamp: ts() });

    // Reset
    let result = mutateGraph(live, [
      { type: 'reset-node', name: 'fetch' },
    ]);
    expect(result.state.tasks['fetch'].status).toBe('not-started');

    // Disable
    result = mutateGraph(result, [
      { type: 'disable-node', name: 'fetch' },
    ]);
    expect(result.state.tasks['fetch'].status).toBe('inactivated');

    // Enable
    result = mutateGraph(result, [
      { type: 'enable-node', name: 'fetch' },
    ]);
    expect(result.state.tasks['fetch'].status).toBe('not-started');
  });

  it('applies apply-events mutation', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
    });
    const live = createLiveGraph(config);

    const result = mutateGraph(live, [
      {
        type: 'apply-events',
        events: [
          { type: 'task-started', taskName: 'fetch', timestamp: ts() },
          { type: 'task-completed', taskName: 'fetch', timestamp: ts() },
        ],
      },
    ]);

    expect(result.state.tasks['fetch'].status).toBe('completed');
    expect(result.state.availableOutputs).toContain('data');
  });

  it('applies multiple mutations in sequence', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
    });
    const live = createLiveGraph(config);

    const result = mutateGraph(live, [
      // Add a new node
      { type: 'add-node', name: 'process', config: { requires: ['data'], provides: ['result'] } },
      // Inject tokens to satisfy fetch
      { type: 'inject-tokens', tokens: ['data'] },
      // Apply events to mark process as complete
      {
        type: 'apply-events',
        events: [
          { type: 'task-started', taskName: 'process', timestamp: ts() },
          { type: 'task-completed', taskName: 'process', timestamp: ts() },
        ],
      },
    ]);

    expect(result.config.tasks['process']).toBeDefined();
    expect(result.state.tasks['process'].status).toBe('completed');
    expect(result.state.availableOutputs).toContain('data');
    expect(result.state.availableOutputs).toContain('result');
  });

  it('throws on unknown mutation type', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
    });
    const live = createLiveGraph(config);

    expect(() => {
      mutateGraph(live, [
        { type: 'unknown-mutation' } as any,
      ]);
    }).toThrow('Unknown mutation type');
  });
});
