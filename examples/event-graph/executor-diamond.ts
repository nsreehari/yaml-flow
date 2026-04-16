/**
 * Event Graph Example: Executor-driven Diamond DAG (Library Mode)
 *
 * A diamond-shaped graph with parallel fan-out and fan-in.
 * Tasks simulate real-world async work with random delays.
 *
 *        fetch
 *       /     \
 *    parse   validate
 *       \     /
 *       combine
 *          |
 *        report
 *
 * Run with: npx tsx examples/event-graph/executor-diamond.ts
 */

import {
  next, apply, createInitialExecutionState,
} from '../../src/event-graph/index.js';
import type { GraphConfig, ExecutionState } from '../../src/event-graph/types.js';

// ============================================================================
// 1. Define the diamond graph
// ============================================================================

const graph: GraphConfig = {
  id: 'diamond-dag',
  settings: {
    completion: 'all-tasks-done',
    execution_mode: 'eligibility-mode',
    conflict_strategy: 'parallel-all',
  },
  tasks: {
    fetch: {
      provides: ['raw-payload'],
    },
    parse: {
      requires: ['raw-payload'],
      provides: ['parsed-records'],
    },
    validate: {
      requires: ['raw-payload'],
      provides: ['validation-report'],
    },
    combine: {
      requires: ['parsed-records', 'validation-report'],
      provides: ['final-dataset'],
    },
    report: {
      requires: ['final-dataset'],
      provides: ['report-sent'],
    },
  },
};

// ============================================================================
// 2. Simulate async executors with random delays
// ============================================================================

const taskSimulations: Record<string, () => Promise<{ ok: boolean; detail: string }>> = {
  fetch: async () => {
    await sleep(randomMs(100, 300));
    return { ok: true, detail: 'fetched 5MB payload' };
  },
  parse: async () => {
    await sleep(randomMs(150, 400));
    return { ok: true, detail: 'parsed 12,000 records' };
  },
  validate: async () => {
    await sleep(randomMs(200, 500));
    const passRate = 95 + Math.floor(Math.random() * 5);
    return { ok: true, detail: `${passRate}% pass rate` };
  },
  combine: async () => {
    await sleep(randomMs(100, 250));
    return { ok: true, detail: 'merged parsed + validated' };
  },
  report: async () => {
    await sleep(randomMs(50, 150));
    return { ok: true, detail: 'emailed to stakeholders' };
  },
};

// ============================================================================
// 3. Execution loop — you drive, engine decides
// ============================================================================

async function run() {
  console.log('=== Executor-driven Diamond DAG ===\n');
  console.log('  Graph shape: fetch → [parse, validate] → combine → report\n');

  let state: ExecutionState = createInitialExecutionState(graph, 'diamond-1');
  let iteration = 0;
  const startTime = Date.now();

  while (iteration < 20) {
    iteration++;
    const result = next(graph, state);

    if (result.isComplete) {
      const elapsed = Date.now() - startTime;
      console.log(`\n✅ All tasks complete in ${elapsed}ms (${iteration} iterations)\n`);
      break;
    }

    if (result.eligibleTasks.length === 0) {
      if (result.stuckDetection.is_stuck) {
        console.log(`⚠️  Stuck: ${result.stuckDetection.stuck_description}`);
        break;
      }
      continue;
    }

    console.log(`[iteration ${iteration}] dispatching: [${result.eligibleTasks.join(', ')}]`);

    // Start all eligible
    const ts = new Date().toISOString();
    for (const taskName of result.eligibleTasks) {
      state = apply(state, { type: 'task-started', taskName, timestamp: ts }, graph);
    }

    // Execute in parallel — this is where your real handlers would go
    const execResults = await Promise.all(
      result.eligibleTasks.map(async (taskName) => {
        const sim = taskSimulations[taskName];
        const r = await sim();
        console.log(`  [${taskName}] ${r.ok ? '✓' : '✗'} ${r.detail}`);
        return { taskName, ...r };
      }),
    );

    // Feed results back
    for (const r of execResults) {
      const ts2 = new Date().toISOString();
      if (r.ok) {
        state = apply(state, { type: 'task-completed', taskName: r.taskName, timestamp: ts2 }, graph);
      } else {
        state = apply(state, { type: 'task-failed', taskName: r.taskName, error: 'failed', timestamp: ts2 }, graph);
      }
    }

    console.log(`  → outputs: [${state.availableOutputs.join(', ')}]`);
  }

  // Summary
  console.log('=== Execution Summary ===');
  for (const [name, task] of Object.entries(state.tasks)) {
    console.log(`  ${name}: ${task.status}`);
  }
}

run();

// ============================================================================
// Util
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomMs(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min));
}
