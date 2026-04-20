/**
 * Graph-of-Graphs Example: Multi-Stage ETL Pipeline
 *
 * An outer event-graph orchestrates an ETL pipeline where:
 *  - "extract" stage: batch × inner EVENT-GRAPH (parallel source extraction)
 *  - "transform" stage: batch × inner STEP-MACHINE (sequential validation pipeline)
 *  - "load" + "validate" stages: run in parallel after transform
 *
 * Demonstrates:
 *  - Mixed sub-graph modes (event-graph + step-machine in same pipeline)
 *  - Config templates shared across both inner configs
 *  - Variables resolved per-item in the batch
 *  - Fan-out / fan-in in the outer graph
 *
 * Outer graph:
 *   discover-sources → extract-batch → transform-batch → [load ∥ validate] → finalize
 *
 * Inner extract graph (event-graph, per source):
 *   connect → [fetch-metadata ∥ fetch-schema] → snapshot-data
 *
 * Inner transform flow (step-machine, per record):
 *   parse → validate → normalize → enrich → (accept | reject)
 *
 * Run with: npx tsx examples/npm-libs/graph-of-graphs/multi-stage-etl.ts
 */

import {
  next, apply, createInitialExecutionState,
} from '../../src/event-graph/index.js';
import { createStepMachine } from '../../src/step-machine/index.js';
import { batch } from '../../src/batch/index.js';
import { resolveVariables, resolveConfigTemplates } from '../../src/config/index.js';
import type { GraphConfig } from '../../src/event-graph/types.js';
import type { StepFlowConfig, StepHandler } from '../../src/step-machine/types.js';

// ============================================================================
// 1. Inner configs
// ============================================================================

// --- Extract: event-graph (parallel metadata + schema fetch) ---
const extractGraphTemplate: Record<string, unknown> = {
  id: 'source-extractor',
  'config-templates': {
    DB_CONN: { driver: 'pg', timeout: 10000, host: '${DB_HOST}' },
  },
  settings: {
    completion: 'all-tasks-complete' as const,
  },
  tasks: {
    connect: {
      provides: ['connected'],
      config: { 'config-template': 'DB_CONN', database: '${SOURCE_DB}' },
    },
    'fetch-metadata': {
      requires: ['connected'],
      provides: ['metadata-ready'],
      config: { 'config-template': 'DB_CONN', query: 'SELECT * FROM information_schema.tables' },
    },
    'fetch-schema': {
      requires: ['connected'],
      provides: ['schema-ready'],
      config: { 'config-template': 'DB_CONN', query: 'SELECT * FROM information_schema.columns' },
    },
    'snapshot-data': {
      requires: ['metadata-ready', 'schema-ready'],
      provides: ['snapshot-complete'],
      config: { 'config-template': 'DB_CONN', 'cmd-args': 'pg_dump ${SOURCE_DB}' },
    },
  },
};

// --- Transform: step-machine (sequential validation pipeline) ---
const transformFlow: StepFlowConfig = {
  id: 'record-transformer',
  settings: { start_step: 'parse', max_total_steps: 10 },
  steps: {
    parse: {
      produces_data: ['parsed_record'],
      transitions: { success: 'validate', error: 'reject' },
    },
    validate: {
      expects_data: ['parsed_record'],
      produces_data: ['validation_result'],
      transitions: { valid: 'normalize', invalid: 'reject' },
    },
    normalize: {
      expects_data: ['parsed_record'],
      produces_data: ['normalized_record'],
      transitions: { done: 'enrich' },
    },
    enrich: {
      expects_data: ['normalized_record'],
      produces_data: ['enriched_record'],
      transitions: { done: 'accept' },
    },
  },
  terminal_states: {
    accept: { return_intent: 'accepted', return_artifacts: ['enriched_record'] },
    reject: { return_intent: 'rejected', return_artifacts: ['validation_result'] },
  },
};

const transformHandlers: Record<string, StepHandler> = {
  parse: async (input) => {
    const raw = input.raw_data as string || '';
    if (!raw) return { result: 'error' };
    return { result: 'success', data: { parsed_record: JSON.parse(raw) } };
  },
  validate: async (input) => {
    const rec = input.parsed_record as Record<string, unknown>;
    if (!rec.id || !rec.name) return { result: 'invalid', data: { validation_result: 'missing required fields' } };
    return { result: 'valid', data: { validation_result: 'ok' } };
  },
  normalize: async (input) => {
    const rec = input.parsed_record as Record<string, unknown>;
    return { result: 'done', data: { normalized_record: { ...rec, name: (rec.name as string).trim().toLowerCase() } } };
  },
  enrich: async (input) => {
    const rec = input.normalized_record as Record<string, unknown>;
    return { result: 'done', data: { enriched_record: { ...rec, enriched_at: new Date().toISOString() } } };
  },
};

// ============================================================================
// 2. Outer graph
// ============================================================================

const outerGraph: GraphConfig = {
  id: 'etl-pipeline',
  settings: { completion: 'all-tasks-complete' },
  tasks: {
    'discover-sources': {
      provides: ['sources-discovered'],
    },
    'extract-batch': {
      requires: ['sources-discovered'],
      provides: ['extraction-complete'],
    },
    'transform-batch': {
      requires: ['extraction-complete'],
      provides: ['transform-complete'],
    },
    'load-to-warehouse': {
      requires: ['transform-complete'],
      provides: ['load-complete'],
    },
    'validate-integrity': {
      requires: ['transform-complete'],
      provides: ['validation-complete'],
    },
    'finalize': {
      requires: ['load-complete', 'validation-complete'],
      provides: ['pipeline-done'],
    },
  },
};

// ============================================================================
// 3. Sub-graph drivers
// ============================================================================

/** Drive one source through the extract event-graph */
async function runExtractGraph(source: { id: string; db: string }) {
  const config = resolveVariables(
    resolveConfigTemplates(extractGraphTemplate),
    { SOURCE_DB: source.db, DB_HOST: 'db.internal' },
  ) as unknown as GraphConfig;

  let state = createInitialExecutionState(config, `extract-${source.id}`);
  while (true) {
    const { eligibleTasks, isComplete } = next(config, state);
    if (isComplete || eligibleTasks.length === 0) break;
    await Promise.all(
      eligibleTasks.map(async (taskName) => {
        state = apply(state, { type: 'task-started', taskName, timestamp: new Date().toISOString() }, config);
        await new Promise((r) => setTimeout(r, 5 + Math.random() * 15)); // simulate work
        state = apply(state, { type: 'task-completed', taskName, timestamp: new Date().toISOString() }, config);
      }),
    );
  }
  return { sourceId: source.id, tokens: state.availableOutputs };
}

/** Drive one record through the transform step-machine */
async function runTransformFlow(record: { id: string; raw_data: string }) {
  const machine = createStepMachine(transformFlow, transformHandlers);
  return machine.run({ raw_data: record.raw_data });
}

// ============================================================================
// 4. Sample data
// ============================================================================

const sources = [
  { id: 'src-orders', db: 'orders_db' },
  { id: 'src-users', db: 'users_db' },
  { id: 'src-products', db: 'products_db' },
];

const records = [
  { id: 'rec-1', raw_data: '{"id": 1, "name": "  Alice "}' },
  { id: 'rec-2', raw_data: '{"id": 2, "name": " Bob  "}' },
  { id: 'rec-3', raw_data: '{"name": "no-id"}' },             // will be rejected (no id)
  { id: 'rec-4', raw_data: '' },                                // will fail to parse
  { id: 'rec-5', raw_data: '{"id": 5, "name": " Charlie "}' },
  { id: 'rec-6', raw_data: '{"id": 6, "name": " Diana  "}' },
];

// ============================================================================
// 5. Outer graph handlers
// ============================================================================

const outerHandlers: Record<string, () => Promise<void>> = {
  'discover-sources': async () => {
    console.log(`  Found ${sources.length} data sources`);
  },

  'extract-batch': async () => {
    console.log(`  Extracting from ${sources.length} sources (concurrency: 2, mode: event-graph)`);
    const result = await batch(sources, {
      concurrency: 2,
      processor: runExtractGraph,
      onItemComplete: (src, res) => {
        console.log(`    ✓ ${src.id} (${src.db}): [${res.tokens.join(', ')}]`);
      },
    });
    console.log(`  Extract done: ${result.completed}/${result.total} in ${result.durationMs}ms`);
  },

  'transform-batch': async () => {
    console.log(`  Transforming ${records.length} records (concurrency: 4, mode: step-machine)`);
    const result = await batch(records, {
      concurrency: 4,
      processor: runTransformFlow,
      onItemComplete: (rec, res) => {
        console.log(`    ✓ ${rec.id}: ${res.intent} — [${res.stepHistory.join(' → ')}]`);
      },
      onItemError: (rec, err) => {
        console.log(`    ✗ ${rec.id}: ${err.message}`);
      },
    });
    console.log(`  Transform done: ${result.completed} ok, ${result.failed} failed in ${result.durationMs}ms`);

    // Show accepted vs rejected
    const accepted = result.items.filter((i) => i.status === 'completed' && i.result?.intent === 'accepted');
    const rejected = result.items.filter((i) => i.status === 'completed' && i.result?.intent === 'rejected');
    console.log(`  Accepted: ${accepted.length}, Rejected: ${rejected.length}`);
  },

  'load-to-warehouse': async () => {
    console.log('  Loading accepted records to data warehouse');
    await new Promise((r) => setTimeout(r, 20));
  },

  'validate-integrity': async () => {
    console.log('  Running integrity checks on loaded data');
    await new Promise((r) => setTimeout(r, 15));
  },

  'finalize': async () => {
    console.log('  Generating ETL summary report');
  },
};

// ============================================================================
// 6. Drive outer graph
// ============================================================================

async function main() {
  console.log('=== Multi-Stage ETL Pipeline (Graph-of-Graphs) ===');
  console.log('Outer: event-graph | Extract sub: event-graph | Transform sub: step-machine\n');

  let state = createInitialExecutionState(outerGraph, 'etl-run-1');
  const now = () => new Date().toISOString();

  while (true) {
    const { eligibleTasks, isComplete } = next(outerGraph, state);
    if (isComplete) break;
    if (eligibleTasks.length === 0) {
      console.log('\nPipeline stuck!');
      break;
    }

    // Note: load-to-warehouse and validate-integrity will run in PARALLEL
    // because they both only require transform-complete
    if (eligibleTasks.length > 1) {
      console.log(`\n▶ [parallel] ${eligibleTasks.join(' + ')}`);
    }
    await Promise.all(
      eligibleTasks.map(async (taskName) => {
        if (eligibleTasks.length === 1) console.log(`\n▶ ${taskName}`);
        state = apply(state, { type: 'task-started', taskName, timestamp: now() }, outerGraph);
        try {
          await outerHandlers[taskName]();
          state = apply(state, { type: 'task-completed', taskName, timestamp: now() }, outerGraph);
        } catch (err: any) {
          state = apply(state, { type: 'task-failed', taskName, error: err.message, timestamp: now() }, outerGraph);
        }
      }),
    );
  }

  console.log('\n=== ETL Pipeline Complete ===');
  console.log('Final tokens:', state.availableOutputs);
}

main().catch(console.error);
