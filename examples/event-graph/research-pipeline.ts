/**
 * Event Graph Example: Research Pipeline
 *
 * Demonstrates:
 *  - Parallel task execution (fan-out / fan-in)
 *  - Goal-based completion
 *  - The standard next() / apply() driver loop
 *
 * Run with: npx tsx examples/event-graph/research-pipeline.ts
 */

import {
  next,
  apply,
  createInitialExecutionState,
} from '../../src/event-graph/index.js';
import type { GraphConfig } from '../../src/event-graph/index.js';

// ============================================================================
// 1. Define the graph
// ============================================================================

const graph: GraphConfig = {
  id: 'research-pipeline',
  settings: {
    completion: 'goal-reached',
    goal: ['final-report'],
    conflict_strategy: 'parallel-all',
  },
  tasks: {
    fetch_sources: {
      provides: ['raw-sources'],
      description: 'Fetch source documents from the web',
    },
    analyse_sentiment: {
      requires: ['raw-sources'],
      provides: ['sentiment-result'],
      description: 'Run sentiment analysis on sources',
    },
    analyse_entities: {
      requires: ['raw-sources'],
      provides: ['entity-result'],
      description: 'Extract named entities from sources',
    },
    merge_analysis: {
      requires: ['sentiment-result', 'entity-result'],
      provides: ['merged-analysis'],
      description: 'Merge both analysis results',
    },
    generate_report: {
      requires: ['merged-analysis'],
      provides: ['final-report'],
      description: 'Generate a final report',
    },
  },
};

// ============================================================================
// 2. Simulated task executor
// ============================================================================

async function executeTask(taskName: string): Promise<string | undefined> {
  // Simulate varying work durations
  const delay = Math.random() * 200 + 50;
  await new Promise((r) => setTimeout(r, delay));

  console.log(`  ✓ ${taskName} completed (${delay.toFixed(0)}ms)`);
  return undefined; // no special result key → default provides
}

// ============================================================================
// 3. Driver loop
// ============================================================================

async function main() {
  let state = createInitialExecutionState(graph, 'exec-1');
  let iteration = 0;

  console.log('Research Pipeline — Event Graph Demo');
  console.log('====================================\n');

  while (true) {
    iteration++;
    const schedule = next(graph, state);

    console.log(`[iteration ${iteration}] eligible: [${schedule.eligibleTasks.join(', ')}]`);

    if (schedule.isComplete) {
      console.log('\n✅ Pipeline complete!');
      console.log('Available outputs:', state.availableOutputs);
      break;
    }

    if (schedule.stuckDetection.is_stuck) {
      console.error('\n❌ Pipeline stuck:', schedule.stuckDetection.stuck_description);
      break;
    }

    if (schedule.eligibleTasks.length === 0) {
      console.log('   (waiting for running tasks to complete)');
      // In a real system you'd await running task results here.
      break;
    }

    // Mark all eligible tasks as started
    const ts = new Date().toISOString();
    for (const taskName of schedule.eligibleTasks) {
      state = apply(state, { type: 'task-started', taskName, timestamp: ts }, graph);
    }

    // Execute in parallel
    const results = await Promise.all(
      schedule.eligibleTasks.map(async (taskName) => {
        try {
          const result = await executeTask(taskName);
          return { taskName, ok: true, result };
        } catch (err: unknown) {
          return { taskName, ok: false, error: (err as Error).message };
        }
      })
    );

    // Feed results back into the reducer
    for (const r of results) {
      const ts = new Date().toISOString();
      if (r.ok) {
        state = apply(state, { type: 'task-completed', taskName: r.taskName, result: r.result, timestamp: ts }, graph);
      } else {
        state = apply(state, { type: 'task-failed', taskName: r.taskName, error: r.error!, timestamp: ts }, graph);
      }
    }

    console.log(`   outputs so far: [${state.availableOutputs.join(', ')}]\n`);
  }
}

main().catch(console.error);
