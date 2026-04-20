/**
 * Inference Example: Data Pipeline with Evidence Accumulation
 *
 * Demonstrates iterative inference — run the LLM multiple times as
 * new evidence arrives. Each round may unlock more tasks.
 *
 * Run with: npx tsx examples/npm-libs/inference/data-pipeline.ts
 */

import {
  createLiveGraph,
  injectTokens,
  schedule,
} from '../../src/continuous-event-graph/index.js';
import {
  inferAndApply,
} from '../../src/inference/index.js';
import type { InferenceAdapter } from '../../src/inference/index.js';
import type { GraphConfig } from '../../src/continuous-event-graph/types.js';

// ============================================================================
// 1. Define a data processing pipeline
// ============================================================================

const config: GraphConfig = {
  settings: { completion: 'all-tasks' },
  tasks: {
    'data-ingested': {
      provides: ['raw-data'],
      description: 'Raw data landed in blob storage',
      inference: {
        criteria: 'CSV/JSON files present in data-lake/raw/ folder',
        keywords: ['blob-storage', 'data-lake', 'csv', 'json', 'ingestion'],
        autoDetectable: true,
      },
    },
    'schema-validated': {
      requires: ['raw-data'],
      provides: ['validated-data'],
      description: 'Data schema validation passed',
      inference: {
        criteria: 'Schema validation passed with 0 errors',
        keywords: ['schema', 'validation', 'data-quality'],
        suggestedChecks: ['check validation report for error_count = 0'],
        autoDetectable: true,
      },
    },
    'transformed': {
      requires: ['validated-data'],
      provides: ['clean-data'],
      description: 'Data transformed and cleaned',
      inference: {
        criteria: 'Transform job completed, output in data-lake/clean/',
        keywords: ['transform', 'etl', 'spark', 'clean-data'],
        autoDetectable: true,
      },
    },
    'loaded-to-warehouse': {
      requires: ['clean-data'],
      provides: ['warehouse-ready'],
      description: 'Data loaded into analytics warehouse',
      inference: {
        criteria: 'Row count in warehouse matches expected count',
        keywords: ['warehouse', 'snowflake', 'bigquery', 'load'],
        suggestedChecks: ['compare row counts', 'check for null PKs'],
        autoDetectable: true,
      },
    },
  },
};

// ============================================================================
// 2. Simulate evidence arriving in waves
// ============================================================================

async function main() {
  let live = createLiveGraph(config);
  console.log('=== Data Pipeline with Iterative Inference ===\n');

  // --- Wave 1: Ingestion evidence ---
  console.log('📥 Wave 1: Ingestion logs arrive');

  let round1Adapter: InferenceAdapter = {
    analyze: async () => JSON.stringify([
      { taskName: 'data-ingested', confidence: 0.92, reasoning: '45 CSV files found in data-lake/raw/2025-11-16/' },
      { taskName: 'schema-validated', confidence: 0.1, reasoning: 'No validation report found yet' },
    ]),
  };

  let result = await inferAndApply(live, round1Adapter, {
    threshold: 0.8,
    context: 'Blob storage event: 45 files uploaded to data-lake/raw/2025-11-16/',
  });

  live = result.live;
  console.log(`  Applied: ${result.applied.map(s => s.taskName).join(', ') || 'none'}`);
  console.log(`  Schedule: ${schedule(live).eligible.join(', ')}`);

  // --- Wave 2: Validation report ---
  console.log('\n📋 Wave 2: Validation report generated');

  let round2Adapter: InferenceAdapter = {
    analyze: async () => JSON.stringify([
      { taskName: 'schema-validated', confidence: 0.96, reasoning: 'Validation report: 0 errors, 45 files passed, 3 warnings (non-blocking)' },
      { taskName: 'transformed', confidence: 0.05, reasoning: 'No transform job output detected' },
    ]),
  };

  result = await inferAndApply(live, round2Adapter, {
    threshold: 0.8,
    context: 'Validation report: {errors: 0, passed: 45, warnings: 3, status: "PASS"}',
  });

  live = result.live;
  console.log(`  Applied: ${result.applied.map(s => s.taskName).join(', ') || 'none'}`);
  console.log(`  Schedule: ${schedule(live).eligible.join(', ')}`);

  // --- Wave 3: Transform + Load evidence ---
  console.log('\n🔄 Wave 3: Transform and load complete');

  let round3Adapter: InferenceAdapter = {
    analyze: async () => JSON.stringify([
      { taskName: 'transformed', confidence: 0.91, reasoning: 'Spark job completed, 45 parquet files in data-lake/clean/' },
      { taskName: 'loaded-to-warehouse', confidence: 0.87, reasoning: 'Warehouse row count 1.2M matches expected, no null PKs' },
    ]),
  };

  result = await inferAndApply(live, round3Adapter, {
    threshold: 0.8,
    context: 'Spark job: COMPLETED (45→45 files). Warehouse load: 1,200,000 rows, 0 null PKs.',
  });

  live = result.live;
  console.log(`  Applied: ${result.applied.map(s => s.taskName).join(', ') || 'none'}`);

  // --- Final state ---
  console.log('\n=== Final Pipeline State ===');
  for (const [name, state] of Object.entries(live.state.tasks)) {
    console.log(`  ${name}: ${state.status}`);
  }
  console.log(`  Tokens: ${live.state.availableOutputs.join(', ')}`);
  console.log(`  All complete: ${Object.values(live.state.tasks).every(t => t.status === 'completed')}`);
}

main().catch(console.error);
