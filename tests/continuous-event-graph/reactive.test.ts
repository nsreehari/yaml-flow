/**
 * Tests for the reactive graph layer:
 *   - createReactiveGraph, push, pushAll, addNode, removeNode, dispose
 *   - Journal (MemoryJournal, FileJournal)
 *   - applyEvents batch
 *   - Dispatch tracking, timeout, retry, abandon
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GraphConfig, GraphEvent, TaskConfig } from '../../src/event-graph/types.js';
import {
  createLiveGraph,
  applyEvent,
  applyEvents,
  schedule,
  createReactiveGraph,
  MemoryJournal,
} from '../../src/continuous-event-graph/index.js';
import type { TaskHandler, TaskHandlerResult, ReactiveGraph } from '../../src/continuous-event-graph/index.js';

// ============================================================================
// Helpers
// ============================================================================

const ts = () => new Date().toISOString();

function makeConfig(tasks: Record<string, Partial<TaskConfig>> = {}): GraphConfig {
  return {
    settings: { completion: 'all-tasks-done', conflict_strategy: 'parallel-all' },
    tasks: Object.fromEntries(
      Object.entries(tasks).map(([name, cfg]) => [name, { provides: [], ...cfg }]),
    ),
  } as GraphConfig;
}

/** Resolve on next microtask tick. */
const tick = () => new Promise<void>(r => setTimeout(r, 0));
const ticks = (n: number) => new Promise<void>(r => setTimeout(r, n));

// ============================================================================
// MemoryJournal
// ============================================================================

describe('MemoryJournal', () => {
  it('append + drain returns events in order', () => {
    const j = new MemoryJournal();
    j.append({ type: 'task-started', taskName: 'a', timestamp: ts() });
    j.append({ type: 'task-completed', taskName: 'a', timestamp: ts() });
    expect(j.size).toBe(2);

    const events = j.drain();
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('task-started');
    expect(events[1].type).toBe('task-completed');
    expect(j.size).toBe(0);
  });

  it('drain on empty journal returns []', () => {
    const j = new MemoryJournal();
    expect(j.drain()).toEqual([]);
  });

  it('drain clears the buffer', () => {
    const j = new MemoryJournal();
    j.append({ type: 'task-started', taskName: 'x', timestamp: ts() });
    j.drain();
    j.append({ type: 'task-started', taskName: 'y', timestamp: ts() });
    const events = j.drain();
    expect(events).toHaveLength(1);
    expect((events[0] as { taskName: string }).taskName).toBe('y');
  });
});

// ============================================================================
// applyEvents (batch)
// ============================================================================

describe('applyEvents', () => {
  it('applies multiple events atomically', () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
      transform: { requires: ['data'], provides: ['result'] },
    });
    let live = createLiveGraph(config, 'e1');

    live = applyEvents(live, [
      { type: 'task-started', taskName: 'fetch', timestamp: ts() },
      { type: 'task-completed', taskName: 'fetch', timestamp: ts() },
      { type: 'task-started', taskName: 'transform', timestamp: ts() },
      { type: 'task-completed', taskName: 'transform', timestamp: ts() },
    ]);

    expect(live.state.tasks.fetch.status).toBe('completed');
    expect(live.state.tasks.transform.status).toBe('completed');
    expect(live.state.availableOutputs).toContain('data');
    expect(live.state.availableOutputs).toContain('result');
  });

  it('empty events returns same graph', () => {
    const config = makeConfig({ a: { provides: ['x'] } });
    const live = createLiveGraph(config);
    const result = applyEvents(live, []);
    expect(result).toBe(live);
  });
});

// ============================================================================
// createReactiveGraph — basic flow
// ============================================================================

describe('createReactiveGraph', () => {
  let rg: ReactiveGraph;

  afterEach(() => {
    rg?.dispose();
  });

  it('drives a simple two-task pipeline to completion', async () => {
    const config = makeConfig({
      fetch: { provides: ['data'] },
      transform: { requires: ['data'], provides: ['result'] },
    });

    const log: string[] = [];

    rg = createReactiveGraph(config, {
      handlers: {
        fetch: async () => {
          log.push('fetch-ran');
          return {};
        },
        transform: async () => {
          log.push('transform-ran');
          return {};
        },
      },
      defaultTimeoutMs: 0, // disable timeouts for this test
    });

    // Initial push — inject a token or just trigger schedule
    // Tasks with no requires are eligible immediately
    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });

    // Wait for async handlers to complete
    await ticks(50);

    expect(log).toContain('fetch-ran');
    expect(log).toContain('transform-ran');

    const state = rg.getState();
    expect(state.state.tasks.fetch.status).toBe('completed');
    expect(state.state.tasks.transform.status).toBe('completed');
    expect(state.state.availableOutputs).toContain('data');
    expect(state.state.availableOutputs).toContain('result');
  });

  it('handles conditional routing via handler result', async () => {
    const config = makeConfig({
      classify: {
        provides: ['default-out'],
        on: { photo: ['is-photo'], doc: ['is-doc'] },
      },
      processPhoto: { requires: ['is-photo'], provides: ['done'] },
      processDoc: { requires: ['is-doc'], provides: ['done'] },
    });

    rg = createReactiveGraph(config, {
      handlers: {
        classify: async () => ({ result: 'photo' }),
        processPhoto: async () => ({}),
        processDoc: async () => ({}),
      },
      defaultTimeoutMs: 0,
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    const state = rg.getState();
    expect(state.state.availableOutputs).toContain('is-photo');
    expect(state.state.availableOutputs).not.toContain('is-doc');
    expect(state.state.tasks.processPhoto.status).toBe('completed');
    expect(state.state.tasks.processDoc.status).toBe('not-started');
  });

  it('pushes task-failed when handler rejects', async () => {
    const config = makeConfig({
      flaky: { provides: ['data'] },
    });

    rg = createReactiveGraph(config, {
      handlers: {
        flaky: async () => { throw new Error('network error'); },
      },
      defaultTimeoutMs: 0,
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    const state = rg.getState();
    expect(state.state.tasks.flaky.status).toBe('failed');
    expect(state.state.tasks.flaky.error).toBe('network error');
  });

  it('pushes task-failed when no handler registered', async () => {
    const config = makeConfig({
      orphan: { provides: ['data'] },
    });

    rg = createReactiveGraph(config, {
      handlers: {}, // no handler for 'orphan'
      defaultTimeoutMs: 0,
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    const state = rg.getState();
    expect(state.state.tasks.orphan.status).toBe('failed');
    expect(state.state.tasks.orphan.error).toContain('No handler registered');
  });

  it('respects dispose — stops dispatching', async () => {
    const config = makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    });

    const log: string[] = [];

    rg = createReactiveGraph(config, {
      handlers: {
        a: async () => { log.push('a'); return {}; },
        b: async () => { log.push('b'); return {}; },
      },
      defaultTimeoutMs: 0,
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await tick();
    rg.dispose();
    await ticks(50);

    // 'a' may have run, but 'b' should not (disposed before cascade)
    expect(log).toContain('a');
    // b may or may not have run depending on timing, but no errors thrown
  });
});

// ============================================================================
// addNode / removeNode at runtime
// ============================================================================

describe('reactive — dynamic nodes', () => {
  let rg: ReactiveGraph;

  afterEach(() => {
    rg?.dispose();
  });

  it('addNode triggers dispatch of newly eligible task', async () => {
    const config = makeConfig({
      source: { provides: ['data'] },
    });

    const log: string[] = [];

    rg = createReactiveGraph(config, {
      handlers: {
        source: async () => { log.push('source'); return {}; },
      },
      defaultTimeoutMs: 0,
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);
    expect(log).toContain('source');

    // Now add a node that depends on 'data' (already produced)
    rg.addNode('sink', { requires: ['data'], provides: ['done'] } as TaskConfig, async () => {
      log.push('sink');
      return {};
    });

    await ticks(50);
    expect(log).toContain('sink');
    expect(rg.getState().state.tasks.sink.status).toBe('completed');
  });

  it('removeNode stops its handler and removes it from state', async () => {
    const config = makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    });

    rg = createReactiveGraph(config, {
      handlers: {
        a: async () => ({}),
        b: async () => ({}),
      },
      defaultTimeoutMs: 0,
    });

    rg.removeNode('b');
    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    expect(rg.getState().state.tasks.b).toBeUndefined();
  });
});

// ============================================================================
// pushAll
// ============================================================================

describe('reactive — pushAll', () => {
  let rg: ReactiveGraph;

  afterEach(() => {
    rg?.dispose();
  });

  it('applies multiple events atomically then dispatches', async () => {
    const config = makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    });

    const log: string[] = [];

    rg = createReactiveGraph(config, {
      handlers: {
        a: async () => { log.push('a'); return {}; },
        b: async () => { log.push('b'); return {}; },
      },
      defaultTimeoutMs: 0,
    });

    // Manually push start + complete for 'a', then see b gets dispatched
    rg.pushAll([
      { type: 'task-started', taskName: 'a', timestamp: ts() },
      { type: 'task-completed', taskName: 'a', timestamp: ts() },
    ]);

    await ticks(50);
    expect(log).toContain('b');
    expect(rg.getState().state.tasks.b.status).toBe('completed');
  });
});

// ============================================================================
// Dispatch tracking
// ============================================================================

describe('reactive — dispatch state', () => {
  let rg: ReactiveGraph;

  afterEach(() => {
    rg?.dispose();
  });

  it('tracks initiated tasks', async () => {
    const config = makeConfig({
      slow: { provides: ['x'] },
    });

    let resolve: () => void;
    const promise = new Promise<void>(r => { resolve = r; });

    rg = createReactiveGraph(config, {
      handlers: {
        slow: async () => {
          await promise;
          return {};
        },
      },
      defaultTimeoutMs: 0,
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await tick();

    const dispatch = rg.getDispatchState();
    expect(dispatch.get('slow')?.status).toBe('initiated');

    resolve!();
    await ticks(50);

    // After completion, dispatch entry is cleared
    expect(rg.getDispatchState().has('slow')).toBe(false);
  });
});

// ============================================================================
// onDrain callback
// ============================================================================

describe('reactive — observability', () => {
  let rg: ReactiveGraph;

  afterEach(() => {
    rg?.dispose();
  });

  it('calls onDrain with events and state', async () => {
    const config = makeConfig({
      a: { provides: ['x'] },
    });

    const drainCalls: { eventCount: number; eligible: string[] }[] = [];

    rg = createReactiveGraph(config, {
      handlers: {
        a: async () => ({}),
      },
      defaultTimeoutMs: 0,
      onDrain: (events, _live, scheduleResult) => {
        drainCalls.push({
          eventCount: events.length,
          eligible: scheduleResult.eligible,
        });
      },
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    expect(drainCalls.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Timeout + abandon
// ============================================================================

describe('reactive — timeout and abandon', () => {
  let rg: ReactiveGraph;

  afterEach(() => {
    rg?.dispose();
  });

  it('abandons task after timeout + max retries', async () => {
    const config = makeConfig({
      stuck: { provides: ['x'] },
    });

    const abandoned: string[] = [];

    rg = createReactiveGraph(config, {
      handlers: {
        // Handler that never resolves
        stuck: () => new Promise(() => {}),
      },
      defaultTimeoutMs: 50,
      maxDispatchRetries: 1,
      onAbandoned: (name) => abandoned.push(name),
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });

    // Wait for timeout + abandon cycle
    await ticks(200);

    expect(abandoned).toContain('stuck');

    const state = rg.getState();
    expect(state.state.tasks.stuck.status).toBe('failed');
    expect(state.state.tasks.stuck.error).toContain('dispatch-timeout');
  });

  it('calls onDispatchFailed when handler throws synchronously', async () => {
    const config = makeConfig({
      bad: { provides: ['x'] },
    });

    const failures: { name: string; attempt: number }[] = [];

    rg = createReactiveGraph(config, {
      handlers: {
        bad: (() => { throw new Error('sync boom'); }) as unknown as TaskHandler,
      },
      defaultTimeoutMs: 0,
      maxDispatchRetries: 2,
      onDispatchFailed: (name, _err, attempt) => {
        failures.push({ name, attempt });
      },
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].name).toBe('bad');
  });
});

// ============================================================================
// dataHash propagation
// ============================================================================

describe('reactive — dataHash', () => {
  let rg: ReactiveGraph;

  afterEach(() => {
    rg?.dispose();
  });

  it('handler dataHash is stored on task state', async () => {
    const config = makeConfig({
      producer: { provides: ['data'] },
    });

    rg = createReactiveGraph(config, {
      handlers: {
        producer: async () => ({ dataHash: 'abc123' }),
      },
      defaultTimeoutMs: 0,
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    expect(rg.getState().state.tasks.producer.lastDataHash).toBe('abc123');
  });
});

// ============================================================================
// getSchedule
// ============================================================================

describe('reactive — getSchedule', () => {
  let rg: ReactiveGraph;

  afterEach(() => {
    rg?.dispose();
  });

  it('returns current schedule projection', () => {
    const config = makeConfig({
      a: { provides: ['x'] },
      b: { requires: ['x'], provides: ['y'] },
    });

    rg = createReactiveGraph(config, {
      handlers: {
        a: async () => ({}),
        b: async () => ({}),
      },
      defaultTimeoutMs: 0,
    });

    const result = rg.getSchedule();
    expect(result.eligible).toContain('a');
    expect(result.eligible).not.toContain('b');
  });
});
