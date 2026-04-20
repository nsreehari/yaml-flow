/**
 * Continuous Event Graph Example: Stock Dashboard
 *
 * Demonstrates a long-lived, evolving graph where:
 *  - Nodes are added/removed at runtime (new data feeds)
 *  - Tokens are injected/drained (market data, signals)
 *  - mutateGraph applies multiple structural changes atomically
 *  - validateLiveGraph checks runtime state-consistency
 *  - Upstream/downstream analysis answers "what feeds X?" and "what breaks if X goes down?"
 *  - Scheduling adapts as the graph evolves
 *  - Snapshots allow persistence and restore
 *
 * Run with: npx tsx examples/npm-libs/continuous-event-graph/stock-dashboard.ts
 */

import {
  createLiveGraph,
  applyEvent,
  addNode,
  removeNode,
  injectTokens,
  drainTokens,
  schedule,
  inspect,
  disableNode,
  enableNode,
  getNode,
  getUpstream,
  getDownstream,
  getUnreachableTokens,
  snapshot,
  restore,
  mutateGraph,
  validateLiveGraph,
} from '../../src/continuous-event-graph/index.js';
import type { GraphConfig } from '../../src/continuous-event-graph/types.js';

// ============================================================================
// 1. Bootstrap: define the initial graph
// ============================================================================

const config: GraphConfig = {
  id: 'stock-dashboard',
  settings: {
    completion: 'manual', // never auto-completes — runs indefinitely
    execution_mode: 'eligibility-mode',
  },
  tasks: {
    fetch_prices: {
      provides: ['price-data'],
      description: 'Fetch live stock prices from market API',
    },
    fetch_news: {
      provides: ['news-data'],
      description: 'Fetch latest financial news',
    },
    compute_indicators: {
      requires: ['price-data'],
      provides: ['indicators'],
      description: 'Compute technical indicators (RSI, MACD, etc.)',
    },
    sentiment_analysis: {
      requires: ['news-data'],
      provides: ['sentiment'],
      description: 'Run NLP sentiment analysis on news',
    },
    generate_signals: {
      requires: ['indicators', 'sentiment'],
      provides: ['trade-signals'],
      description: 'Generate buy/sell signals from indicators + sentiment',
    },
    render_dashboard: {
      requires: ['price-data', 'trade-signals'],
      provides: ['dashboard-rendered'],
      description: 'Render the live dashboard UI',
    },
  },
};

let live = createLiveGraph(config);
console.log('=== Initial Graph ===');
console.log('Health:', inspect(live));
console.log('Schedule:', schedule(live));

// ============================================================================
// 2. Simulate first cycle: fetch data
// ============================================================================

// fetch_prices and fetch_news have no requires — they're eligible immediately
const sched1 = schedule(live);
console.log('\n=== Eligible tasks:', sched1.eligible);

// Simulate running fetch_prices
live = applyEvent(live, { type: 'task-started', taskName: 'fetch_prices', timestamp: new Date().toISOString() });
live = applyEvent(live, { type: 'task-completed', taskName: 'fetch_prices', timestamp: new Date().toISOString() });

// Simulate running fetch_news
live = applyEvent(live, { type: 'task-started', taskName: 'fetch_news', timestamp: new Date().toISOString() });
live = applyEvent(live, { type: 'task-completed', taskName: 'fetch_news', timestamp: new Date().toISOString() });

console.log('\n=== After data fetched ===');
console.log('Available tokens:', live.state.availableOutputs);
console.log('Schedule:', schedule(live));

// ============================================================================
// 3. Upstream/downstream analysis
// ============================================================================

console.log('\n=== Upstream of generate_signals ===');
const upstream = getUpstream(live, 'generate_signals');
console.log('Nodes:', upstream.nodes.map(n => `${n.nodeName} (provides: ${n.providesTokens})`));
console.log('Tokens in chain:', upstream.tokens);

console.log('\n=== Downstream of fetch_prices ===');
const downstream = getDownstream(live, 'fetch_prices');
console.log('Nodes:', downstream.nodes.map(n => `${n.nodeName} (requires: ${n.requiresTokens})`));
console.log('Tokens in chain:', downstream.tokens);

// ============================================================================
// 4. Dynamic evolution: add 3 new nodes atomically with mutateGraph
// ============================================================================

console.log('\n=== Adding social media nodes (batch mutation) ===');
live = mutateGraph(live, [
  {
    type: 'add-node',
    name: 'social_media_feed',
    config: {
      provides: ['social-data'],
      description: 'Fetch social media mentions for sentiment',
    },
  },
  {
    type: 'add-node',
    name: 'social_sentiment',
    config: {
      requires: ['social-data'],
      provides: ['social-sentiment'],
      description: 'Analyze social media sentiment',
    },
  },
  {
    type: 'add-node',
    name: 'enhanced_signals',
    config: {
      requires: ['trade-signals', 'social-sentiment'],
      provides: ['enhanced-signals'],
      description: 'Combine traditional + social signals',
    },
  },
]);

console.log('Health after adding nodes:', inspect(live));
console.log('New downstream of social_media_feed:', getDownstream(live, 'social_media_feed'));

// ============================================================================
// 5. Token lifecycle: drain stale data + re-inject (batch mutation)
// ============================================================================

console.log('\n=== Draining stale price-data and re-injecting ===');
live = mutateGraph(live, [
  { type: 'drain-tokens', tokens: ['price-data'] },
]);
console.log('Available tokens after drain:', live.state.availableOutputs);

// Check what became unreachable
const unreachable = getUnreachableTokens(live);
console.log('Unreachable tokens:', unreachable.tokens.map(t => `${t.token} (${t.reason})`));

// Re-inject fresh data
live = mutateGraph(live, [
  { type: 'inject-tokens', tokens: ['price-data'] },
]);
console.log('Tokens after re-inject:', live.state.availableOutputs);

// ============================================================================
// 6. Disable/enable a failing feed (batch mutation)
// ============================================================================

console.log('\n=== Disabling social_media_feed ===');
live = mutateGraph(live, [
  { type: 'disable-node', name: 'social_media_feed' },
]);
console.log('Node info:', getNode(live, 'social_media_feed'));

// Check impact
const impacted = getDownstream(live, 'social_media_feed');
console.log('Downstream impact:', impacted.nodes.map(n => n.nodeName));

// Re-enable after fix
live = mutateGraph(live, [
  { type: 'enable-node', name: 'social_media_feed' },
]);
console.log('Re-enabled:', getNode(live, 'social_media_feed')?.state.status);

// ============================================================================
// 7. Snapshot & restore (persistence)
// ============================================================================

console.log('\n=== Snapshot ===');
const snap = snapshot(live);
console.log('Snapshot version:', snap.version, 'at:', snap.snapshotAt);

// Simulate restore (e.g. after process restart)
const restored = restore(snap);
console.log('Restored graph tasks:', Object.keys(restored.config.tasks));
console.log('Restored available outputs:', restored.state.availableOutputs);

// ============================================================================
// 8. Remove a node cleanly
// ============================================================================

console.log('\n=== Removing enhanced_signals node ===');
live = removeNode(live, 'enhanced_signals');
console.log('Tasks after removal:', Object.keys(live.config.tasks));

console.log('\n=== Final Health ===');
console.log(inspect(live));

// ============================================================================
// 9. Validate — runtime state-consistency check
// ============================================================================

console.log('\n=== Validation ===');
const validation = validateLiveGraph(live);
console.log(`  Valid: ${validation.valid} (${validation.issues.length} issues)`);
for (const issue of validation.issues) {
  console.log(`    [${issue.severity}] ${issue.code}: ${issue.message}`);
}
