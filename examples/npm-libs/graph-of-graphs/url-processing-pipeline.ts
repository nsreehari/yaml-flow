/**
 * Graph-of-Graphs Example: URL Processing Pipeline
 *
 * Models the super-agent pattern: an outer event-graph orchestrates
 * coarse pipeline stages. The "evidence-gathering" stage fans out into
 * a batch where each URL item runs through its own inner event-graph DAG.
 *
 * Outer graph:
 *   prep → copy-inputs → evidence-batch → analyze → archive
 *
 * Inner graph (per URL):
 *   url-connects ──→ webpage-opens ──→ content-downloads → security-analyzer
 *                └──→ redirect-analyzer ─────────────────┘
 *
 * Demonstrates:
 *  - Event-graph as outer orchestrator
 *  - batch() with an inner event-graph processor
 *  - resolveVariables() for per-item config
 *  - resolveConfigTemplates() for DRY task configs
 *  - Parallel fan-out inside inner graph
 *
 * Run with: npx tsx examples/npm-libs/graph-of-graphs/url-processing-pipeline.ts
 */

import {
  next, apply, createInitialExecutionState,
} from '../../src/event-graph/index.js';
import { batch } from '../../src/batch/index.js';
import { resolveVariables, resolveConfigTemplates } from '../../src/config/index.js';
import type { GraphConfig } from '../../src/event-graph/types.js';

// ============================================================================
// 1. Inner graph config — evidence gathering per URL
//    Uses config-templates and ${ENTITY_ID} variables
// ============================================================================

const innerGraphTemplate: Record<string, unknown> = {
  id: 'url-evidence-gatherer',
  'config-templates': {
    'PYTHON-TOOL': { cmd: 'python', timeout: 30000, cwd: '/workdata' },
  },
  settings: {
    completion: 'only-dependency-resolved-outputs' as const,
    conflict_strategy: 'alphabetical' as const,
  },
  tasks: {
    'url-connects': {
      provides: ['connection-evidence'],
      config: {
        'config-template': 'PYTHON-TOOL',
        'cmd-args': 'url-connects.py ${ENTITY_ID}-input.json ${ENTITY_ID}-connection.json',
      },
    },
    'webpage-opens': {
      requires: ['connection-evidence'],
      provides: ['webpage-evidence'],
      config: {
        'config-template': 'PYTHON-TOOL',
        'cmd-args': 'webpage-opens.py ${ENTITY_ID}-input.json ${ENTITY_ID}-webpage.json',
      },
    },
    'redirect-analyzer': {
      requires: ['connection-evidence'],
      provides: ['redirect-evidence'],
      config: {
        'config-template': 'PYTHON-TOOL',
        'cmd-args': 'redirect-analyzer.py ${ENTITY_ID}-input.json ${ENTITY_ID}-redirect.json',
      },
    },
    'content-downloads': {
      requires: ['webpage-evidence'],
      provides: ['content-evidence'],
      config: {
        'config-template': 'PYTHON-TOOL',
        'cmd-args': 'content-downloads.py ${ENTITY_ID}-input.json ${ENTITY_ID}-content.json',
      },
    },
    'security-analyzer': {
      requires: ['content-evidence'],
      provides: ['security-evidence'],
      config: {
        'config-template': 'PYTHON-TOOL',
        'cmd-args': 'security-analyzer.py ${ENTITY_ID}-input.json ${ENTITY_ID}-security.json',
      },
    },
  },
};

// ============================================================================
// 2. Outer graph — pipeline orchestration
// ============================================================================

const outerGraph: GraphConfig = {
  id: 'url-processing-pipeline',
  settings: {
    completion: 'all-tasks-complete',
  },
  tasks: {
    'prep-workdata': {
      provides: ['workdata-prepared'],
    },
    'copy-input-files': {
      requires: ['workdata-prepared'],
      provides: ['input-files-copied'],
    },
    'evidence-gathering-batch': {
      requires: ['input-files-copied'],
      provides: ['evidence-complete'],
    },
    'analyze-results': {
      requires: ['evidence-complete'],
      provides: ['analysis-complete'],
    },
    'archive-results': {
      requires: ['analysis-complete'],
      provides: ['pipeline-done'],
    },
  },
};

// ============================================================================
// 3. Simulated task executors
// ============================================================================

/** Simulate executing an inner graph task (in real life: spawn python, call API, etc.) */
async function executeInnerTask(taskName: string, entityId: string): Promise<string> {
  await new Promise((r) => setTimeout(r, 10 + Math.random() * 30));
  return 'success';
}

/** Run one URL item through the inner evidence-gathering graph */
async function runInnerGraph(item: { id: string; url: string }) {
  // Step 1: resolve templates (expand config-template references)
  const templated = resolveConfigTemplates(innerGraphTemplate);
  // Step 2: resolve variables (per-item ENTITY_ID)
  const config = resolveVariables(templated, { ENTITY_ID: item.id }) as unknown as GraphConfig;

  // Step 3: drive the inner event-graph
  let state = createInitialExecutionState(config, `inner-${item.id}`);
  const taskResults: Record<string, string> = {};

  while (true) {
    const { eligibleTasks, isComplete } = next(config, state);
    if (isComplete) break;
    if (eligibleTasks.length === 0) break; // stuck

    // Run eligible tasks in parallel (they're independent by definition)
    await Promise.all(
      eligibleTasks.map(async (taskName) => {
        state = apply(state, { type: 'task-started', taskName, timestamp: new Date().toISOString() }, config);
        try {
          const result = await executeInnerTask(taskName, item.id);
          taskResults[taskName] = result;
          state = apply(state, { type: 'task-completed', taskName, result, timestamp: new Date().toISOString() }, config);
        } catch (err: any) {
          state = apply(state, { type: 'task-failed', taskName, error: err.message, timestamp: new Date().toISOString() }, config);
        }
      }),
    );
  }

  return { entityId: item.id, tokens: state.availableOutputs, taskResults };
}

// ============================================================================
// 4. Outer graph handlers
// ============================================================================

const urlItems = [
  { id: 'url-001', url: 'https://example.com/page1' },
  { id: 'url-002', url: 'https://example.com/page2' },
  { id: 'url-003', url: 'https://suspicious-site.xyz' },
  { id: 'url-004', url: 'https://example.com/page3' },
  { id: 'url-005', url: 'https://phishy-login.net/verify' },
  { id: 'url-006', url: 'https://example.com/page4' },
];

let pipelineContext: Record<string, unknown> = {};

const outerHandlers: Record<string, () => Promise<void>> = {
  'prep-workdata': async () => {
    console.log('  [prep] Creating fresh workdata directory');
    await new Promise((r) => setTimeout(r, 20));
  },
  'copy-input-files': async () => {
    console.log(`  [copy] Processing ${urlItems.length} URL items`);
    await new Promise((r) => setTimeout(r, 20));
  },
  'evidence-gathering-batch': async () => {
    console.log(`  [evidence-batch] Running ${urlItems.length} items through inner graph (concurrency: 3)`);
    const result = await batch(urlItems, {
      concurrency: 3,
      processor: runInnerGraph,
      onItemComplete: (item, res) => {
        console.log(`    ✓ ${item.id}: ${res.tokens.length} tokens collected — [${res.tokens.join(', ')}]`);
      },
      onItemError: (item, err) => {
        console.log(`    ✗ ${item.id}: ${err.message}`);
      },
    });
    pipelineContext['evidenceResults'] = result;
    console.log(`  [evidence-batch] Done: ${result.completed}/${result.total} succeeded (${result.durationMs}ms)`);
  },
  'analyze-results': async () => {
    console.log('  [analyze] Comparing evidence against expected grades');
    await new Promise((r) => setTimeout(r, 20));
  },
  'archive-results': async () => {
    console.log('  [archive] Moving results to output directory');
    await new Promise((r) => setTimeout(r, 20));
  },
};

// ============================================================================
// 5. Drive the outer graph
// ============================================================================

async function main() {
  console.log('=== URL Processing Pipeline (Graph-of-Graphs) ===\n');
  console.log(`Outer graph: ${Object.keys(outerGraph.tasks).length} stages`);
  console.log(`Inner graph: ${Object.keys(innerGraphTemplate.tasks as any).length} evidence tasks per URL`);
  console.log(`URL items: ${urlItems.length}\n`);

  let state = createInitialExecutionState(outerGraph, 'pipeline-run-1');
  const now = () => new Date().toISOString();

  while (true) {
    const { eligibleTasks, isComplete } = next(outerGraph, state);
    if (isComplete) break;
    if (eligibleTasks.length === 0) {
      console.log('\nPipeline stuck!');
      break;
    }

    // Run eligible outer tasks (sequential or parallel depending on graph shape)
    await Promise.all(
      eligibleTasks.map(async (taskName) => {
        console.log(`\n▶ ${taskName}`);
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

  console.log('\n=== Pipeline Complete ===');
  console.log('Available tokens:', state.availableOutputs);
}

main().catch(console.error);
