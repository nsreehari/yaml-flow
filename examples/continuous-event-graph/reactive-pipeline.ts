/**
 * Reactive Graph Example: Data Pipeline
 *
 * A simple ETL pipeline that drives itself.
 * Register handlers → push one event → the graph runs to completion.
 *
 * Demonstrates:
 *  - createCallbackHandler for wrapping async functions
 *  - validateLiveGraph for runtime state-consistency checks
 *  - validateReactiveGraph for handler/dispatch checks
 *
 * Run with: npx tsx examples/continuous-event-graph/reactive-pipeline.ts
 */

import {
  createReactiveGraph,
  createCallbackHandler,
  validateLiveGraph,
  validateReactiveGraph,
} from '../../src/continuous-event-graph/index.js';
import type { GraphConfig } from '../../src/continuous-event-graph/types.js';
import type { ReactiveGraph } from '../../src/continuous-event-graph/reactive.js';
import type { ResolveCallbackFn } from '../../src/continuous-event-graph/handlers.js';

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
      taskHandlers: ['extract'],
      description: 'Pull records from source API',
    },
    validate: {
      requires: ['raw-data'],
      provides: ['valid-data'],
      taskHandlers: ['validate'],
      description: 'Validate and clean records',
    },
    enrich: {
      requires: ['valid-data'],
      provides: ['enriched-data'],
      taskHandlers: ['enrich'],
      description: 'Enrich with external metadata',
    },
    load: {
      requires: ['enriched-data'],
      provides: ['loaded'],
      taskHandlers: ['load'],
      description: 'Write to destination database',
    },
  },
};

// ============================================================================
// 2. Create the reactive graph with handlers
// ============================================================================

// Handlers use createCallbackHandler — a thin wrapper for type safety.
// Lazy resolver pattern: graph doesn't exist at handler-creation time.
// Note: no explicit dataHash! The reactive layer auto-computes SHA-256
// from the data payload, so the data-changed refresh strategy works
// out of the box with zero handler effort.

let graphRef: ReactiveGraph;
const getResolve = (): ResolveCallbackFn => graphRef.resolveCallback.bind(graphRef);

const handlers = {
  extract: createCallbackHandler(async ({ nodeId }) => {
    console.log(`  [${nodeId}] Fetching 1,000 records from source API...`);
    await sleep(200);
    return { recordCount: 1000 };
  }, getResolve),

  validate: createCallbackHandler(async ({ nodeId }) => {
    console.log(`  [${nodeId}] Validating records...`);
    await sleep(100);
    console.log(`  [${nodeId}] 980 valid, 20 rejected`);
    return { valid: 980, rejected: 20 };
  }, getResolve),

  enrich: createCallbackHandler(async ({ nodeId }) => {
    console.log(`  [${nodeId}] Enriching with geo + company data...`);
    await sleep(150);
    return { enrichedCount: 980 };
  }, getResolve),

  load: createCallbackHandler(async ({ nodeId }) => {
    console.log(`  [${nodeId}] Writing 980 records to database...`);
    await sleep(100);
    console.log(`  [${nodeId}] Done.`);
    return { written: 980 };
  }, getResolve),
};

const rg = createReactiveGraph(config, {
  handlers,

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
});
graphRef = rg;

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
  const hash = task.lastDataHash ? ` (hash: ${task.lastDataHash})` : '';
  console.log(`  ${name}: ${task.status} (executed ${task.executionCount}x)${hash}`);
}
console.log(`\n  Outputs: [${state.state.availableOutputs.join(', ')}]`);

// ============================================================================
// 4. Validate — runtime state-consistency checks
// ============================================================================

console.log('\n=== Validation ===');

// validateLiveGraph: checks state/config consistency
const liveResult = validateLiveGraph(state);
console.log(`  LiveGraph valid: ${liveResult.valid} (${liveResult.issues.length} issues)`);
for (const issue of liveResult.issues) {
  console.log(`    [${issue.severity}] ${issue.code}: ${issue.message}`);
}

// validateReactiveGraph: checks handler/dispatch consistency + all live checks
const reactiveResult = validateReactiveGraph({ graph: rg, handlers });
console.log(`  ReactiveGraph valid: ${reactiveResult.valid} (${reactiveResult.issues.length} issues)`);
for (const issue of reactiveResult.issues) {
  console.log(`    [${issue.severity}] ${issue.code}: ${issue.message}`);
}

rg.dispose();

// ============================================================================
// Util
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
