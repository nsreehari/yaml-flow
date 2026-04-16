/**
 * Live Cards → Reactive Graph Example: Board Dashboard
 *
 * Demonstrates `liveCardsToReactiveGraph` — the bridge that converts
 * live card / source JSON definitions into a fully wired ReactiveGraph.
 *
 * This example shows both overloads:
 *   1. Flat array of cards  → reactive graph
 *   2. LiveBoard object     → reactive graph (with board-level id/settings)
 *
 * Features exercised:
 *  - Source nodes with pre-populated state (static data feeds)
 *  - Custom sourceHandlers (simulated API fetch)
 *  - Card nodes with compute expressions (sum, avg, count, template)
 *  - Cross-card data flow via data.requires / data.provides
 *  - LiveBoard overload — board.id, board.settings forwarded to GraphConfig
 *  - validateReactiveGraph on the resulting graph
 *
 * Run with: npx tsx examples/continuous-event-graph/live-cards-board.ts
 */

import {
  liveCardsToReactiveGraph,
  validateReactiveGraph,
} from '../../src/continuous-event-graph/index.js';
import type { LiveCard, LiveBoard } from '../../src/continuous-event-graph/index.js';

// ============================================================================
// 1. Flat cards array → Reactive Graph
// ============================================================================

console.log('=== Part 1: Flat cards array ===\n');

const cards: LiveCard[] = [
  {
    id: 'market-feed',
    type: 'source',
    meta: { title: 'Live Market Prices' },
    state: { prices: [142.5, 305.8, 89.2, 211.0, 178.3] },
    source: { kind: 'static', bindTo: 'state.prices' },
  },
  {
    id: 'stats',
    type: 'card',
    meta: { title: 'Price Statistics' },
    state: {},
    data: { requires: ['market-feed'] },
    compute: {
      total: { fn: 'sum', input: 'state.market-feed.prices' },
      avg: { fn: 'avg', input: 'state.market-feed.prices' },
      count: { fn: 'count', input: 'state.market-feed.prices' },
    },
  },
  {
    id: 'summary',
    type: 'card',
    meta: { title: 'Summary Label' },
    state: {},
    data: { requires: ['stats'] },
    compute: {
      label: {
        fn: 'template',
        input: 'state.stats',
        format: '{{count}} stocks — total ${{total}}, avg ${{avg}}',
      },
    },
  },
];

const flatResult = liveCardsToReactiveGraph(cards, {
});

console.log('Graph ID:', flatResult.config.id);
console.log('Tasks:', Object.keys(flatResult.config.tasks).join(', '));
console.log('Pushing trigger event...\n');

flatResult.graph.push({
  type: 'inject-tokens',
  tokens: [],
  timestamp: new Date().toISOString(),
});

await sleep(1000);

const flatState = flatResult.graph.getState();
for (const [name, task] of Object.entries(flatState.state.tasks)) {
  const hash = task.lastDataHash ? ` (hash: ${task.lastDataHash.slice(0, 8)}…)` : '';
  console.log(`  ${name}: ${task.status}${hash}`);
}
console.log(`  Outputs: [${flatState.state.availableOutputs.join(', ')}]`);

flatResult.graph.dispose();

// ============================================================================
// 2. LiveBoard → Reactive Graph
// ============================================================================

console.log('\n=== Part 2: LiveBoard overload ===\n');

const board: LiveBoard = {
  id: 'portfolio-board',
  title: 'Portfolio Analytics Dashboard',
  mode: 'board',
  positions: {
    'equity-feed':   { x: 0, y: 0, w: 300, h: 200 },
    'bond-feed':     { x: 320, y: 0, w: 300, h: 200 },
    'portfolio-mix': { x: 160, y: 240, w: 300, h: 200 },
    'risk-summary':  { x: 160, y: 480, w: 300, h: 200 },
  },
  settings: {
    completion: 'manual',
  },
  nodes: [
    {
      id: 'equity-feed',
      type: 'source',
      meta: { title: 'Equity Prices' },
      state: {},
      source: { kind: 'api', bindTo: 'state.raw', url_template: 'https://api.example.com/equity' },
    },
    {
      id: 'bond-feed',
      type: 'source',
      meta: { title: 'Bond Yields' },
      state: { yields: [3.2, 4.1, 2.8, 5.0] },
      source: { kind: 'static', bindTo: 'state.yields' },
    },
    {
      id: 'portfolio-mix',
      type: 'card',
      meta: { title: 'Portfolio Mix Calculator' },
      state: {},
      data: { requires: ['equity-feed', 'bond-feed'] },
      compute: {
        equity_total: { fn: 'sum', input: 'state.equity-feed.prices' },
        bond_total: { fn: 'sum', input: 'state.bond-feed.yields' },
      },
    },
    {
      id: 'risk-summary',
      type: 'card',
      meta: { title: 'Risk Summary' },
      state: {},
      data: { requires: ['portfolio-mix'] },
      compute: {
        label: {
          fn: 'template',
          input: 'state.portfolio-mix',
          format: 'Equities: ${{equity_total}} | Bonds: {{bond_total}}%',
        },
      },
    },
  ],
};

const boardResult = liveCardsToReactiveGraph(board, {
  // Custom handler for the API-based source — simulates a fetch
  sourceHandlers: {
    'equity-feed': async ({ callbackToken }) => {
      console.log('  [equity-feed] Simulating API fetch...');
      await sleep(100);
      // Use the graph to resolve — bridge wires this up automatically
      boardResult.graph.resolveCallback(callbackToken, { prices: [155.2, 310.4, 92.1, 220.5] });
      return 'task-initiated' as const;
    },
  },
});

console.log('Board ID:',     boardResult.config.id);
console.log('Completion:',   boardResult.config.settings.completion);
console.log('Tasks:',        Object.keys(boardResult.config.tasks).join(', '));
console.log('Cards in map:', boardResult.cards.size);
console.log();

// Push and run
boardResult.graph.push({
  type: 'inject-tokens',
  tokens: [],
  timestamp: new Date().toISOString(),
});

await sleep(1500);

const boardState = boardResult.graph.getState();
console.log('Final task states:');
for (const [name, task] of Object.entries(boardState.state.tasks)) {
  const hash = task.lastDataHash ? ` (hash: ${task.lastDataHash.slice(0, 8)}…)` : '';
  console.log(`  ${name}: ${task.status} (executed ${task.executionCount}x)${hash}`);
}
console.log(`  Outputs: [${boardState.state.availableOutputs.join(', ')}]`);

// ============================================================================
// 3. Validate the reactive graph
// ============================================================================

console.log('\n=== Validation ===');
const validation = validateReactiveGraph({
  graph: boardResult.graph,
  handlers: boardResult.handlers,
});
console.log(`  Valid: ${validation.valid} (${validation.issues.length} issues)`);
for (const issue of validation.issues) {
  console.log(`    [${issue.severity}] ${issue.code}: ${issue.message}`);
}

boardResult.graph.dispose();
console.log('\nDone.');

// ============================================================================
// Util
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
