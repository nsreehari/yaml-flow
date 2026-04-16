/**
 * Reactive Graph Example: Data Pipeline
 *
 * A simple ETL pipeline that drives itself.
 * Register handlers → push one event → the graph runs to completion.
 *
 * Run with: npx tsx examples/continuous-event-graph/reactive-pipeline.ts
 */

import {
  createReactiveGraph,
} from '../../src/continuous-event-graph/index.js';
import type { GraphConfig } from '../../src/continuous-event-graph/types.js';

// ============================================================================
// 1. Define the graph
// ============================================================================

const config: GraphConfig = {
  id: 'etl-pipeline',
  settings: {
    completion: 'all-tasks-done',
    execution_mode: 'eligibility-mode',
  },
  tasks: {
    extract: {
      provides: ['raw-data'],
      description: 'Pull records from source API',
    },
    validate: {
      requires: ['raw-data'],
      provides: ['valid-data'],
      description: 'Validate and clean records',
    },
    enrich: {
      requires: ['valid-data'],
      provides: ['enriched-data'],
      description: 'Enrich with external metadata',
    },
    load: {
      requires: ['enriched-data'],
      provides: ['loaded'],
      description: 'Write to destination database',
    },
  },
};

// ============================================================================
// 2. Create the reactive graph with handlers
// ============================================================================

const rg = createReactiveGraph(config, {
  handlers: {
    extract: async ({ taskName }) => {
      console.log(`  [${taskName}] Fetching 1,000 records from source API...`);
      await sleep(200);
      return { data: { recordCount: 1000 }, dataHash: 'extract-v1' };
    },

    validate: async ({ taskName }) => {
      console.log(`  [${taskName}] Validating records...`);
      await sleep(100);
      console.log(`  [${taskName}] 980 valid, 20 rejected`);
      return { data: { valid: 980, rejected: 20 }, dataHash: 'validate-v1' };
    },

    enrich: async ({ taskName }) => {
      console.log(`  [${taskName}] Enriching with geo + company data...`);
      await sleep(150);
      return { data: { enrichedCount: 980 }, dataHash: 'enrich-v1' };
    },

    load: async ({ taskName }) => {
      console.log(`  [${taskName}] Writing 980 records to database...`);
      await sleep(100);
      console.log(`  [${taskName}] Done.`);
      return { data: { written: 980 } };
    },
  },

  onDrain: (events, live, scheduleResult) => {
    const completedCount = Object.values(live.state.tasks)
      .filter(t => t.status === 'completed').length;
    const total = Object.keys(live.config.tasks).length;
    console.log(
      `  [drain] ${events.length} events processed, ` +
      `${completedCount}/${total} tasks done, ` +
      `${scheduleResult.eligible.length} eligible`,
    );
  },

  defaultTimeoutMs: 10_000,
});

// ============================================================================
// 3. Push one event — the graph drives itself
// ============================================================================

console.log('=== Reactive ETL Pipeline ===\n');
console.log('Pushing initial trigger...\n');

rg.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });

// Wait for the pipeline to complete
await sleep(2000);

// Check final state
const state = rg.getState();
console.log('\n=== Final State ===');
for (const [name, task] of Object.entries(state.state.tasks)) {
  console.log(`  ${name}: ${task.status} (executed ${task.executionCount}x)`);
}
console.log(`\n  Outputs: [${state.state.availableOutputs.join(', ')}]`);

rg.dispose();

// ============================================================================
// Util
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
