/**
 * Portfolio Tracker — Correct Model
 *
 * Demonstrates externally-driven tasks, engine-stored data, data-changed
 * cascade, and retrigger via task-restart.
 *
 * Graph topology:
 *   portfolio-form  →  price-fetch  →  holdings-table  →  portfolio-value
 *     (external)       (handler)        (handler)          (handler)
 *
 * Key concepts:
 *   • portfolio-form has NO handler — it's user-editable.
 *     The caller pushes `task-completed` with data externally.
 *   • Engine persists `data` on GraphEngineStore (per-task state).
 *   • Downstream handlers read upstream data from engine state:
 *       ctx.live.state.tasks['portfolio-form'].data
 *   • data-changed refresh: reactive layer auto-hashes the data payload
 *     on external push. When the hash differs from previous, downstream
 *     tasks become re-eligible.
 *   • retrigger('price-fetch') sends a task-restart event through the
 *     engine, which resets the task and re-triggers the cascade.
 *
 * Timeline:
 *   T0: Empty board — graph wired, standing by
 *   T1: User submits 2 holdings → push task-completed for portfolio-form
 *       data-changed cascade: price-fetch → holdings-table → portfolio-value
 *   T2: User adds 3rd holding → push task-completed with new data
 *       new hash → identical cascade, fresh prices
 *   T3: Force price refresh without form change → retrigger('price-fetch')
 *   T4: Quiescent
 *
 * Run with: npx tsx examples/npm-libs/continuous-event-graph/portfolio-tracker.ts
 */

import type { GraphConfig } from '../../src/event-graph/types.js';
import { createReactiveGraph } from '../../src/continuous-event-graph/reactive.js';
import { validateReactiveGraph } from '../../src/continuous-event-graph/validate.js';
import { createCallbackHandler } from '../../src/continuous-event-graph/handlers.js';
import type { TaskHandlerFn, ReactiveGraph } from '../../src/continuous-event-graph/reactive.js';
import type { ResolveCallbackFn } from '../../src/continuous-event-graph/handlers.js';

// ============================================================================
// Simulated market data
// ============================================================================

const marketPrices: Record<string, number> = {
  AAPL: 198.50,
  MSFT: 425.30,
  GOOG: 178.90,
  AMZN: 192.40,
  TSLA: 168.75,
};

function fetchPrices(symbols: string[]): Record<string, number> {
  const prices: Record<string, number> = {};
  for (const sym of symbols) {
    prices[sym] = marketPrices[sym] ?? 0;
  }
  return prices;
}

// ============================================================================
// 1. Define the graph config
// ============================================================================

const config: GraphConfig = {
  id: 'portfolio-tracker',
  settings: {
    completion: 'manual',
    execution_mode: 'eligibility-mode',
    refreshStrategy: 'data-changed',
  },
  tasks: {
    'portfolio-form': {
      // No requires — root node, externally driven
      provides: ['portfolio-form'],
      description: 'Editable portfolio holdings (no handler — external push)',
    },
    'price-fetch': {
      requires: ['portfolio-form'],
      provides: ['price-fetch'],
      taskHandlers: ['price-fetch'],
      description: 'Fetch market prices for portfolio symbols',
    },
    'holdings-table': {
      requires: ['portfolio-form', 'price-fetch'],
      provides: ['holdings-table'],
      taskHandlers: ['holdings-table'],
      description: 'Join holdings × prices → table rows',
    },
    'portfolio-value': {
      requires: ['holdings-table'],
      provides: ['portfolio-value'],
      taskHandlers: ['portfolio-value'],
      description: 'Sum all holding values → total portfolio value',
    },
  },
};

// ============================================================================
// 2. Define handlers (portfolio-form has NONE — it's externally driven)
// ============================================================================

// Lazy resolver — graph doesn't exist at handler-creation time
let graphRef: ReactiveGraph;
const getResolve = (): ResolveCallbackFn => graphRef.resolveCallback.bind(graphRef);

const handlers: Record<string, TaskHandlerFn> = {
  // price-fetch: reads holdings from upstream state, fetches market prices
  'price-fetch': createCallbackHandler(async ({ state }) => {
    const formData = state['portfolio-form'] as
      { holdings?: Array<{ symbol: string; qty: number }> } | undefined;
    const symbols = (formData?.holdings ?? []).map(h => h.symbol);
    console.log(`  [price-fetch] Fetching prices for: ${symbols.join(', ') || '(none)'}`);
    const prices = fetchPrices(symbols);
    return { prices };
  }, getResolve),

  // holdings-table: reads form data + prices from upstream state, computes rows
  'holdings-table': createCallbackHandler(async ({ state }) => {
    const formData = state['portfolio-form'] as
      { holdings?: Array<{ symbol: string; qty: number }> } | undefined;
    const priceData = state['price-fetch'] as
      { prices?: Record<string, number> } | undefined;

    const holdings = formData?.holdings ?? [];
    const prices = priceData?.prices ?? {};

    const rows = holdings.map(h => ({
      symbol: h.symbol,
      qty: h.qty,
      price: prices[h.symbol] ?? 0,
      value: h.qty * (prices[h.symbol] ?? 0),
    }));
    console.log(`  [holdings-table] ${rows.length} rows computed`);
    rows.forEach(r =>
      console.log(`    ${r.symbol}: ${r.qty} × $${r.price.toFixed(2)} = $${r.value.toFixed(2)}`),
    );
    return { rows };
  }, getResolve),

  // portfolio-value: reads table rows from upstream state, sums values
  'portfolio-value': createCallbackHandler(async ({ state }) => {
    const tableData = state['holdings-table'] as
      { rows?: Array<{ value: number }> } | undefined;
    const rows = tableData?.rows ?? [];
    const totalValue = rows.reduce((sum, r) => sum + r.value, 0);
    console.log(`  [portfolio-value] Total: $${totalValue.toFixed(2)}`);
    return { totalValue };
  }, getResolve),
};

// ============================================================================
// 3. Create the reactive graph
// ============================================================================

const graph = createReactiveGraph(config, {
  handlers,
  onDrain: (events, live, result) => {
    const done = Object.values(live.state.tasks).filter(t => t.status === 'completed').length;
    const total = Object.keys(live.config.tasks).length;
    if (events.length > 0) {
      console.log(`  [drain] ${events.length} events, ${done}/${total} done, eligible: [${result.eligible.join(', ')}]`);
    }
  },
});
graphRef = graph;

// ============================================================================
// 4. T0: Empty board
// ============================================================================

console.log('=== Portfolio Tracker ===');
console.log(`Tasks: ${Object.keys(config.tasks).join(' → ')}`);
console.log(`portfolio-form has NO handler — externally driven\n`);

console.log('--- T0: Empty board ---');
console.log('  No holdings yet. Standing by.\n');

// ============================================================================
// 5. T1: User submits 2 holdings → external push for portfolio-form
// ============================================================================

console.log('--- T1: User adds AAPL (50 shares) and MSFT (30 shares) ---\n');

// External push — portfolio-form completes with data.
// The reactive layer auto-hashes the data payload.
// data-changed cascade triggers: price-fetch → holdings-table → portfolio-value
graph.push({
  type: 'task-completed',
  taskName: 'portfolio-form',
  data: {
    holdings: [
      { symbol: 'AAPL', qty: 50 },
      { symbol: 'MSFT', qty: 30 },
    ],
  },
  timestamp: new Date().toISOString(),
});

await sleep(2000);
printState('T1');

// ============================================================================
// 6. T2: User adds a 3rd holding → new data, new hash → cascade
// ============================================================================

console.log('\n--- T2: User adds GOOG (100 shares) ---\n');

// Same task, new data. Auto-hash differs → data-changed re-triggers downstream.
graph.push({
  type: 'task-completed',
  taskName: 'portfolio-form',
  data: {
    holdings: [
      { symbol: 'AAPL', qty: 50 },
      { symbol: 'MSFT', qty: 30 },
      { symbol: 'GOOG', qty: 100 },
    ],
  },
  timestamp: new Date().toISOString(),
});

await sleep(2000);
printState('T2');

// ============================================================================
// 7. T3: Force price refresh — retrigger without form change
// ============================================================================

console.log('\n--- T3: Force price refresh via retrigger ---\n');

// Simulate a price change
marketPrices.AAPL = 205.00;
console.log('  [simulated] AAPL price changed to $205.00');

// retrigger pushes a task-restart event through the engine
graph.retrigger('price-fetch');

await sleep(2000);
printState('T3');

// ============================================================================
// 8. T4: Quiescent
// ============================================================================

console.log('\n--- T4: No changes — board quiescent ---');
const sched = graph.getSchedule();
console.log(`  Eligible tasks: ${sched.eligible.length === 0 ? 'none' : sched.eligible.join(', ')}`);

// ============================================================================
// 9. Validate
// ============================================================================

console.log('\n--- Validation ---');
const validation = validateReactiveGraph({ graph, handlers });
console.log(`  Valid: ${validation.valid} (${validation.issues.length} issues)`);
for (const issue of validation.issues) {
  console.log(`    [${issue.severity}] ${issue.code}: ${issue.message}`);
}

graph.dispose();
console.log('\nDone.');

// ============================================================================
// Helpers
// ============================================================================

function printState(label: string): void {
  console.log(`\n--- ${label} Result ---`);
  const state = graph.getState();
  for (const [name, task] of Object.entries(state.state.tasks)) {
    const hash = task.lastDataHash ? ` (hash: ${task.lastDataHash.slice(0, 8)}…)` : '';
    console.log(`  ${name}: ${task.status} (${task.executionCount}x)${hash}`);
  }

  // Read portfolio value directly from engine state — no sharedState needed
  const valueData = state.state.tasks['portfolio-value']?.data as
    { totalValue?: number } | undefined;
  if (valueData?.totalValue != null) {
    console.log(`\n  Portfolio Value: $${valueData.totalValue.toFixed(2)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
