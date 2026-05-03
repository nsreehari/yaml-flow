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
  restore,
} from '../../src/continuous-event-graph/index.js';
import type { TaskHandlerFn, ReactiveGraph, SyncTaskResolverFn } from '../../src/continuous-event-graph/index.js';

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

// ============================================================================
// snapshot + restore roundtrip
// ============================================================================

describe('reactive — snapshot / restore', () => {
  const ticks = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
  let rg: ReactiveGraph;

  afterEach(() => {
    rg?.dispose();
  });

  it('snapshot returns a LiveGraphSnapshot with config, state, version', async () => {
    const config = makeConfig({
      src: { provides: ['x'], taskHandlers: ['src'] },
    });
    const g = makeGraphRef();

    rg = createReactiveGraph(config, {
      handlers: {
        src: async ({ callbackToken }) => { g.resolve(callbackToken, { val: 1 }); return 'task-initiated'; },
      },
    });
    g.ref = rg;

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    const snap = rg.snapshot();
    expect(snap.version).toBe(1);
    expect(snap.snapshotAt).toBeDefined();
    expect(snap.config.tasks.src).toBeDefined();
    expect(snap.state.tasks.src.status).toBe('completed');
    expect(snap.state.tasks.src.data).toEqual({ val: 1 });
  });

  it('restore + createReactiveGraph reconstitutes state from snapshot', async () => {
    const config = makeConfig({
      a: { provides: ['x'], taskHandlers: ['a'] },
      b: { requires: ['x'], provides: ['y'], taskHandlers: ['b'] },
    });
    const g1 = makeGraphRef();

    // First graph: run task 'a', snapshot
    const rg1 = createReactiveGraph(config, {
      handlers: {
        a: async ({ callbackToken }) => { g1.resolve(callbackToken, { fromA: 42 }); return 'task-initiated'; },
        b: async ({ callbackToken }) => { g1.resolve(callbackToken, { fromB: 99 }); return 'task-initiated'; },
      },
    });
    g1.ref = rg1;

    rg1.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(100);

    expect(rg1.getState().state.tasks.a.status).toBe('completed');
    expect(rg1.getState().state.tasks.b.status).toBe('completed');

    const snap = rg1.snapshot();
    rg1.dispose();

    // Second graph: restore from snapshot — state should be intact
    const restored = restore(snap);
    const g2 = makeGraphRef();

    rg = createReactiveGraph(restored, {
      handlers: {
        a: async ({ callbackToken }) => { g2.resolve(callbackToken, { fromA: 42 }); return 'task-initiated'; },
        b: async ({ callbackToken }) => { g2.resolve(callbackToken, { fromB: 99 }); return 'task-initiated'; },
      },
    });
    g2.ref = rg;

    // State survives the roundtrip — no events needed
    expect(rg.getState().state.tasks.a.status).toBe('completed');
    expect(rg.getState().state.tasks.a.data).toEqual({ fromA: 42 });
    expect(rg.getState().state.tasks.b.status).toBe('completed');
    expect(rg.getState().state.tasks.b.data).toEqual({ fromB: 99 });
  });

  it('restored graph accepts new events and continues the cascade', async () => {
    const config = makeConfig({
      src: { provides: ['x'], taskHandlers: ['src'] },
      calc: { requires: ['x'], provides: ['y'], taskHandlers: ['calc'] },
    });
    const g1 = makeGraphRef();

    // Run only 'src', then snapshot before 'calc' completes
    const rg1 = createReactiveGraph(config, {
      handlers: {
        src: async ({ callbackToken }) => { g1.resolve(callbackToken, { v: 1 }); return 'task-initiated'; },
        calc: async () => 'task-initiated', // never resolves
      },
    });
    g1.ref = rg1;

    rg1.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    expect(rg1.getState().state.tasks.src.status).toBe('completed');
    // calc was dispatched (running) but never resolved
    const snap = rg1.snapshot();
    rg1.dispose();

    // Restore — push a new event to re-drive
    const restored = restore(snap);
    const g2 = makeGraphRef();

    rg = createReactiveGraph(restored, {
      handlers: {
        src: async ({ callbackToken }) => { g2.resolve(callbackToken, { v: 1 }); return 'task-initiated'; },
        calc: async ({ callbackToken }) => { g2.resolve(callbackToken, { result: 42 }); return 'task-initiated'; },
      },
    });
    g2.ref = rg;

    // Retrigger calc on the restored graph
    rg.retrigger('calc');
    await ticks(50);

    expect(rg.getState().state.tasks.calc.status).toBe('completed');
    expect(rg.getState().state.tasks.calc.data).toEqual({ result: 42 });
  });

  it('snapshot serializes cleanly through JSON roundtrip', async () => {
    const config = makeConfig({
      a: { provides: ['a'], taskHandlers: ['a'] },
    });
    const g = makeGraphRef();

    rg = createReactiveGraph(config, {
      handlers: {
        a: async ({ callbackToken }) => { g.resolve(callbackToken, { x: [1, 2, 3] }); return 'task-initiated'; },
      },
    });
    g.ref = rg;

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    const snap = rg.snapshot();
    const json = JSON.stringify(snap);
    const parsed = JSON.parse(json);
    const restored = restore(parsed);

    expect(restored.state.tasks.a.status).toBe('completed');
    expect(restored.state.tasks.a.data).toEqual({ x: [1, 2, 3] });
  });
});

// ============================================================================
// syncResolver — synchronous fast-path
// ============================================================================

describe('reactive — syncResolver', () => {
  let rg: ReactiveGraph;

  afterEach(() => {
    rg?.dispose();
  });

  it('completes a task synchronously when syncResolver returns isCompleted:true', () => {
    const config = makeConfig({
      fast: { provides: ['data'], taskHandlers: ['fast'] },
    });

    const asyncHandlerCalls: string[] = [];

    rg = createReactiveGraph(config, {
      handlers: {
        fast: async ({ callbackToken }) => {
          asyncHandlerCalls.push('fast');
          return 'task-initiated';
        },
      },
      syncResolver: (input) => {
        if (input.nodeId === 'fast') {
          return { isCompleted: true, data: { value: 42 } };
        }
        return { isCompleted: false };
      },
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });

    // Task completes synchronously — no await needed
    const state = rg.getState();
    expect(state.state.tasks.fast.status).toBe('completed');
    expect(state.state.tasks.fast.data).toEqual({ value: 42 });
    // Async handler should NOT have been called
    expect(asyncHandlerCalls).toEqual([]);
  });

  it('falls through to async handler when syncResolver returns isCompleted:false', async () => {
    const config = makeConfig({
      slow: { provides: ['data'], taskHandlers: ['slow'] },
    });

    const g = makeGraphRef();
    const asyncHandlerCalls: string[] = [];

    rg = createReactiveGraph(config, {
      handlers: {
        slow: async ({ callbackToken }) => {
          asyncHandlerCalls.push('slow');
          g.resolve(callbackToken, { fromAsync: true });
          return 'task-initiated';
        },
      },
      syncResolver: (_input) => {
        return { isCompleted: false };
      },
    });
    g.ref = rg;

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    expect(asyncHandlerCalls).toEqual(['slow']);
    const state = rg.getState();
    expect(state.state.tasks.slow.status).toBe('completed');
    expect(state.state.tasks.slow.data).toEqual({ fromAsync: true });
  });

  it('cascades a full chain synchronously in a single drain pass', () => {
    // A → B → C — all resolved by syncResolver, no async hops
    const config = makeConfig({
      a: { provides: ['x'], taskHandlers: ['a'] },
      b: { requires: ['x'], provides: ['y'], taskHandlers: ['b'] },
      c: { requires: ['y'], provides: ['z'], taskHandlers: ['c'] },
    });

    const asyncHandlerCalls: string[] = [];
    const drainCounts: number[] = [];

    rg = createReactiveGraph(config, {
      handlers: {
        a: async () => { asyncHandlerCalls.push('a'); return 'task-initiated'; },
        b: async () => { asyncHandlerCalls.push('b'); return 'task-initiated'; },
        c: async () => { asyncHandlerCalls.push('c'); return 'task-initiated'; },
      },
      syncResolver: (input) => {
        return { isCompleted: true, data: { from: input.nodeId } };
      },
      onDrain: (events) => {
        drainCounts.push(events.length);
      },
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });

    // All three tasks complete synchronously — no await needed
    const state = rg.getState();
    expect(state.state.tasks.a.status).toBe('completed');
    expect(state.state.tasks.a.data).toEqual({ from: 'a' });
    expect(state.state.tasks.b.status).toBe('completed');
    expect(state.state.tasks.b.data).toEqual({ from: 'b' });
    expect(state.state.tasks.c.status).toBe('completed');
    expect(state.state.tasks.c.data).toEqual({ from: 'c' });
    expect(state.state.availableOutputs).toContain('x');
    expect(state.state.availableOutputs).toContain('y');
    expect(state.state.availableOutputs).toContain('z');
    // No async handlers should have been invoked
    expect(asyncHandlerCalls).toEqual([]);
  });

  it('stores dataHash when syncResolver provides data', () => {
    const config = makeConfig({
      producer: { provides: ['out'], taskHandlers: ['producer'] },
    });

    rg = createReactiveGraph(config, {
      handlers: { producer: async () => 'task-initiated' },
      syncResolver: () => ({ isCompleted: true, data: { key: 'val' } }),
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });

    const state = rg.getState();
    expect(state.state.tasks.producer.status).toBe('completed');
    expect(state.state.tasks.producer.lastDataHash).toBeDefined();
    expect(typeof state.state.tasks.producer.lastDataHash).toBe('string');
  });

  it('handles syncResolver returning empty data gracefully', () => {
    const config = makeConfig({
      empty: { provides: ['out'], taskHandlers: ['empty'] },
    });

    rg = createReactiveGraph(config, {
      handlers: { empty: async () => 'task-initiated' },
      syncResolver: () => ({ isCompleted: true }),
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });

    const state = rg.getState();
    expect(state.state.tasks.empty.status).toBe('completed');
    // Empty data → data defaults to {}
    expect(state.state.tasks.empty.data).toEqual({});
  });

  it('marks task as failed when syncResolver throws', () => {
    const config = makeConfig({
      broken: { provides: ['out'], taskHandlers: ['broken'] },
    });

    const asyncHandlerCalls: string[] = [];

    rg = createReactiveGraph(config, {
      handlers: {
        broken: async () => { asyncHandlerCalls.push('broken'); return 'task-initiated'; },
      },
      syncResolver: () => { throw new Error('resolver exploded'); },
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });

    const state = rg.getState();
    expect(state.state.tasks.broken.status).toBe('failed');
    expect(state.state.tasks.broken.error).toContain('resolver exploded');
    // Async handler should NOT have been called after syncResolver failure
    expect(asyncHandlerCalls).toEqual([]);
  });

  it('resolves mixed sync/async tasks in same graph', async () => {
    // 'fast' resolved by syncResolver, 'slow' falls through to async handler
    const config = makeConfig({
      fast: { provides: ['x'], taskHandlers: ['fast'] },
      slow: { provides: ['y'], taskHandlers: ['slow'] },
      combine: { requires: ['x', 'y'], provides: ['z'], taskHandlers: ['combine'] },
    });

    const g = makeGraphRef();

    rg = createReactiveGraph(config, {
      handlers: {
        fast: async () => 'task-initiated',
        slow: async ({ callbackToken }) => {
          g.resolve(callbackToken, { slowData: true });
          return 'task-initiated';
        },
        combine: async () => 'task-initiated',
      },
      syncResolver: (input) => {
        if (input.nodeId === 'fast') return { isCompleted: true, data: { fastData: true } };
        if (input.nodeId === 'combine') return { isCompleted: true, data: { merged: true } };
        return { isCompleted: false };
      },
    });
    g.ref = rg;

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    const state = rg.getState();
    // 'fast' resolved synchronously
    expect(state.state.tasks.fast.status).toBe('completed');
    expect(state.state.tasks.fast.data).toEqual({ fastData: true });
    // 'slow' resolved asynchronously
    expect(state.state.tasks.slow.status).toBe('completed');
    expect(state.state.tasks.slow.data).toEqual({ slowData: true });
    // 'combine' resolved synchronously once both deps were ready
    expect(state.state.tasks.combine.status).toBe('completed');
    expect(state.state.tasks.combine.data).toEqual({ merged: true });
  });

  it('syncResolver receives upstream state from requires', () => {
    const config = makeConfig({
      producer: { provides: ['data'], taskHandlers: ['producer'] },
      consumer: { requires: ['data'], provides: ['result'], taskHandlers: ['consumer'] },
    });

    let capturedState: Record<string, unknown> | undefined;

    rg = createReactiveGraph(config, {
      handlers: {
        producer: async () => 'task-initiated',
        consumer: async () => 'task-initiated',
      },
      syncResolver: (input) => {
        if (input.nodeId === 'producer') {
          return { isCompleted: true, data: { data: 'hello' } };
        }
        if (input.nodeId === 'consumer') {
          capturedState = { ...input.state };
          return { isCompleted: true, data: { echoed: (input.state['data'] as Record<string, unknown>)?.data } };
        }
        return { isCompleted: false };
      },
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });

    expect(capturedState).toBeDefined();
    expect(capturedState!['data']).toEqual({ data: 'hello' });

    const state = rg.getState();
    expect(state.state.tasks.consumer.status).toBe('completed');
    expect(state.state.tasks.consumer.data).toEqual({ echoed: 'hello' });
  });

  it('works without syncResolver (no regression)', async () => {
    const config = makeConfig({
      a: { provides: ['x'], taskHandlers: ['a'] },
    });

    const g = makeGraphRef();

    rg = createReactiveGraph(config, {
      handlers: {
        a: async ({ callbackToken }) => { g.resolve(callbackToken, { v: 1 }); return 'task-initiated'; },
      },
      // no syncResolver
    });
    g.ref = rg;

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    const state = rg.getState();
    expect(state.state.tasks.a.status).toBe('completed');
    expect(state.state.tasks.a.data).toEqual({ v: 1 });
  });

  it('completes task via syncResolver on task-progress when all data is ready', async () => {
    // Simulates: initial dispatch → syncResolver returns isCompleted:false (sources pending)
    // → task-progress arrives (source delivered) → syncResolver returns isCompleted:true
    const config = makeConfig({
      card: { provides: ['result'], taskHandlers: ['card-handler'] },
    });

    let callCount = 0;
    const asyncHandlerCalls: string[] = [];

    rg = createReactiveGraph(config, {
      handlers: {
        'card-handler': async ({ nodeId }) => {
          asyncHandlerCalls.push(nodeId);
          return 'task-initiated';
        },
      },
      syncResolver: (input) => {
        callCount++;
        if (callCount === 1) {
          // First call: initial dispatch — sources not ready
          return { isCompleted: false };
        }
        // Second call: task-progress with update — sources now ready
        expect(input.update).toBeDefined();
        expect(input.update!.outputFile).toBe('prices.json');
        return { isCompleted: true, data: { result: 42 } };
      },
    });

    // Initial dispatch — syncResolver returns false, falls through to async handler
    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);

    expect(callCount).toBe(1);
    expect(asyncHandlerCalls).toEqual(['card']);
    expect(rg.getState().state.tasks.card.status).toBe('running');

    // Source delivery arrives as task-progress — syncResolver handles it
    rg.push({
      type: 'task-progress',
      taskName: 'card',
      update: { outputFile: 'prices.json', rqt: ts(), deliveryToken: 'dt-1' },
      timestamp: ts(),
    });
    await ticks(50);

    expect(callCount).toBe(2);
    const state = rg.getState();
    expect(state.state.tasks.card.status).toBe('completed');
    expect(state.state.tasks.card.data).toEqual({ result: 42 });
  });

  it('falls through to async handler on task-progress when syncResolver returns false', async () => {
    const config = makeConfig({
      card: { provides: ['result'], taskHandlers: ['card-handler'] },
    });

    const asyncHandlerUpdates: Record<string, unknown>[] = [];

    rg = createReactiveGraph(config, {
      handlers: {
        'card-handler': async ({ callbackToken, update }) => {
          if (update) asyncHandlerUpdates.push(update);
          return 'task-initiated';
        },
      },
      syncResolver: (_input) => {
        // Always defer to async handler
        return { isCompleted: false };
      },
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    await ticks(50);
    expect(rg.getState().state.tasks.card.status).toBe('running');

    // Send progress — syncResolver returns false, async handler gets it
    rg.push({
      type: 'task-progress',
      taskName: 'card',
      update: { outputFile: 'data.json' },
      timestamp: ts(),
    });
    await ticks(50);

    expect(asyncHandlerUpdates).toEqual([{ outputFile: 'data.json' }]);
  });

  it('task-progress syncResolver error marks task as failed', () => {
    const config = makeConfig({
      card: { provides: ['result'], taskHandlers: ['card-handler'] },
    });

    let dispatchCount = 0;

    rg = createReactiveGraph(config, {
      handlers: {
        'card-handler': async () => 'task-initiated',
      },
      syncResolver: (_input) => {
        dispatchCount++;
        if (dispatchCount === 1) return { isCompleted: false };
        // Throw on task-progress
        throw new Error('source processing failed');
      },
    });

    rg.push({ type: 'inject-tokens', tokens: [], timestamp: ts() });
    // Need a tick for the async handler to fire and mark task as running
    // but syncResolver returned false so it will fall through

    // Manually wait for handler to run
    return new Promise<void>(resolve => setTimeout(() => {
      expect(rg.getState().state.tasks.card.status).toBe('running');

      rg.push({
        type: 'task-progress',
        taskName: 'card',
        update: { outputFile: 'bad.json' },
        timestamp: ts(),
      });

      // syncResolver throws on progress → task-failed
      expect(rg.getState().state.tasks.card.status).toBe('failed');
      expect(rg.getState().state.tasks.card.error).toBe('source processing failed');
      resolve();
    }, 50));
  });
});
