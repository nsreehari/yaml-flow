import { describe, it, expect } from 'vitest';
import {
  createLiveGraph,
  applyEvent,
  addNode,
  removeNode,
  addRequires,
  removeRequires,
  addProvides,
  removeProvides,
  injectTokens,
  drainTokens,
  schedule,
  inspect,
  resetNode,
  disableNode,
  enableNode,
  getNode,
  snapshot,
  restore,
  getUnreachableTokens,
  getUnreachableNodes,
  getUpstream,
  getDownstream,
} from '../../src/continuous-event-graph/index.js';
import type { GraphConfig, LiveGraph, TaskConfig } from '../../src/continuous-event-graph/types.js';

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
// createLiveGraph
// ============================================================================

describe('createLiveGraph', () => {
  it('creates a LiveGraph with initial state for all tasks', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
      process: { requires: ['data'], provides: ['result'] },
    });
    const live = createLiveGraph(config, 'test-1');

    expect(live.config).toBe(config);
    expect(live.state.executionId).toBe('test-1');
    expect(live.state.status).toBe('running');
    expect(Object.keys(live.state.tasks)).toEqual(['fetch', 'process']);
    expect(live.state.tasks['fetch'].status).toBe('not-started');
    expect(live.state.tasks['process'].status).toBe('not-started');
    expect(live.state.availableOutputs).toEqual([]);
  });

  it('auto-generates executionId if not provided', () => {
    const live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }));
    expect(live.state.executionId).toMatch(/^live-/);
  });

  it('handles empty tasks', () => {
    const live = createLiveGraph(makeConfig({}));
    expect(Object.keys(live.state.tasks)).toEqual([]);
  });
});

// ============================================================================
// applyEvent — task lifecycle
// ============================================================================

describe('applyEvent — task lifecycle', () => {
  const config = makeConfig({
    fetch: { provides: ['data'] },
    process: { requires: ['data'], provides: ['result'] },
  });

  it('applies task-started event', () => {
    const live = createLiveGraph(config, 'e1');
    const next = applyEvent(live, { type: 'task-started', taskName: 'fetch', timestamp: ts() });

    expect(next.state.tasks['fetch'].status).toBe('running');
    expect(next.config).toBe(live.config); // config unchanged
  });

  it('applies task-completed event and adds provides to availableOutputs', () => {
    let live = createLiveGraph(config, 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'fetch', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'fetch', timestamp: ts() });

    expect(live.state.tasks['fetch'].status).toBe('completed');
    expect(live.state.availableOutputs).toContain('data');
  });

  it('applies task-failed event', () => {
    let live = createLiveGraph(config, 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'fetch', timestamp: ts() });
    live = applyEvent(live, { type: 'task-failed', taskName: 'fetch', error: 'timeout', timestamp: ts() });

    expect(live.state.tasks['fetch'].status).toBe('failed');
  });

  it('applies task-progress event', () => {
    let live = createLiveGraph(config, 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'fetch', timestamp: ts() });
    live = applyEvent(live, { type: 'task-progress', taskName: 'fetch', progress: 50, message: 'halfway', timestamp: ts() });

    expect(live.state.tasks['fetch'].progress).toBe(50);
    expect(live.state.tasks['fetch'].messages).toHaveLength(1);
    expect(live.state.tasks['fetch'].messages![0].message).toBe('halfway');
  });

  it('applies inject-tokens event', () => {
    const live = createLiveGraph(config, 'e1');
    const next = applyEvent(live, { type: 'inject-tokens', tokens: ['external-signal'], timestamp: ts() });

    expect(next.state.availableOutputs).toContain('external-signal');
  });

  it('applies agent-action pause/resume', () => {
    let live = createLiveGraph(config, 'e1');
    live = applyEvent(live, { type: 'agent-action', action: 'pause', timestamp: ts() });
    expect(live.state.status).toBe('paused');

    live = applyEvent(live, { type: 'agent-action', action: 'resume', timestamp: ts() });
    expect(live.state.status).toBe('running');
  });

  it('applies agent-action stop', () => {
    let live = createLiveGraph(config, 'e1');
    live = applyEvent(live, { type: 'agent-action', action: 'stop', timestamp: ts() });
    expect(live.state.status).toBe('stopped');
  });

  it('ignores events with mismatched executionId', () => {
    const live = createLiveGraph(config, 'e1');
    const next = applyEvent(live, { type: 'task-started', taskName: 'fetch', timestamp: ts(), executionId: 'wrong-id' });
    expect(next).toBe(live); // exact same reference
  });

  it('handles conditional provides via on', () => {
    const cfg = makeConfig({
      classify: { provides: ['classified'], on: { photo: ['is-photo'], doc: ['is-doc'] } },
    });
    let live = createLiveGraph(cfg, 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'classify', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'classify', result: 'photo', timestamp: ts() });

    expect(live.state.availableOutputs).toContain('is-photo');
    expect(live.state.availableOutputs).not.toContain('is-doc');
    expect(live.state.availableOutputs).not.toContain('classified');
  });

  it('is immutable — original LiveGraph is not modified', () => {
    const live = createLiveGraph(config, 'e1');
    const originalTasks = { ...live.state.tasks };
    applyEvent(live, { type: 'task-started', taskName: 'fetch', timestamp: ts() });

    expect(live.state.tasks['fetch'].status).toBe('not-started');
    expect(live.state.tasks).toEqual(originalTasks);
  });
});

// ============================================================================
// addNode / removeNode
// ============================================================================

describe('addNode / removeNode', () => {
  it('adds a node to both config and state', () => {
    let live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }), 'e1');
    live = addNode(live, 'b', { requires: ['x'], provides: ['y'] });

    expect(live.config.tasks['b']).toEqual({ requires: ['x'], provides: ['y'] });
    expect(live.state.tasks['b']).toBeDefined();
    expect(live.state.tasks['b'].status).toBe('not-started');
  });

  it('upserts existing node — replaces config, preserves state', () => {
    const live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }), 'e1');
    const next = addNode(live, 'a', { provides: ['z'] });

    expect(next).not.toBe(live); // new object
    expect(next.config.tasks['a'].provides).toEqual(['z']); // config replaced
    expect(next.state.tasks['a']).toBe(live.state.tasks['a']); // state preserved
  });

  it('removes a node from both config and state', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    }), 'e1');
    live = removeNode(live, 'a');

    expect(live.config.tasks['a']).toBeUndefined();
    expect(live.state.tasks['a']).toBeUndefined();
    expect(live.config.tasks['b']).toBeDefined();
    expect(live.state.tasks['b']).toBeDefined();
  });

  it('returns unchanged if removing non-existent node', () => {
    const live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }), 'e1');
    const next = removeNode(live, 'ghost');
    expect(next).toBe(live);
  });

  it('can add then remove a node', () => {
    let live = createLiveGraph(makeConfig({}), 'e1');
    live = addNode(live, 'a', { provides: ['x'] });
    expect(Object.keys(live.config.tasks)).toEqual(['a']);

    live = removeNode(live, 'a');
    expect(Object.keys(live.config.tasks)).toEqual([]);
    expect(Object.keys(live.state.tasks)).toEqual([]);
  });

  it('preserves state of other nodes when adding/removing', () => {
    let live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }), 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });
    live = addNode(live, 'b', { provides: ['y'] });

    expect(live.state.tasks['a'].status).toBe('running');
    expect(live.state.tasks['b'].status).toBe('not-started');
  });
});

// ============================================================================
// addRequires / removeRequires / addProvides / removeProvides
// ============================================================================

describe('wiring mutations', () => {
  it('addRequires adds tokens to a node', () => {
    let live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }), 'e1');
    live = addRequires(live, 'a', ['input-1', 'input-2']);

    expect(live.config.tasks['a'].requires).toEqual(['input-1', 'input-2']);
  });

  it('addRequires deduplicates', () => {
    let live = createLiveGraph(makeConfig({ a: { requires: ['x'], provides: ['y'] } }), 'e1');
    live = addRequires(live, 'a', ['x', 'z']);

    expect(live.config.tasks['a'].requires).toEqual(['x', 'z']);
  });

  it('addRequires returns unchanged for non-existent node', () => {
    const live = createLiveGraph(makeConfig({}), 'e1');
    expect(addRequires(live, 'ghost', ['x'])).toBe(live);
  });

  it('removeRequires removes tokens from a node', () => {
    let live = createLiveGraph(makeConfig({ a: { requires: ['x', 'y', 'z'], provides: ['out'] } }), 'e1');
    live = removeRequires(live, 'a', ['y']);

    expect(live.config.tasks['a'].requires).toEqual(['x', 'z']);
  });

  it('removeRequires returns unchanged if token not present', () => {
    const live = createLiveGraph(makeConfig({ a: { requires: ['x'], provides: ['y'] } }), 'e1');
    const next = removeRequires(live, 'a', ['nope']);
    expect(next).toBe(live);
  });

  it('addProvides adds tokens to a node', () => {
    let live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }), 'e1');
    live = addProvides(live, 'a', ['y', 'z']);

    expect(live.config.tasks['a'].provides).toEqual(['x', 'y', 'z']);
  });

  it('addProvides deduplicates', () => {
    let live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }), 'e1');
    live = addProvides(live, 'a', ['x', 'y']);

    expect(live.config.tasks['a'].provides).toEqual(['x', 'y']);
  });

  it('removeProvides removes tokens from a node', () => {
    let live = createLiveGraph(makeConfig({ a: { provides: ['x', 'y', 'z'] } }), 'e1');
    live = removeProvides(live, 'a', ['y']);

    expect(live.config.tasks['a'].provides).toEqual(['x', 'z']);
  });

  it('wiring mutations do not affect state', () => {
    let live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }), 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });
    const stateRef = live.state;

    live = addRequires(live, 'a', ['new-dep']);
    expect(live.state).toBe(stateRef); // exact same state reference
  });
});

// ============================================================================
// injectTokens convenience
// ============================================================================

describe('injectTokens', () => {
  it('adds tokens to available outputs', () => {
    let live = createLiveGraph(makeConfig({ a: { requires: ['signal'], provides: ['x'] } }), 'e1');
    live = injectTokens(live, ['signal']);

    expect(live.state.availableOutputs).toContain('signal');
  });
});

// ============================================================================
// schedule
// ============================================================================

describe('schedule', () => {
  it('returns eligible entry-point tasks', () => {
    const live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    }), 'e1');
    const result = schedule(live);

    expect(result.eligible).toEqual(['a']);
    expect(result.pending).toEqual([{ taskName: 'b', waitingOn: ['x'] }]);
    expect(result.unresolved).toEqual([]);
    expect(result.blocked).toEqual([]);
  });

  it('moves tasks to eligible after dependencies satisfied', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    }), 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'a', timestamp: ts() });

    const result = schedule(live);
    expect(result.eligible).toEqual(['b']);
    expect(result.pending).toEqual([]);
  });

  it('detects unresolved dependencies (no producer)', () => {
    const live = createLiveGraph(makeConfig({
      orphan: { requires: ['ghost-token'], provides: ['x'] },
    }), 'e1');
    const result = schedule(live);

    expect(result.eligible).toEqual([]);
    expect(result.unresolved).toEqual([{
      taskName: 'orphan',
      missingTokens: ['ghost-token'],
    }]);
  });

  it('detects blocked tasks (producer failed)', () => {
    let live = createLiveGraph(makeConfig({
      producer: { provides: ['data'] },
      consumer: { requires: ['data'], provides: ['result'] },
    }), 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'producer', timestamp: ts() });
    live = applyEvent(live, { type: 'task-failed', taskName: 'producer', error: 'boom', timestamp: ts() });

    const result = schedule(live);
    expect(result.eligible).toEqual([]);
    expect(result.blocked).toEqual([{
      taskName: 'consumer',
      failedTokens: ['data'],
      failedProducers: ['producer'],
    }]);
  });

  it('reports pending when producer exists but has not completed', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    }), 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });

    const result = schedule(live);
    expect(result.eligible).toEqual([]);
    expect(result.pending).toEqual([{ taskName: 'b', waitingOn: ['x'] }]);
  });

  it('handles empty graph', () => {
    const live = createLiveGraph(makeConfig({}), 'e1');
    const result = schedule(live);
    expect(result.eligible).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it('detects conflicts among eligible tasks', () => {
    const live = createLiveGraph(makeConfig({
      a: { provides: ['output'] },
      b: { provides: ['output'] },
    }), 'e1');
    const result = schedule(live);

    expect(result.eligible).toContain('a');
    expect(result.eligible).toContain('b');
    expect(result.conflicts).toEqual({ output: ['a', 'b'] });
  });

  it('resolves dynamically added nodes', () => {
    let live = createLiveGraph(makeConfig({
      consumer: { requires: ['external-data'], provides: ['result'] },
    }), 'e1');

    // Consumer is unresolved
    expect(schedule(live).unresolved).toHaveLength(1);

    // Dynamically add a producer
    live = addNode(live, 'fetcher', { provides: ['external-data'] });
    const result = schedule(live);

    expect(result.unresolved).toEqual([]);
    expect(result.eligible).toContain('fetcher');
    expect(result.pending).toEqual([{ taskName: 'consumer', waitingOn: ['external-data'] }]);
  });

  it('resolves unresolved deps via injected tokens', () => {
    let live = createLiveGraph(makeConfig({
      consumer: { requires: ['sensor-reading'], provides: ['analysis'] },
    }), 'e1');

    expect(schedule(live).unresolved).toHaveLength(1);

    live = injectTokens(live, ['sensor-reading']);
    const result = schedule(live);

    expect(result.unresolved).toEqual([]);
    expect(result.eligible).toEqual(['consumer']);
  });

  it('skips completed tasks', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    }), 'e1');

    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'a', timestamp: ts() });
    live = applyEvent(live, { type: 'task-started', taskName: 'b', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'b', timestamp: ts() });

    const result = schedule(live);
    expect(result.eligible).toEqual([]);
    expect(result.pending).toEqual([]);
    expect(result.unresolved).toEqual([]);
  });

  it('handles diamond dependency pattern', () => {
    const live = createLiveGraph(makeConfig({
      start: { provides: ['ready'] },
      left: { requires: ['ready'], provides: ['left-done'] },
      right: { requires: ['ready'], provides: ['right-done'] },
      join: { requires: ['left-done', 'right-done'], provides: ['final'] },
    }), 'e1');

    let result = schedule(live);
    expect(result.eligible).toEqual(['start']);

    let l = applyEvent(live, { type: 'task-started', taskName: 'start', timestamp: ts() });
    l = applyEvent(l, { type: 'task-completed', taskName: 'start', timestamp: ts() });
    result = schedule(l);
    expect(result.eligible.sort()).toEqual(['left', 'right']);
    expect(result.pending).toEqual([{ taskName: 'join', waitingOn: ['left-done', 'right-done'] }]);
  });

  it('handles mix of unresolved and pending', () => {
    const live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x', 'ghost'], provides: ['y'] },
    }), 'e1');

    const result = schedule(live);
    // b requires 'ghost' which no task produces → unresolved
    expect(result.unresolved).toEqual([{ taskName: 'b', missingTokens: ['ghost'] }]);
  });
});

// ============================================================================
// inspect
// ============================================================================

describe('inspect', () => {
  it('reports task status counts', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
      c: { requires: ['y'], provides: ['z'] },
    }), 'e1');

    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'a', timestamp: ts() });
    live = applyEvent(live, { type: 'task-started', taskName: 'b', timestamp: ts() });

    const health = inspect(live);
    expect(health.totalNodes).toBe(3);
    expect(health.completed).toBe(1);
    expect(health.running).toBe(1);
    expect(health.notStarted).toBe(1);
    expect(health.failed).toBe(0);
  });

  it('detects open dependencies', () => {
    const live = createLiveGraph(makeConfig({
      a: { requires: ['mystery'], provides: ['x'] },
      b: { requires: ['also-missing'], provides: ['y'] },
    }), 'e1');

    const health = inspect(live);
    expect(health.openDependencies.sort()).toEqual(['also-missing', 'mystery']);
    expect(health.unresolvedCount).toBe(2);
  });

  it('detects blocked tasks (producer failed)', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    }), 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });
    live = applyEvent(live, { type: 'task-failed', taskName: 'a', error: 'err', timestamp: ts() });

    const health = inspect(live);
    expect(health.blockedCount).toBe(1);
  });

  it('detects cycles after dynamic add', () => {
    let live = createLiveGraph(makeConfig({
      a: { requires: ['y'], provides: ['x'] },
    }), 'e1');
    live = addNode(live, 'b', { requires: ['x'], provides: ['y'] });

    const health = inspect(live);
    expect(health.cycles.length).toBeGreaterThanOrEqual(1);
  });

  it('detects conflict tokens', () => {
    const live = createLiveGraph(makeConfig({
      a: { provides: ['shared'] },
      b: { provides: ['shared'] },
    }), 'e1');

    const health = inspect(live);
    expect(health.conflictTokens).toEqual(['shared']);
  });

  it('reports empty for clean graph', () => {
    const live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    }), 'e1');

    const health = inspect(live);
    expect(health.openDependencies).toEqual([]);
    expect(health.cycles).toEqual([]);
    expect(health.conflictTokens).toEqual([]);
    expect(health.unresolvedCount).toBe(0);
    expect(health.blockedCount).toBe(0);
  });
});

// ============================================================================
// Full scenario: stock dashboard continuous mode
// ============================================================================

describe('continuous mode — stock dashboard scenario', () => {
  it('evolves a live graph through add/complete/add cycle', () => {
    // Start with a minimal monitoring graph
    let live = createLiveGraph(makeConfig({
      'daily-scan': { provides: ['scan-complete'] },
      'price-check': { requires: ['scan-complete'], provides: ['prices-updated'] },
    }), 'dashboard-1');

    // Schedule: daily-scan is eligible
    let result = schedule(live);
    expect(result.eligible).toEqual(['daily-scan']);

    // Run daily-scan
    live = applyEvent(live, { type: 'task-started', taskName: 'daily-scan', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'daily-scan', timestamp: ts() });

    // price-check becomes eligible
    result = schedule(live);
    expect(result.eligible).toEqual(['price-check']);

    // Dynamically add a weekly rebalance task with open dependency
    live = addNode(live, 'weekly-rebalance', {
      requires: ['prices-updated', 'market-sentiment'],
      provides: ['rebalance-plan'],
    });

    // market-sentiment has no producer → unresolved
    result = schedule(live);
    expect(result.unresolved).toEqual([{
      taskName: 'weekly-rebalance',
      missingTokens: ['market-sentiment'],
    }]);

    // Caller responds by adding a sentiment analyzer
    live = addNode(live, 'sentiment-analyzer', {
      requires: ['scan-complete'],
      provides: ['market-sentiment'],
    });

    // Now sentiment-analyzer is eligible (scan-complete is available)
    result = schedule(live);
    expect(result.eligible).toContain('price-check');
    expect(result.eligible).toContain('sentiment-analyzer');
    // weekly-rebalance is pending (waiting on prices-updated + market-sentiment producers to complete)
    const weeklyPending = result.pending.find(p => p.taskName === 'weekly-rebalance');
    expect(weeklyPending).toBeDefined();

    // Complete all the tasks
    live = applyEvent(live, { type: 'task-started', taskName: 'price-check', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'price-check', timestamp: ts() });
    live = applyEvent(live, { type: 'task-started', taskName: 'sentiment-analyzer', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'sentiment-analyzer', timestamp: ts() });

    // weekly-rebalance is now eligible
    result = schedule(live);
    expect(result.eligible).toEqual(['weekly-rebalance']);

    // Health check
    const health = inspect(live);
    expect(health.totalNodes).toBe(4);
    expect(health.completed).toBe(3);
    expect(health.notStarted).toBe(1); // weekly-rebalance
    expect(health.openDependencies).toEqual([]);
    expect(health.cycles).toEqual([]);
  });

  it('handles breaking news injection', () => {
    let live = createLiveGraph(makeConfig({
      monitor: { provides: ['market-data'] },
    }), 'dash-2');

    // External trigger injects a token
    live = injectTokens(live, ['breaking-news']);

    // Dynamically add a task that needs the breaking news
    live = addNode(live, 'analyze-news', {
      requires: ['breaking-news'],
      provides: ['news-analysis'],
    });

    // It should be immediately eligible
    const result = schedule(live);
    expect(result.eligible).toContain('monitor');
    expect(result.eligible).toContain('analyze-news');
  });

  it('handles removing stale tasks', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      stale: { requires: ['x'], provides: ['old-data'] },
      consumer: { requires: ['old-data'], provides: ['result'] },
    }), 'e1');

    // Remove the stale task
    live = removeNode(live, 'stale');

    // consumer now has unresolved dependency
    const result = schedule(live);
    expect(result.unresolved).toEqual([{
      taskName: 'consumer',
      missingTokens: ['old-data'],
    }]);

    // Rewire: remove old-data requirement, add x directly
    live = removeRequires(live, 'consumer', ['old-data']);
    live = addRequires(live, 'consumer', ['x']);

    const result2 = schedule(live);
    expect(result2.unresolved).toEqual([]);
    // consumer is now pending on 'x' (a hasn't run yet)
    expect(result2.pending).toEqual([{ taskName: 'consumer', waitingOn: ['x'] }]);
  });

  it('evolving graph never completes (continuous)', () => {
    let live = createLiveGraph(makeConfig({
      task1: { provides: ['done'] },
    }), 'e1');

    live = applyEvent(live, { type: 'task-started', taskName: 'task1', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'task1', timestamp: ts() });

    // All tasks done but graph is still "running" — no completion check
    expect(live.state.status).toBe('running');

    // Add more work
    live = addNode(live, 'task2', { requires: ['done'], provides: ['more-done'] });
    const result = schedule(live);

    expect(result.eligible).toEqual(['task2']);
  });
});

// ============================================================================
// Edge cases
// ============================================================================

describe('edge cases', () => {
  it('addNode then applyEvent on the new node', () => {
    let live = createLiveGraph(makeConfig({}), 'e1');
    live = addNode(live, 'dynamic', { provides: ['x'] });
    live = applyEvent(live, { type: 'task-started', taskName: 'dynamic', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'dynamic', timestamp: ts() });

    expect(live.state.tasks['dynamic'].status).toBe('completed');
    expect(live.state.availableOutputs).toContain('x');
  });

  it('removeNode while task is running', () => {
    let live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }), 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });
    live = removeNode(live, 'a');

    expect(live.config.tasks['a']).toBeUndefined();
    expect(live.state.tasks['a']).toBeUndefined();
  });

  it('addProvides to node and schedule picks it up', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x', 'y'], provides: ['z'] },
    }), 'e1');

    // b is unresolved because nothing produces 'y'
    expect(schedule(live).unresolved).toHaveLength(1);

    // Add 'y' to a's provides
    live = addProvides(live, 'a', ['y']);
    // Now a produces both x and y → b is pending
    const result = schedule(live);
    expect(result.unresolved).toEqual([]);
    expect(result.pending).toEqual([{ taskName: 'b', waitingOn: ['x', 'y'] }]);
  });

  it('removeRequires unblocks a task', () => {
    let live = createLiveGraph(makeConfig({
      a: { requires: ['impossible'], provides: ['x'] },
    }), 'e1');

    expect(schedule(live).unresolved).toHaveLength(1);

    live = removeRequires(live, 'a', ['impossible']);
    const result = schedule(live);
    expect(result.eligible).toEqual(['a']);
    expect(result.unresolved).toEqual([]);
  });

  it('multiple unresolved tokens on one task', () => {
    const live = createLiveGraph(makeConfig({
      a: { requires: ['x', 'y', 'z'], provides: ['result'] },
    }), 'e1');

    const result = schedule(live);
    expect(result.unresolved).toEqual([{
      taskName: 'a',
      missingTokens: ['x', 'y', 'z'],
    }]);
  });

  it('mixed unresolved - unresolved takes precedence over pending', () => {
    // If a task has BOTH unresolved and pending tokens, it should be classified as unresolved
    const live = createLiveGraph(makeConfig({
      producer: { provides: ['x'] },
      mixed: { requires: ['x', 'ghost'], provides: ['out'] },
    }), 'e1');

    const result = schedule(live);
    expect(result.unresolved).toEqual([{
      taskName: 'mixed',
      missingTokens: ['ghost'],
    }]);
    // Should NOT appear in pending
    expect(result.pending.find(p => p.taskName === 'mixed')).toBeUndefined();
  });
});

// ============================================================================
// resetNode
// ============================================================================

describe('resetNode', () => {
  it('resets a failed task back to not-started', () => {
    let live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }), 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });
    live = applyEvent(live, { type: 'task-failed', taskName: 'a', error: 'boom', timestamp: ts() });

    expect(live.state.tasks['a'].status).toBe('failed');
    expect(live.state.tasks['a'].error).toBe('boom');

    live = resetNode(live, 'a');
    expect(live.state.tasks['a'].status).toBe('not-started');
    expect(live.state.tasks['a'].error).toBeUndefined();
    expect(live.state.tasks['a'].executionCount).toBe(0);
    expect(live.state.tasks['a'].retryCount).toBe(0);
  });

  it('resets a completed task', () => {
    let live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }), 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'a', timestamp: ts() });

    live = resetNode(live, 'a');
    expect(live.state.tasks['a'].status).toBe('not-started');
    expect(live.state.tasks['a'].executionCount).toBe(0);
  });

  it('does not touch config', () => {
    let live = createLiveGraph(makeConfig({ a: { requires: ['dep'], provides: ['x'] } }), 'e1');
    const configRef = live.config;
    live = resetNode(live, 'a');
    expect(live.config).toBe(configRef);
  });

  it('returns unchanged for non-existent node', () => {
    const live = createLiveGraph(makeConfig({}), 'e1');
    expect(resetNode(live, 'ghost')).toBe(live);
  });

  it('makes a failed task eligible again after reset', () => {
    let live = createLiveGraph(makeConfig({
      producer: { provides: ['data'] },
      consumer: { requires: ['data'], provides: ['result'] },
    }), 'e1');

    // Run and fail producer
    live = applyEvent(live, { type: 'task-started', taskName: 'producer', timestamp: ts() });
    live = applyEvent(live, { type: 'task-failed', taskName: 'producer', error: 'err', timestamp: ts() });

    expect(schedule(live).blocked).toHaveLength(1);

    // Reset it
    live = resetNode(live, 'producer');
    const result = schedule(live);
    expect(result.eligible).toContain('producer');
    expect(result.blocked).toEqual([]);
  });
});

// ============================================================================
// disableNode / enableNode
// ============================================================================

describe('disableNode / enableNode', () => {
  it('disables a not-started node', () => {
    let live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }), 'e1');
    live = disableNode(live, 'a');

    expect(live.state.tasks['a'].status).toBe('inactivated');
  });

  it('disabled node is skipped by schedule', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { provides: ['y'] },
    }), 'e1');
    live = disableNode(live, 'a');

    const result = schedule(live);
    expect(result.eligible).toEqual(['b']);
    expect(result.eligible).not.toContain('a');
  });

  it('enableNode re-enables a disabled node', () => {
    let live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }), 'e1');
    live = disableNode(live, 'a');
    expect(live.state.tasks['a'].status).toBe('inactivated');

    live = enableNode(live, 'a');
    expect(live.state.tasks['a'].status).toBe('not-started');

    // Now eligible again
    expect(schedule(live).eligible).toContain('a');
  });

  it('enableNode only works on inactivated nodes', () => {
    let live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }), 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });

    // Running task — enableNode should be a no-op
    const next = enableNode(live, 'a');
    expect(next).toBe(live);
  });

  it('disableNode returns unchanged if already inactivated', () => {
    let live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }), 'e1');
    live = disableNode(live, 'a');
    const next = disableNode(live, 'a');
    expect(next).toBe(live);
  });

  it('disableNode returns unchanged for non-existent node', () => {
    const live = createLiveGraph(makeConfig({}), 'e1');
    expect(disableNode(live, 'ghost')).toBe(live);
  });

  it('disabled node does not count as failed producer (blocked)', () => {
    let live = createLiveGraph(makeConfig({
      producer: { provides: ['data'] },
      consumer: { requires: ['data'], provides: ['result'] },
    }), 'e1');
    live = disableNode(live, 'producer');

    const result = schedule(live);
    // Producer is inactivated — consumer should be blocked (producer is non-active)
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0].taskName).toBe('consumer');
  });

  it('inspect counts disabled nodes', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { provides: ['y'] },
      c: { provides: ['z'] },
    }), 'e1');
    live = disableNode(live, 'a');
    live = disableNode(live, 'b');

    const health = inspect(live);
    expect(health.disabled).toBe(2);
    expect(health.notStarted).toBe(1);
  });
});

// ============================================================================
// getNode
// ============================================================================

describe('getNode', () => {
  it('returns config and state for an existing node', () => {
    let live = createLiveGraph(makeConfig({
      a: { requires: ['dep'], provides: ['x'] },
    }), 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });

    const node = getNode(live, 'a');
    expect(node).toBeDefined();
    expect(node!.name).toBe('a');
    expect(node!.config.provides).toEqual(['x']);
    expect(node!.config.requires).toEqual(['dep']);
    expect(node!.state.status).toBe('running');
  });

  it('returns undefined for non-existent node', () => {
    const live = createLiveGraph(makeConfig({}), 'e1');
    expect(getNode(live, 'ghost')).toBeUndefined();
  });

  it('returns default state for node with no state entry', () => {
    let live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }), 'e1');
    // Manually remove state entry to simulate edge case
    const { a: _, ...rest } = live.state.tasks;
    live = { ...live, state: { ...live.state, tasks: rest } };

    const node = getNode(live, 'a');
    expect(node).toBeDefined();
    expect(node!.state.status).toBe('not-started');
  });
});

// ============================================================================
// snapshot / restore
// ============================================================================

describe('snapshot / restore', () => {
  it('round-trips a LiveGraph', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    }), 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'a', timestamp: ts() });

    const snap = snapshot(live);
    expect(snap.version).toBe(1);
    expect(snap.snapshotAt).toBeDefined();

    // Serialize and deserialize (simulates file persistence)
    const json = JSON.stringify(snap);
    const restored = restore(JSON.parse(json));

    expect(restored.config).toEqual(live.config);
    expect(restored.state.tasks['a'].status).toBe('completed');
    expect(restored.state.availableOutputs).toContain('x');
    expect(restored.state.executionId).toBe('e1');
  });

  it('restored graph works with schedule', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    }), 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'a', timestamp: ts() });

    const snap = snapshot(live);
    const restored = restore(JSON.parse(JSON.stringify(snap)));

    const result = schedule(restored);
    expect(result.eligible).toEqual(['b']);
  });

  it('restore validates shape — missing config', () => {
    expect(() => restore({ state: {} })).toThrow('config');
  });

  it('restore validates shape — missing state', () => {
    expect(() => restore({ config: { settings: {}, tasks: {} } })).toThrow('state');
  });

  it('restore validates shape — null', () => {
    expect(() => restore(null)).toThrow('expected an object');
  });

  it('restore validates shape — missing tasks', () => {
    expect(() => restore({
      config: { settings: {} },
      state: { tasks: {}, availableOutputs: [] },
    })).toThrow('config.tasks');
  });

  it('restore validates shape — availableOutputs not array', () => {
    expect(() => restore({
      config: { settings: {}, tasks: {} },
      state: { tasks: {}, availableOutputs: 'wrong' },
    })).toThrow('availableOutputs');
  });

  it('snapshot preserves dynamically added nodes', () => {
    let live = createLiveGraph(makeConfig({ a: { provides: ['x'] } }), 'e1');
    live = addNode(live, 'dynamic', { requires: ['x'], provides: ['y'] });
    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'a', timestamp: ts() });

    const snap = snapshot(live);
    const restored = restore(JSON.parse(JSON.stringify(snap)));

    expect(restored.config.tasks['dynamic']).toBeDefined();
    expect(schedule(restored).eligible).toContain('dynamic');
  });
});

// ============================================================================
// getUnreachableTokens
// ============================================================================

describe('getUnreachableTokens', () => {
  it('detects tokens with no producer', () => {
    const live = createLiveGraph(makeConfig({
      a: { requires: ['ghost'], provides: ['x'] },
    }), 'e1');

    const result = getUnreachableTokens(live);
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].token).toBe('ghost');
    expect(result.tokens[0].reason).toBe('no-producer');
    expect(result.tokens[0].producers).toEqual([]);
  });

  it('detects tokens where all producers have failed', () => {
    let live = createLiveGraph(makeConfig({
      producer: { provides: ['data'] },
      consumer: { requires: ['data'], provides: ['result'] },
    }), 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'producer', timestamp: ts() });
    live = applyEvent(live, { type: 'task-failed', taskName: 'producer', error: 'boom', timestamp: ts() });

    const result = getUnreachableTokens(live);
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].token).toBe('data');
    expect(result.tokens[0].reason).toBe('all-producers-failed');
    expect(result.tokens[0].producers).toEqual(['producer']);
  });

  it('detects transitive unreachability', () => {
    // ghost is missing → a can't produce x → b can't get x → y is unreachable
    const live = createLiveGraph(makeConfig({
      a: { requires: ['ghost'], provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
      c: { requires: ['y'], provides: ['z'] },
    }), 'e1');

    const result = getUnreachableTokens(live);
    const tokenNames = result.tokens.map(t => t.token).sort();
    expect(tokenNames).toEqual(['ghost', 'x', 'y']);

    const ghostEntry = result.tokens.find(t => t.token === 'ghost')!;
    expect(ghostEntry.reason).toBe('no-producer');

    const xEntry = result.tokens.find(t => t.token === 'x')!;
    expect(xEntry.reason).toBe('transitive');

    const yEntry = result.tokens.find(t => t.token === 'y')!;
    expect(yEntry.reason).toBe('transitive');
  });

  it('returns empty for a fully connected graph', () => {
    const live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    }), 'e1');

    expect(getUnreachableTokens(live).tokens).toEqual([]);
  });

  it('does not flag tokens already in availableOutputs', () => {
    let live = createLiveGraph(makeConfig({
      a: { requires: ['external'], provides: ['x'] },
    }), 'e1');
    live = injectTokens(live, ['external']);

    expect(getUnreachableTokens(live).tokens).toEqual([]);
  });

  it('does not flag tokens produced by completed tasks', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    }), 'e1');
    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'a', timestamp: ts() });

    expect(getUnreachableTokens(live).tokens).toEqual([]);
  });

  it('handles disabled producer as unreachable', () => {
    let live = createLiveGraph(makeConfig({
      producer: { provides: ['data'] },
      consumer: { requires: ['data'], provides: ['out'] },
    }), 'e1');
    live = disableNode(live, 'producer');

    const result = getUnreachableTokens(live);
    expect(result.tokens).toHaveLength(1);
    expect(result.tokens[0].token).toBe('data');
    expect(result.tokens[0].reason).toBe('all-producers-failed');
  });

  it('token is reachable if at least one producer is viable', () => {
    let live = createLiveGraph(makeConfig({
      producer_a: { provides: ['data'] },
      producer_b: { provides: ['data'] },
      consumer: { requires: ['data'], provides: ['out'] },
    }), 'e1');
    // Fail one but not the other
    live = applyEvent(live, { type: 'task-started', taskName: 'producer_a', timestamp: ts() });
    live = applyEvent(live, { type: 'task-failed', taskName: 'producer_a', error: 'err', timestamp: ts() });

    expect(getUnreachableTokens(live).tokens).toEqual([]);
  });
});

// ============================================================================
// getUnreachableNodes
// ============================================================================

describe('getUnreachableNodes', () => {
  it('detects nodes with unreachable requires', () => {
    const live = createLiveGraph(makeConfig({
      a: { requires: ['ghost'], provides: ['x'] },
      b: { provides: ['y'] },
    }), 'e1');

    const result = getUnreachableNodes(live);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].nodeName).toBe('a');
    expect(result.nodes[0].missingTokens).toEqual(['ghost']);
  });

  it('detects transitive unreachable nodes', () => {
    const live = createLiveGraph(makeConfig({
      a: { requires: ['ghost'], provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
      c: { requires: ['y'], provides: ['z'] },
    }), 'e1');

    const result = getUnreachableNodes(live);
    const nodeNames = result.nodes.map(n => n.nodeName).sort();
    expect(nodeNames).toEqual(['a', 'b', 'c']);
  });

  it('includes failed/disabled nodes', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { provides: ['y'] },
    }), 'e1');
    live = disableNode(live, 'a');

    const result = getUnreachableNodes(live);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].nodeName).toBe('a');
    expect(result.nodes[0].missingTokens).toEqual([]);
  });

  it('returns empty for a fully reachable graph', () => {
    const live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    }), 'e1');

    expect(getUnreachableNodes(live).nodes).toEqual([]);
  });

  it('skips completed nodes', () => {
    let live = createLiveGraph(makeConfig({
      a: { requires: ['ghost'], provides: ['x'] },
    }), 'e1');
    // Manually mark completed (e.g. from a restored snapshot)
    live = applyEvent(live, { type: 'task-started', taskName: 'a', timestamp: ts() });
    live = applyEvent(live, { type: 'task-completed', taskName: 'a', timestamp: ts() });

    expect(getUnreachableNodes(live).nodes).toEqual([]);
  });

  it('resolves after adding missing producer', () => {
    let live = createLiveGraph(makeConfig({
      consumer: { requires: ['data'], provides: ['result'] },
    }), 'e1');

    expect(getUnreachableNodes(live).nodes).toHaveLength(1);

    live = addNode(live, 'producer', { provides: ['data'] });
    expect(getUnreachableNodes(live).nodes).toEqual([]);
  });

  it('resolves after injecting missing token', () => {
    let live = createLiveGraph(makeConfig({
      consumer: { requires: ['signal'], provides: ['result'] },
    }), 'e1');

    expect(getUnreachableNodes(live).nodes).toHaveLength(1);

    live = injectTokens(live, ['signal']);
    expect(getUnreachableNodes(live).nodes).toEqual([]);
  });
});

// ============================================================================
// drainTokens
// ============================================================================

describe('drainTokens', () => {
  it('removes specified tokens from availableOutputs', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x', 'y'] },
    }), 'e1');
    live = injectTokens(live, ['x', 'y', 'z']);

    const drained = drainTokens(live, ['x', 'z']);
    expect(drained.state.availableOutputs).toEqual(['y']);
  });

  it('returns unchanged if no tokens match', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
    }), 'e1');
    live = injectTokens(live, ['x']);

    const drained = drainTokens(live, ['not-there']);
    expect(drained).toBe(live); // reference equality — no change
  });

  it('silently ignores tokens not in availableOutputs', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x', 'y'] },
    }), 'e1');
    live = injectTokens(live, ['x', 'y']);

    const drained = drainTokens(live, ['x', 'ghost']);
    expect(drained.state.availableOutputs).toEqual(['y']);
  });

  it('drains all tokens when all are specified', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
    }), 'e1');
    live = injectTokens(live, ['x', 'y']);

    const drained = drainTokens(live, ['x', 'y']);
    expect(drained.state.availableOutputs).toEqual([]);
  });

  it('does not mutate config', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
    }), 'e1');
    live = injectTokens(live, ['x']);

    const drained = drainTokens(live, ['x']);
    expect(drained.config).toBe(live.config);
  });

  it('makes previously eligible tasks pending again', () => {
    let live = createLiveGraph(makeConfig({
      a: { provides: ['data'] },
      b: { requires: ['data'], provides: ['result'] },
    }), 'e1');
    live = injectTokens(live, ['data']);

    // b should be eligible with data available
    expect(schedule(live).eligible).toContain('b');

    // Drain data — b should no longer be eligible
    live = drainTokens(live, ['data']);
    expect(schedule(live).eligible).not.toContain('b');
  });
});

// ============================================================================
// getUpstream
// ============================================================================

describe('getUpstream', () => {
  it('returns direct upstream nodes', () => {
    const live = createLiveGraph(makeConfig({
      fetch: { provides: ['data'] },
      process: { requires: ['data'], provides: ['result'] },
    }), 'e1');

    const result = getUpstream(live, 'process');
    expect(result.nodeName).toBe('process');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].nodeName).toBe('fetch');
    expect(result.nodes[0].providesTokens).toEqual(['data']);
    expect(result.tokens).toEqual(['data']);
  });

  it('returns transitive upstream through a chain', () => {
    const live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
      c: { requires: ['y'], provides: ['z'] },
    }), 'e1');

    const result = getUpstream(live, 'c');
    const nodeNames = result.nodes.map(n => n.nodeName).sort();
    expect(nodeNames).toEqual(['a', 'b']);
    expect(result.tokens.sort()).toEqual(['x', 'y']);
  });

  it('returns empty for a root node (no requires)', () => {
    const live = createLiveGraph(makeConfig({
      root: { provides: ['data'] },
      child: { requires: ['data'], provides: ['result'] },
    }), 'e1');

    const result = getUpstream(live, 'root');
    expect(result.nodes).toEqual([]);
    expect(result.tokens).toEqual([]);
  });

  it('returns empty for unknown node', () => {
    const live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
    }), 'e1');

    const result = getUpstream(live, 'nonexistent');
    expect(result.nodes).toEqual([]);
    expect(result.tokens).toEqual([]);
  });

  it('handles diamond dependencies', () => {
    const live = createLiveGraph(makeConfig({
      source: { provides: ['raw'] },
      left: { requires: ['raw'], provides: ['left-out'] },
      right: { requires: ['raw'], provides: ['right-out'] },
      merge: { requires: ['left-out', 'right-out'], provides: ['merged'] },
    }), 'e1');

    const result = getUpstream(live, 'merge');
    const nodeNames = result.nodes.map(n => n.nodeName).sort();
    expect(nodeNames).toEqual(['left', 'right', 'source']);
    expect(result.tokens.sort()).toEqual(['left-out', 'raw', 'right-out']);
  });

  it('handles cycles without infinite loops', () => {
    const live = createLiveGraph(makeConfig({
      a: { requires: ['y'], provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    }), 'e1');

    const result = getUpstream(live, 'a');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].nodeName).toBe('b');
  });

  it('does not include the target node itself', () => {
    const live = createLiveGraph(makeConfig({
      self: { requires: ['x'], provides: ['x'] },
      feeder: { provides: ['x'] },
    }), 'e1');

    const result = getUpstream(live, 'self');
    const nodeNames = result.nodes.map(n => n.nodeName);
    expect(nodeNames).not.toContain('self');
    expect(nodeNames).toContain('feeder');
  });
});

// ============================================================================
// getDownstream
// ============================================================================

describe('getDownstream', () => {
  it('returns direct downstream nodes', () => {
    const live = createLiveGraph(makeConfig({
      fetch: { provides: ['data'] },
      process: { requires: ['data'], provides: ['result'] },
    }), 'e1');

    const result = getDownstream(live, 'fetch');
    expect(result.nodeName).toBe('fetch');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].nodeName).toBe('process');
    expect(result.nodes[0].requiresTokens).toEqual(['data']);
    expect(result.tokens).toEqual(['data']);
  });

  it('returns transitive downstream through a chain', () => {
    const live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
      c: { requires: ['y'], provides: ['z'] },
    }), 'e1');

    const result = getDownstream(live, 'a');
    const nodeNames = result.nodes.map(n => n.nodeName).sort();
    expect(nodeNames).toEqual(['b', 'c']);
    expect(result.tokens.sort()).toEqual(['x', 'y']);
  });

  it('returns empty for a leaf node (no downstream consumers)', () => {
    const live = createLiveGraph(makeConfig({
      source: { provides: ['data'] },
      sink: { requires: ['data'] },
    }), 'e1');

    const result = getDownstream(live, 'sink');
    expect(result.nodes).toEqual([]);
    expect(result.tokens).toEqual([]);
  });

  it('returns empty for unknown node', () => {
    const live = createLiveGraph(makeConfig({
      a: { provides: ['x'] },
    }), 'e1');

    const result = getDownstream(live, 'nonexistent');
    expect(result.nodes).toEqual([]);
    expect(result.tokens).toEqual([]);
  });

  it('handles fan-out: one node feeds multiple consumers', () => {
    const live = createLiveGraph(makeConfig({
      source: { provides: ['data'] },
      consumer1: { requires: ['data'], provides: ['r1'] },
      consumer2: { requires: ['data'], provides: ['r2'] },
      consumer3: { requires: ['data'], provides: ['r3'] },
    }), 'e1');

    const result = getDownstream(live, 'source');
    expect(result.nodes).toHaveLength(3);
    const nodeNames = result.nodes.map(n => n.nodeName).sort();
    expect(nodeNames).toEqual(['consumer1', 'consumer2', 'consumer3']);
  });

  it('handles diamond downstream', () => {
    const live = createLiveGraph(makeConfig({
      source: { provides: ['raw'] },
      left: { requires: ['raw'], provides: ['left-out'] },
      right: { requires: ['raw'], provides: ['right-out'] },
      merge: { requires: ['left-out', 'right-out'], provides: ['done'] },
    }), 'e1');

    const result = getDownstream(live, 'source');
    const nodeNames = result.nodes.map(n => n.nodeName).sort();
    expect(nodeNames).toEqual(['left', 'merge', 'right']);
  });

  it('handles cycles without infinite loops', () => {
    const live = createLiveGraph(makeConfig({
      a: { requires: ['y'], provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    }), 'e1');

    const result = getDownstream(live, 'a');
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].nodeName).toBe('b');
  });

  it('does not include the target node itself', () => {
    const live = createLiveGraph(makeConfig({
      self: { requires: ['x'], provides: ['x'] },
      consumer: { requires: ['x'], provides: ['done'] },
    }), 'e1');

    const result = getDownstream(live, 'self');
    const nodeNames = result.nodes.map(n => n.nodeName);
    expect(nodeNames).not.toContain('self');
    expect(nodeNames).toContain('consumer');
  });

  it('reflects dynamic graph changes', () => {
    let live = createLiveGraph(makeConfig({
      source: { provides: ['data'] },
    }), 'e1');

    // Initially no downstream
    expect(getDownstream(live, 'source').nodes).toEqual([]);

    // Add a consumer dynamically
    live = addNode(live, 'consumer', { requires: ['data'], provides: ['result'] });
    expect(getDownstream(live, 'source').nodes).toHaveLength(1);
    expect(getDownstream(live, 'source').nodes[0].nodeName).toBe('consumer');
  });
});
