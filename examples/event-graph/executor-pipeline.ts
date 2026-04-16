/**
 * Event Graph Example: Executor-driven Pipeline (Library Mode)
 *
 * Same ETL pipeline as reactive-pipeline.ts, but YOU drive the loop.
 * Each task simulates async work with random sleep.
 *
 * Demonstrates:
 *  - Manual executor loop with next/apply
 *  - validateGraph for static config validation before running
 *  - validateLiveGraph for runtime state-consistency after running
 *
 * Contrast with reactive-pipeline.ts where the graph drives itself.
 *
 * Run with: npx tsx examples/event-graph/executor-pipeline.ts
 */

import {
  next, apply, createInitialExecutionState, validateGraph,
} from '../../src/event-graph/index.js';
import type { GraphConfig, ExecutionState } from '../../src/event-graph/types.js';
import { validateLiveGraph } from '../../src/continuous-event-graph/index.js';

// ============================================================================
// 1. Define the graph (same as reactive-pipeline)
// ============================================================================

const graph: GraphConfig = {
  id: 'etl-pipeline',
  settings: {
    completion: 'all-tasks-done',
    execution_mode: 'eligibility-mode',
    conflict_strategy: 'parallel-all',
  },
  tasks: {
    extract: {
      provides: ['raw-data'],
    },
    validate: {
      requires: ['raw-data'],
      provides: ['valid-data'],
    },
    enrich: {
      requires: ['valid-data'],
      provides: ['enriched-data'],
    },
    load: {
      requires: ['enriched-data'],
      provides: ['loaded'],
    },
  },
};

// ============================================================================
// 2. Task handlers — simulate async work with random sleep
// ============================================================================

async function executeTask(taskName: string): Promise<{ ok: boolean; error?: string }> {
  const delay = 100 + Math.floor(Math.random() * 400); // 100–500ms
  console.log(`  [${taskName}] executing... (${delay}ms)`);
  await sleep(delay);

  // Simulate occasional failure (10% chance)
  if (Math.random() < 0.1) {
    console.log(`  [${taskName}] FAILED`);
    return { ok: false, error: `${taskName} timed out` };
  }

  console.log(`  [${taskName}] done`);
  return { ok: true };
}

// ============================================================================
// 3. YOU drive the execution loop
// ============================================================================

async function run() {
  console.log('=== Executor-driven ETL Pipeline (Library Mode) ===\n');

  // Pre-flight: validate static config before running
  const configValidation = validateGraph(graph);
  console.log(`Config validation: ${configValidation.valid ? '✅ valid' : '❌ invalid'} (${configValidation.issues.length} issues)`);
  for (const issue of configValidation.issues) {
    console.log(`  [${issue.severity}] ${issue.code}: ${issue.message}`);
  }
  if (!configValidation.valid) return;

  let state: ExecutionState = createInitialExecutionState(graph, 'exec-1');
  let iteration = 0;

  while (iteration < 20) {
    iteration++;
    const result = next(graph, state);

    console.log(`\n[iteration ${iteration}] eligible: [${result.eligibleTasks.join(', ')}]`);

    if (result.isComplete) {
      console.log('\n✅ Pipeline complete!');
      break;
    }

    if (result.stuckDetection.is_stuck) {
      console.log(`\n⚠️  Pipeline stuck: ${result.stuckDetection.stuck_description}`);
      break;
    }

    if (result.eligibleTasks.length === 0) {
      console.log('   (waiting for running tasks...)');
      break;
    }

    // Mark all eligible tasks as started
    const ts = new Date().toISOString();
    for (const taskName of result.eligibleTasks) {
      state = apply(state, { type: 'task-started', taskName, timestamp: ts }, graph);
    }

    // Execute in parallel — simulate real async work
    const results = await Promise.all(
      result.eligibleTasks.map(async (taskName) => {
        const r = await executeTask(taskName);
        return { taskName, ...r };
      }),
    );

    // Feed results back into the reducer
    for (const r of results) {
      const ts2 = new Date().toISOString();
      if (r.ok) {
        state = apply(state, { type: 'task-completed', taskName: r.taskName, timestamp: ts2 }, graph);
      } else {
        state = apply(state, { type: 'task-failed', taskName: r.taskName, error: r.error!, timestamp: ts2 }, graph);
      }
    }

    console.log(`   outputs: [${state.availableOutputs.join(', ')}]`);
  }

  // Final state
  console.log('\n=== Final State ===');
  for (const [name, task] of Object.entries(state.tasks)) {
    console.log(`  ${name}: ${task.status} (${task.executionCount}x)`);
  }

  // Post-run: validate runtime state consistency
  console.log('\n=== Runtime Validation ===');
  const runtimeValidation = validateLiveGraph({ config: graph, state });
  console.log(`  Valid: ${runtimeValidation.valid} (${runtimeValidation.issues.length} issues)`);
  for (const issue of runtimeValidation.issues) {
    console.log(`    [${issue.severity}] ${issue.code}: ${issue.message}`);
  }
}

run();

// ============================================================================
// Util
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
