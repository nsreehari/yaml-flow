import { describe, expect, it } from 'vitest';
import {
  createCardHandlerFn,
  normalizeSourceRuntimeEntry,
  type CardHandlerAdapters,
  type CardRuntimeSnapshot,
  type LiveCard,
  type SourceRuntimeEntry,
} from '../../src/cli/common/board-live-cards-lib.js';
import type { TaskHandlerInput } from '../../src/continuous-event-graph/reactive.js';
import type { GraphEngineStore } from '../../src/event-graph/types.js';

// ---------------------------------------------------------------------------
// Minimal mocks
// ---------------------------------------------------------------------------

function makeTaskState(executionCount = 1): GraphEngineStore {
  return {
    status: 'running',
    executionCount,
    retryCount: 0,
    lastEpoch: 0,
  };
}

function makeInput(nodeId: string, update?: Record<string, unknown>): TaskHandlerInput {
  return {
    nodeId,
    state: {},
    taskState: makeTaskState(),
    config: { provides: [], taskHandlers: ['card-handler'] },
    callbackToken: 'cb-token',
    update,
  };
}

function makeAdapters(card: LiveCard): {
  adapters: CardHandlerAdapters;
  completedCalls: Array<{ taskName: string; data: Record<string, unknown> }>;
  runtimeStore: Map<string, CardRuntimeSnapshot>;
  stagedContent: Map<string, string>;
  committedContent: Map<string, unknown>;
  requestEntries: Array<{ journalId: string; entries: Array<{ taskKind: string; payload: unknown }> }>;
} {
  const completedCalls: Array<{ taskName: string; data: Record<string, unknown> }> = [];
  const runtimeStore = new Map<string, CardRuntimeSnapshot>();
  const stagedContent = new Map<string, string>();
  const committedContent = new Map<string, unknown>();
  const requestEntries: Array<{ journalId: string; entries: Array<{ taskKind: string; payload: unknown }> }> = [];

  const adapters: CardHandlerAdapters = {
    cardStore: {
      readCard: (id) => (id === card.id ? card : null),
      readCardKey: () => null,
      readAllCards: () => [card],
      readChecksumIndex: () => ({}),
      changedSince: () => [],
    },
    cardRuntimeStore: {
      readRuntime: (cardId) => runtimeStore.get(cardId) ?? { _sources: {} },
      writeRuntime: (cardId, state) => { runtimeStore.set(cardId, state); },
    },
    fetchedSourcesStore: {
      readSourceData: (cardId, outputFile) =>
        committedContent.get(`${cardId}/${outputFile}`) ?? null,
      ingestSourceDataStaged: (cardId, outputFile, _ref, deliveryToken) => {
        stagedContent.set(`${cardId}/.staged/${deliveryToken}/${outputFile}`, `content-for-${outputFile}`);
      },
      commitSourceData: (cardId, outputFile, deliveryToken) => {
        const key = `${cardId}/.staged/${deliveryToken}/${outputFile}`;
        const content = stagedContent.get(key);
        if (content == null) return false;
        committedContent.set(`${cardId}/${outputFile}`, content);
        return true;
      },
      hasSource: (cardId, outputFile) => committedContent.has(`${cardId}/${outputFile}`),
    },
    outputStore: {
      writeComputedValues: () => {},
      readComputedValues: () => null,
      readAllComputedValues: () => ({}),
      writeDataObjects: () => {},
      readDataObject: () => null,
      readAllDataObjects: () => ({}),
      writeStatusSnapshot: () => {},
      readStatusSnapshot: () => null,
    },
    executionRequestStore: {
      appendEntries: (journalId, entries) => { requestEntries.push({ journalId, entries: entries as Array<{ taskKind: string; payload: unknown }> }); },
      dispatchEntriesForJournalId: () => {},
    },
  };

  // Wrap completedCalls collection into the adapters snapshot so callers can
  // pass their own taskCompletedFn while still using the same mocks.
  return { adapters, completedCalls, runtimeStore, stagedContent, committedContent, requestEntries };
}

const BASE_REF = { kind: 'fs-path' as const, value: '/tmp/test-board' };
const JOURNAL_ID = 'journal-0';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createCardHandlerFn — multi-source completion gating', () => {
  /**
   * Regression: card with two required source_defs.
   * Identity source delivers first; manager is still in-flight.
   * The handler must NOT call taskCompletedFn — it must return 'task-initiated' and wait.
   */
  it('does not complete when a required source is still in-flight after first delivery', async () => {
    const card: LiveCard = {
      id: 'card-multi',
      source_defs: [
        { bindTo: 'identity', outputFile: 'identity.txt' },
        { bindTo: 'manager', outputFile: 'manager.txt' },
      ],
    };

    const { adapters, completedCalls, runtimeStore, stagedContent } = makeAdapters(card);
    const taskCompletedFn = (taskName: string, data: Record<string, unknown>) => {
      completedCalls.push({ taskName, data });
    };
    const handler = createCardHandlerFn(BASE_REF, JOURNAL_ID, adapters, taskCompletedFn, () => {});

    // Pre-condition: both sources have been dispatched (lastRequestedToken set).
    // Manager is still in-flight (no lastCompletedToken).
    runtimeStore.set('card-multi', {
      _sources: {
        'identity.txt': { lastRequestedToken: '2026-05-16T10:00:01.000Z', queueRequestedToken: '2026-05-16T10:00:01.000Z' },
        'manager.txt':  { lastRequestedToken: '2026-05-16T10:00:01.000Z', queueRequestedToken: '2026-05-16T10:00:01.000Z' },
      },
      _lastExecutionCount: 1,
    });

    // Stage identity content so commitSourceData succeeds.
    stagedContent.set('card-multi/.staged/tok-identity/identity.txt', 'Alice');

    // Simulate identity task-progress arriving.
    const result = await handler(makeInput('card-multi', {
      outputFile: 'identity.txt',
      rqt: '2026-05-16T10:00:01.000Z',
      deliveryToken: 'tok-identity',
    }));

    expect(result).toBe('task-initiated');
    expect(completedCalls).toHaveLength(0); // must NOT complete yet
  });

  /**
   * Happy path: card completes once all required sources are delivered.
   */
  it('calls taskCompletedFn once all required sources are delivered', async () => {
    const card: LiveCard = {
      id: 'card-multi',
      source_defs: [
        { bindTo: 'identity', outputFile: 'identity.txt' },
        { bindTo: 'manager', outputFile: 'manager.txt' },
      ],
    };

    const { adapters, completedCalls, runtimeStore, stagedContent } = makeAdapters(card);
    const taskCompletedFn = (taskName: string, data: Record<string, unknown>) => {
      completedCalls.push({ taskName, data });
    };
    const handler = createCardHandlerFn(BASE_REF, JOURNAL_ID, adapters, taskCompletedFn, () => {});

    // Pre-condition: identity is already delivered (idle); manager is still in-flight.
    runtimeStore.set('card-multi', {
      _sources: {
        'identity.txt': {
          lastRequestedToken: '2026-05-16T10:00:01.000Z',
          lastCompletedToken:   '2026-05-16T10:00:01.000Z',
          lastCompletionStatus: 'success',
          queueRequestedToken: '2026-05-16T10:00:01.000Z',
        },
        'manager.txt': {
          lastRequestedToken: '2026-05-16T10:00:01.000Z',
          queueRequestedToken: '2026-05-16T10:00:01.000Z',
        },
      },
      _lastExecutionCount: 1,
    });

    // Identity content already committed (from the previous delivery cycle).
    adapters.fetchedSourcesStore.commitSourceData; // noop for setup; set committedContent directly
    // Use the inner map via closure — re-make with explicit pre-commit:
    const { adapters: a2, completedCalls: cc2, runtimeStore: rs2, stagedContent: sc2, committedContent: committed2 } = makeAdapters(card);
    const taskCompletedFn2 = (taskName: string, data: Record<string, unknown>) => {
      cc2.push({ taskName, data });
    };
    const handler2 = createCardHandlerFn(BASE_REF, JOURNAL_ID, a2, taskCompletedFn2, () => {});

    rs2.set('card-multi', {
      _sources: {
        'identity.txt': {
          lastRequestedToken: '2026-05-16T10:00:01.000Z',
          lastCompletedToken:   '2026-05-16T10:00:01.000Z',
          lastCompletionStatus: 'success',
          queueRequestedToken: '2026-05-16T10:00:01.000Z',
        },
        'manager.txt': {
          lastRequestedToken: '2026-05-16T10:00:01.000Z',
          queueRequestedToken: '2026-05-16T10:00:01.000Z',
        },
      },
      _lastExecutionCount: 1,
    });
    committed2.set('card-multi/identity.txt', 'Alice');
    sc2.set('card-multi/.staged/tok-manager/manager.txt', 'Bob');

    // Now manager delivers.
    const result2 = await handler2(makeInput('card-multi', {
      outputFile: 'manager.txt',
      rqt: '2026-05-16T10:00:01.000Z',
      deliveryToken: 'tok-manager',
    }));

    expect(result2).toBe('task-initiated');
    expect(cc2).toHaveLength(1);
    expect(cc2[0].taskName).toBe('card-multi');
  });

  /**
   * Single required source: card completes immediately after that source delivers.
   * (Existing behaviour — must not regress.)
   */
  it('completes immediately when there is only one required source and it delivers', async () => {
    const card: LiveCard = {
      id: 'card-single',
      source_defs: [
        { bindTo: 'identity', outputFile: 'identity.txt' },
      ],
    };

    const { adapters, completedCalls, runtimeStore, stagedContent } = makeAdapters(card);
    const taskCompletedFn = (taskName: string, data: Record<string, unknown>) => {
      completedCalls.push({ taskName, data });
    };
    const handler = createCardHandlerFn(BASE_REF, JOURNAL_ID, adapters, taskCompletedFn, () => {});

    runtimeStore.set('card-single', {
      _sources: {
        'identity.txt': { lastRequestedToken: '2026-05-16T10:00:01.000Z', queueRequestedToken: '2026-05-16T10:00:01.000Z' },
      },
      _lastExecutionCount: 1,
    });
    stagedContent.set('card-single/.staged/tok-1/identity.txt', 'Alice');

    const result = await handler(makeInput('card-single', {
      outputFile: 'identity.txt',
      rqt: '2026-05-16T10:00:01.000Z',
      deliveryToken: 'tok-1',
    }));

    expect(result).toBe('task-initiated');
    expect(completedCalls).toHaveLength(1);
    expect(completedCalls[0].taskName).toBe('card-single');
  });

  /**
  * Safety: if the second required source FAILS (not delivers), the card must still
  * proceed to complete — a failed source is terminal, not in-flight.
  * The lifecycle now records terminal failure in lastCompletedToken/lastCompletionStatus,
  * so the completion guard must treat that source as finished for the current cycle.
   */
  it('does not get stuck when one required source fails — completes with that source absent', async () => {
    const card: LiveCard = {
      id: 'card-fail',
      source_defs: [
        { bindTo: 'identity', outputFile: 'identity.txt' },
        { bindTo: 'manager', outputFile: 'manager.txt' },
      ],
    };

    const { adapters, completedCalls, runtimeStore, stagedContent, committedContent } = makeAdapters(card);
    const taskCompletedFn = (taskName: string, data: Record<string, unknown>) => {
      completedCalls.push({ taskName, data });
    };
    const handler = createCardHandlerFn(BASE_REF, JOURNAL_ID, adapters, taskCompletedFn, () => {});

    // Identity already delivered (idle). Manager was dispatched but not yet failed.
    runtimeStore.set('card-fail', {
      _sources: {
        'identity.txt': {
          lastRequestedToken:  '2026-05-16T10:00:01.000Z',
          lastCompletedToken:    '2026-05-16T10:00:01.000Z',
          lastCompletionStatus: 'success',
          queueRequestedToken: '2026-05-16T10:00:01.000Z',
        },
        'manager.txt': {
          lastRequestedToken:  '2026-05-16T10:00:01.000Z',
          queueRequestedToken: '2026-05-16T10:00:01.000Z',
        },
      },
      _lastExecutionCount: 1,
    });
    committedContent.set('card-fail/identity.txt', 'Alice');

    // Manager fails.
    const result = await handler(makeInput('card-fail', {
      outputFile: 'manager.txt',
      failure: true,
      reason: 'network timeout',
    }));

    // Card must complete (with manager data absent) — not get stuck.
    expect(result).toBe('task-initiated');
    expect(completedCalls).toHaveLength(1);
    expect(completedCalls[0].taskName).toBe('card-fail');
  });

  /**
   * Safety: retrigger (executionCount bump) resets _sources and redispatches all
   * sources. The anyRequiredInFlight guard must never be reached — handled by the
   * earlier undeliveredRequired block.
   */
  it('re-dispatches all sources on retrigger (executionCount change) without premature completion', async () => {
    const card: LiveCard = {
      id: 'card-retrigger',
      source_defs: [
        { bindTo: 'identity', outputFile: 'identity.txt' },
        { bindTo: 'manager',  outputFile: 'manager.txt' },
      ],
    };

    const { adapters, completedCalls, runtimeStore, committedContent } = makeAdapters(card);
    const taskCompletedFn = (taskName: string, data: Record<string, unknown>) => {
      completedCalls.push({ taskName, data });
    };
    const handler = createCardHandlerFn(BASE_REF, JOURNAL_ID, adapters, taskCompletedFn, () => {});

    // Previous execution had both sources delivered (idle) with executionCount = 1.
    runtimeStore.set('card-retrigger', {
      _sources: {
        'identity.txt': {
          lastRequestedToken:  '2026-05-16T10:00:01.000Z',
          lastCompletedToken:    '2026-05-16T10:00:01.000Z',
          lastCompletionStatus: 'success',
          queueRequestedToken: '2026-05-16T10:00:01.000Z',
        },
        'manager.txt': {
          lastRequestedToken:  '2026-05-16T10:00:01.000Z',
          lastCompletedToken:    '2026-05-16T10:00:01.000Z',
          lastCompletionStatus: 'success',
          queueRequestedToken: '2026-05-16T10:00:01.000Z',
        },
      },
      _lastExecutionCount: 1,
    });
    committedContent.set('card-retrigger/identity.txt', 'Alice');
    committedContent.set('card-retrigger/manager.txt', 'Bob');

    // Retrigger: executionCount bumped to 2, no update.
    const retriggeredInput: TaskHandlerInput = {
      nodeId: 'card-retrigger',
      state: {},
      taskState: makeTaskState(2), // new execution
      config: { provides: [], taskHandlers: ['card-handler'] },
      callbackToken: 'cb-retrigger',
      // no update — fresh initiation
    };

    const result = await handler(retriggeredInput);

    // Sources must be re-dispatched, card must NOT complete yet.
    expect(result).toBe('task-initiated');
    expect(completedCalls).toHaveLength(0);
    // _sources must have been wiped and re-stamped (lastRequestedToken set, no lastCompletedToken)
    const rt = runtimeStore.get('card-retrigger');
    const identity = normalizeSourceRuntimeEntry(rt?._sources['identity.txt']);
    const manager = normalizeSourceRuntimeEntry(rt?._sources['manager.txt']);
    expect(identity?.lastRequestedToken).toBeDefined();
    expect(identity?.lastCompletedToken).toBeUndefined();
    expect(manager?.lastRequestedToken).toBeDefined();
    expect(manager?.lastCompletedToken).toBeUndefined();
  });

  it('does not queue a source when skip_when is truthy', async () => {
    const card: LiveCard = {
      id: 'card-skip-queue',
      card_data: { shouldSkip: true },
      source_defs: [
        { bindTo: 'identity', outputFile: 'identity.txt', skip_when: 'card_data.shouldSkip' },
        { bindTo: 'manager', outputFile: 'manager.txt' },
      ],
    };

    const { adapters, completedCalls, requestEntries } = makeAdapters(card);
    const handler = createCardHandlerFn(BASE_REF, JOURNAL_ID, adapters, (taskName, data) => {
      completedCalls.push({ taskName, data });
    }, () => {});

    const result = await handler(makeInput('card-skip-queue'));

    expect(result).toBe('task-initiated');
    expect(completedCalls).toHaveLength(0);
    expect(requestEntries).toHaveLength(1);
    const payload = requestEntries[0].entries[0].payload as { enrichedCard: { source_defs: Array<{ bindTo: string }> } };
    expect(payload.enrichedCard.source_defs.map((src) => src.bindTo)).toEqual(['manager']);
  });

  it('does not block completion when all sources are skipped', async () => {
    const card: LiveCard = {
      id: 'card-all-skipped',
      card_data: { disabled: true },
      source_defs: [
        { bindTo: 'identity', outputFile: 'identity.txt', skip_when: 'card_data.disabled' },
      ],
    };

    const { adapters, completedCalls, requestEntries } = makeAdapters(card);
    const handler = createCardHandlerFn(BASE_REF, JOURNAL_ID, adapters, (taskName, data) => {
      completedCalls.push({ taskName, data });
    }, () => {});

    const result = await handler(makeInput('card-all-skipped'));

    expect(result).toBe('task-initiated');
    expect(requestEntries).toHaveLength(0);
    expect(completedCalls).toHaveLength(1);
    expect(completedCalls[0].taskName).toBe('card-all-skipped');
  });

  /**
   * Retrigger safety: even if _lastExecutionCount was never written, a fresh run must
   * still wipe stale token-state and redispatch all sources.
   */
  it('wipes stale sources on retrigger even when _lastExecutionCount is absent', async () => {
    const card: LiveCard = {
      id: 'card-migrate',
      source_defs: [
        { bindTo: 'identity', outputFile: 'identity.txt' },
        { bindTo: 'manager',  outputFile: 'manager.txt' },
      ],
    };

    const { adapters, completedCalls, runtimeStore } = makeAdapters(card);
    const taskCompletedFn = (taskName: string, data: Record<string, unknown>) => {
      completedCalls.push({ taskName, data });
    };
    const handler = createCardHandlerFn(BASE_REF, JOURNAL_ID, adapters, taskCompletedFn, () => {});

    // Simulate a stale snapshot: has source entries but _lastExecutionCount is absent.
    runtimeStore.set('card-migrate', {
      _sources: {
        'identity.txt': {
          lastRequestedToken: '2026-05-15T10:00:01.000Z',
          lastCompletedToken: '2026-05-15T10:00:02.000Z',
          lastCompletionStatus: 'success',
          queueRequestedToken: '2026-05-15T10:00:01.000Z',
        },
        'manager.txt': {
          lastRequestedToken: '2026-05-15T10:00:01.000Z',
          lastCompletedToken: '2026-05-15T10:00:01.000Z',
          lastCompletionStatus: 'failure',
          queueRequestedToken: '2026-05-15T10:00:01.000Z',
        },
      },
      // _lastExecutionCount intentionally absent (undefined)
    });

    // Retrigger: executionCount = 1 (fresh start, _lastExecutionCount was undefined).
    const result = await handler({
      nodeId: 'card-migrate',
      state: {},
      taskState: makeTaskState(1),
      config: { provides: [], taskHandlers: ['card-handler'] },
      callbackToken: 'cb-migrate',
    });

    // Must re-dispatch both sources, not complete.
    expect(result).toBe('task-initiated');
    expect(completedCalls).toHaveLength(0);
    // Stale source entries must have been wiped and re-stamped.
    const rt = runtimeStore.get('card-migrate');
    const identity = normalizeSourceRuntimeEntry(rt?._sources['identity.txt']);
    const manager = normalizeSourceRuntimeEntry(rt?._sources['manager.txt']);
    expect(rt?._lastExecutionCount).toBe(1);
    expect(identity?.lastCompletedToken).toBeUndefined();
    expect(manager?.lastCompletedToken).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// request-cycle token completion
// ---------------------------------------------------------------------------

describe('createCardHandlerFn — request-cycle token completion', () => {
  /**
   * Completion is recorded against the dispatched request-cycle token (rqt), even when
   * the event also carries fetchedAt as informational metadata.
   */
  it('records lastCompletedToken from rqt and marks success', async () => {
    const card: LiveCard = {
      id: 'card-fetchedat',
      source_defs: [{ bindTo: 'identity', outputFile: 'identity.txt' }],
    };

    const { adapters, runtimeStore, stagedContent } = makeAdapters(card);
    const handler = createCardHandlerFn(BASE_REF, JOURNAL_ID, adapters, () => {}, () => {});

    const rqt       = '2026-05-16T10:00:01.000Z';
    const fetchedAt = '2026-05-16T10:00:03.000Z'; // later than rqt

    runtimeStore.set('card-fetchedat', {
      _sources: {
        'identity.txt': { lastRequestedToken: rqt, queueRequestedToken: rqt },
      },
      _lastExecutionCount: 1,
    });
    stagedContent.set('card-fetchedat/.staged/tok-1/identity.txt', 'Alice');

    await handler(makeInput('card-fetchedat', {
      outputFile: 'identity.txt',
      rqt,
      fetchedAt,
      deliveryToken: 'tok-1',
    }));

    const entry = runtimeStore.get('card-fetchedat')?._sources['identity.txt'] as SourceRuntimeEntry | undefined;
    expect(entry?.lastCompletedToken).toBe(rqt);
    expect(entry?.lastCompletionStatus).toBe('success');
    expect(entry?.lastCompletedToken).not.toBe(fetchedAt);
  });

  /**
   * Failure is also terminal for the dispatched request-cycle token.
   */
  it('records lastCompletedToken from rqt and marks failure on fetch failure', async () => {
    const card: LiveCard = {
      id: 'card-rqt-failure',
      source_defs: [{ bindTo: 'identity', outputFile: 'identity.txt' }],
    };

    const { adapters, runtimeStore, stagedContent } = makeAdapters(card);
    const handler = createCardHandlerFn(BASE_REF, JOURNAL_ID, adapters, () => {}, () => {});

    const rqt = '2026-05-16T10:00:01.000Z';

    runtimeStore.set('card-rqt-failure', {
      _sources: {
        'identity.txt': { lastRequestedToken: rqt, queueRequestedToken: rqt },
      },
      _lastExecutionCount: 1,
    });

    await handler(makeInput('card-rqt-failure', {
      outputFile: 'identity.txt',
      rqt,
      failure: true,
      reason: 'network timeout',
    }));

    const entry = runtimeStore.get('card-rqt-failure')?._sources['identity.txt'] as SourceRuntimeEntry | undefined;
    expect(entry?.lastCompletedToken).toBe(rqt);
    expect(entry?.lastCompletionStatus).toBe('failure');
  });

  /**
   * When the queued request token advances mid-flight, completing the older dispatched
   * cycle leaves the source ready to dispatch again on the next evaluation.
   */
  it('source re-dispatches after delivery when queueRequestedToken advanced mid-flight', async () => {
    const { decideSourceAction } = await import('../../src/cli/common/board-live-cards-lib.js');

    const card: LiveCard = {
      id: 'card-advanced-qrt',
      source_defs: [{ bindTo: 'identity', outputFile: 'identity.txt' }],
    };

    const { adapters, runtimeStore, stagedContent } = makeAdapters(card);
    const handler = createCardHandlerFn(BASE_REF, JOURNAL_ID, adapters, () => {}, () => {});

    const rqt         = '2026-05-16T10:00:01.000Z';
    const advancedQrt = '2026-05-16T10:00:02.000Z'; // queueRequestedToken advanced mid-flight

    runtimeStore.set('card-advanced-qrt', {
      _sources: {
        'identity.txt': {
          lastRequestedToken:  rqt,
          queueRequestedToken: advancedQrt, // advanced while fetch was in-flight
        },
      },
      _lastExecutionCount: 1,
    });
    stagedContent.set('card-advanced-qrt/.staged/tok-3/identity.txt', 'Alice');

    await handler(makeInput('card-advanced-qrt', {
      outputFile: 'identity.txt',
      rqt,
      deliveryToken: 'tok-3',
    }));

    const entry = runtimeStore.get('card-advanced-qrt')?._sources['identity.txt'] as SourceRuntimeEntry | undefined;
    expect(decideSourceAction(entry, advancedQrt)).toBe('in-flight');
  });
});

