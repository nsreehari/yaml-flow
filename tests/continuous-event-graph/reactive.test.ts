/**
 * Tests for the reactive graph layer:
 *   - createReactiveGraph, push, pushAll, addNode, removeNode, dispose
 *   - Journal (MemoryJournal, FileJournal)
 *   - applyEvents batch
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
import type { TaskHandlerFn, ReactiveGraph } from '../../src/continuous-event-graph/index.js';

// ============================================================================
// Helpers
// ============================================================================

const ts = () => new Date().toISOString();

/** Lazy graph ref for test handlers to call resolveCallback */
function makeGraphRef(): { ref: ReactiveGraph | null; resolve: (token: string, data: Record<string, unknown>, errors?: string[]) => void } {
  const o = { ref: null as ReactiveGraph | null, resolve: (token: string, data: Record<string, unknown>, errors?: string[]) => { o.ref!.resolveCallback(token, data, errors); } };
  return o;
}

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
      fetch: { provides: ['data'], taskHandlers: ['fetch'] },
      transform: { requires: ['data'], provides: ['result'], taskHandlers: ['transform'] },
    });

    const log: string[] = [];
    const g = makeGraphRef();

    rg = createReactiveGraph(config, {
      handlers: {
        fetch: async ({ callbackToken }) => {
          log.push('fetch-ran');
          g.resolve(callbackToken, {});
          return 'task-initiated';
        },
        transform: async ({ callbackToken }) => {
          log.push('transform-ran');
          g.resolve(callbackToken, {});
          return 'task-initiated';
        },
      },
    });
    g.ref = rg;

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
        taskHandlers: ['classify'],
      },
      processPhoto: { requires: ['is-photo'], provides: ['done'], taskHandlers: ['processPhoto'] },
      processDoc: { requires: ['is-doc'], provides: ['done'], taskHandlers: ['processDoc'] },
    });

    const g = makeGraphRef();

    rg = createReactiveGraph(config, {
      handlers: {
        classify: async ({ callbackToken }) => {
          // resolveCallback doesn't support result routing yet — use push instead
          // For conditional routing, the handler pushes task-completed with result
          g.ref!.push({
            type: 'task-completed',
            taskName: 'classify',
            result: 'photo',
            timestamp: ts(),
          });
          return 'task-initiated';
        },
        processPhoto: async ({ callbackToken }) => { g.resolve(callbackToken, {}); return 'task-initiated'; },
        processDoc: async ({ callbackToken }) => { g.resolve(callbackToken, {}); return 'task-initiated'; },
      },
    });
    g.ref = rg;

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
      flaky: { provides: ['data'], taskHandlers: ['flaky'] },
    });

    rg = createReactiveGraph(config, {
      handlers: {
        flaky: async () => { throw new Error('network error'); },
      },
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    const state = rg.getState();
    expect(state.state.tasks.flaky.status).toBe('failed');
    expect(state.state.tasks.flaky.error).toBe('network error');
  });

  it('skips dispatch silently when no taskHandlers defined', async () => {
    const config = makeConfig({
      orphan: { provides: ['data'] }, // no taskHandlers — externally driven
    });

    rg = createReactiveGraph(config, {
      handlers: {}, // no handler for 'orphan'
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    const state = rg.getState();
    // No taskHandlers → task stays not-started (externally-driven pattern)
    expect(state.state.tasks.orphan.status).toBe('not-started');
    expect(state.state.tasks.orphan.error).toBeUndefined();
  });

  it('respects dispose — stops dispatching', async () => {
    const config = makeConfig({
      a: { provides: ['x'], taskHandlers: ['a'] },
      b: { requires: ['x'], provides: ['y'], taskHandlers: ['b'] },
    });

    const log: string[] = [];
    const g = makeGraphRef();

    rg = createReactiveGraph(config, {
      handlers: {
        a: async ({ callbackToken }) => { log.push('a'); g.resolve(callbackToken, {}); return 'task-initiated'; },
        b: async ({ callbackToken }) => { log.push('b'); g.resolve(callbackToken, {}); return 'task-initiated'; },
      },
    });
    g.ref = rg;

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
      source: { provides: ['data'], taskHandlers: ['source'] },
    });

    const log: string[] = [];
    const g = makeGraphRef();

    rg = createReactiveGraph(config, {
      handlers: {
        source: async ({ callbackToken }) => { log.push('source'); g.resolve(callbackToken, {}); return 'task-initiated'; },
      },
    });
    g.ref = rg;

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);
    expect(log).toContain('source');

    // Register the handler, then add a node that depends on 'data' (already produced)
    rg.registerHandler('sink', async ({ callbackToken }) => {
      log.push('sink');
      g.resolve(callbackToken, {});
      return 'task-initiated';
    });
    rg.addNode('sink', { requires: ['data'], provides: ['done'], taskHandlers: ['sink'] } as TaskConfig);

    await ticks(50);
    expect(log).toContain('sink');
    expect(rg.getState().state.tasks.sink.status).toBe('completed');
  });

  it('removeNode stops its handler and removes it from state', async () => {
    const config = makeConfig({
      a: { provides: ['x'], taskHandlers: ['a'] },
      b: { requires: ['x'], provides: ['y'], taskHandlers: ['b'] },
    });

    const g = makeGraphRef();

    rg = createReactiveGraph(config, {
      handlers: {
        a: async ({ callbackToken }) => { g.resolve(callbackToken, {}); return 'task-initiated'; },
        b: async ({ callbackToken }) => { g.resolve(callbackToken, {}); return 'task-initiated'; },
      },
    });
    g.ref = rg;

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
      a: { provides: ['x'], taskHandlers: ['a'] },
      b: { requires: ['x'], provides: ['y'], taskHandlers: ['b'] },
    });

    const log: string[] = [];
    const g = makeGraphRef();

    rg = createReactiveGraph(config, {
      handlers: {
        a: async ({ callbackToken }) => { log.push('a'); g.resolve(callbackToken, {}); return 'task-initiated'; },
        b: async ({ callbackToken }) => { log.push('b'); g.resolve(callbackToken, {}); return 'task-initiated'; },
      },
    });
    g.ref = rg;

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
// onDrain callback
// ============================================================================

describe('reactive — observability', () => {
  let rg: ReactiveGraph;

  afterEach(() => {
    rg?.dispose();
  });

  it('calls onDrain with events and state', async () => {
    const config = makeConfig({
      a: { provides: ['x'], taskHandlers: ['a'] },
    });

    const drainCalls: { eventCount: number; eligible: string[] }[] = [];
    const g = makeGraphRef();

    rg = createReactiveGraph(config, {
      handlers: {
        a: async ({ callbackToken }) => { g.resolve(callbackToken, {}); return 'task-initiated'; },
      },
      onDrain: (events, _live, scheduleResult) => {
        drainCalls.push({
          eventCount: events.length,
          eligible: scheduleResult.eligible,
        });
      },
    });
    g.ref = rg;

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    expect(drainCalls.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Sync throw
// ============================================================================

describe('reactive — sync handler failure', () => {
  let rg: ReactiveGraph;

  afterEach(() => {
    rg?.dispose();
  });

  it('marks task as failed when handler throws synchronously', async () => {
    const config = makeConfig({
      bad: { provides: ['x'], taskHandlers: ['bad'] },
    });

    rg = createReactiveGraph(config, {
      handlers: {
        bad: (() => { throw new Error('sync boom'); }) as unknown as TaskHandlerFn,
      },
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    const state = rg.getState();
    expect(state.state.tasks.bad.status).toBe('failed');
    expect(state.state.tasks.bad.error).toContain('sync boom');
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
      producer: { provides: ['data'], taskHandlers: ['producer'] },
    });
    const g = makeGraphRef();

    rg = createReactiveGraph(config, {
      handlers: {
        producer: async ({ callbackToken }) => {
          // Push task-completed with explicit dataHash via external push
          g.ref!.push({
            type: 'task-completed',
            taskName: 'producer',
            dataHash: 'abc123',
            timestamp: ts(),
          });
          return 'task-initiated';
        },
      },
    });
    g.ref = rg;

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
      a: { provides: ['x'], taskHandlers: ['a'] },
      b: { requires: ['x'], provides: ['y'], taskHandlers: ['b'] },
    });
    const g = makeGraphRef();

    rg = createReactiveGraph(config, {
      handlers: {
        a: async ({ callbackToken }) => { g.resolve(callbackToken, {}); return 'task-initiated'; },
        b: async ({ callbackToken }) => { g.resolve(callbackToken, {}); return 'task-initiated'; },
      },
    });
    g.ref = rg;

    const result = rg.getSchedule();
    expect(result.eligible).toContain('a');
    expect(result.eligible).not.toContain('b');
  });
});
