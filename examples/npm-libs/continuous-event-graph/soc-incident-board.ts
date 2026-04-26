/**
 * SOC Incident Board — Correct Model
 *
 * A Security Operations Center dashboard demonstrating:
 *   • External data source_defs (alert-feed, threat-intel) — NO handlers
 *   • Handler-driven compute (severity-score, blast-radius)
 *   • Fire-and-forget side effects (slack-alert, create-ticket)
 *   • Per-task refreshStrategy: 'once' on create-ticket (no duplicate tickets)
 *   • retrigger for data refresh without resetting the entire graph
 *   • All data read from engine state — no sharedState workaround
 *
 * Topology:
 *   ┌─────────────┐   ┌──────────────┐
 *   │ alert-feed   │   │ threat-intel  │   ← external push (no handler)
 *   └──────┬───────┘   └──────┬───────┘
 *          └────────┬─────────┘
 *                   ▼
 *           ┌───────────────┐
 *           │ severity-score │             ← compute (handler)
 *           └───────┬───────┘
 *                   │
 *          ┌────────┼──────────┐
 *          ▼        ▼          ▼
 *   ┌────────────┐ ┌────────┐ ┌──────────────┐
 *   │blast-radius│ │ slack  │ │create-ticket  │  ← side-effect handlers
 *   └────────────┘ └────────┘ └──────────────┘
 *                               (once only)
 *
 * Timeline:
 *   T0: External push of alert-feed + threat-intel data → cascade
 *   T1: New intel arrives → retrigger threat-intel → data-changed cascade
 *       create-ticket skipped (once) — slack re-fires
 *
 * Run with: npx tsx examples/npm-libs/continuous-event-graph/soc-incident-board.ts
 */

import type { GraphConfig } from '../../src/event-graph/types.js';
import { createReactiveGraph } from '../../src/continuous-event-graph/reactive.js';
import { validateReactiveGraph } from '../../src/continuous-event-graph/validate.js';
import { createCallbackHandler, createFireAndForgetHandler } from '../../src/continuous-event-graph/handlers.js';
import type { TaskHandlerFn, ReactiveGraph } from '../../src/continuous-event-graph/reactive.js';
import type { ResolveCallbackFn } from '../../src/continuous-event-graph/handlers.js';

// ============================================================================
// Simulated data
// ============================================================================

const siemAlerts = [
  { id: 'A-001', ioc: '185.220.101.42', severity: 'high', type: 'brute-force' },
  { id: 'A-002', ioc: 'evil-payload.exe', severity: 'critical', type: 'malware' },
];

const threatIntelV1 = [
  { ioc: '185.220.101.42', classification: 'known-attacker', confidence: 0.92 },
  { ioc: 'evil-payload.exe', classification: 'apt-tool', confidence: 0.88 },
];

const threatIntelV2 = [
  { ioc: '185.220.101.42', classification: 'false-positive', confidence: 0.15 },
  { ioc: 'evil-payload.exe', classification: 'apt-tool', confidence: 0.88 },
  { ioc: 'new-c2-domain.net', classification: 'c2-server', confidence: 0.95 },
];

// Side-effect log for verification
const sideEffects: string[] = [];

// ============================================================================
// 1. Define the graph config
// ============================================================================

const config: GraphConfig = {
  id: 'soc-incident-board',
  settings: {
    completion: 'manual',
    execution_mode: 'eligibility-mode',
    refreshStrategy: 'data-changed',
  },
  tasks: {
    // External source_defs — no handler, data pushed externally
    'alert-feed': {
      provides: ['alert-feed'],
      description: 'SIEM alert feed (external push)',
    },
    'threat-intel': {
      provides: ['threat-intel'],
      description: 'Threat intelligence STIX feed (external push)',
    },

    // Compute: correlate alerts against threat intel
    'severity-score': {
      requires: ['alert-feed', 'threat-intel'],
      provides: ['severity-score'],
      taskHandlers: ['severity-score'],
      description: 'Severity scoring engine',
    },

    // Side-effect: blast radius analysis
    'blast-radius': {
      requires: ['severity-score'],
      provides: ['blast-radius'],
      taskHandlers: ['blast-radius'],
      description: 'Blast radius: affected services',
    },

    // Side-effect: Slack alert (fires on every data change)
    'slack-alert': {
      requires: ['severity-score'],
      provides: ['slack-alert'],
      taskHandlers: ['slack-alert'],
      description: 'Slack #incident-response notification',
    },

    // Side-effect: ServiceNow ticket (runs ONCE — no duplicate tickets)
    'create-ticket': {
      requires: ['severity-score'],
      provides: ['create-ticket'],
      taskHandlers: ['create-ticket'],
      refreshStrategy: 'once',
      description: 'ServiceNow ticket creation (once only)',
    },
  },
};

// ============================================================================
// 2. Define handlers — only for compute + side-effect tasks
//    (alert-feed, threat-intel have NO handler — externally driven)
// ============================================================================

// Lazy resolver — graph doesn't exist at handler-creation time
let graphRef: ReactiveGraph;
const getResolve = (): ResolveCallbackFn => graphRef.resolveCallback.bind(graphRef);

const handlers: Record<string, TaskHandlerFn> = {
  'severity-score': createCallbackHandler(async ({ state }) => {
    await sleep(50);
    const alerts = (state['alert-feed'] as
      { alerts?: typeof siemAlerts })?.alerts ?? [];
    const intel = (state['threat-intel'] as
      { intel?: typeof threatIntelV1 })?.intel ?? [];

    const iocSet = new Set(intel.map(i => i.ioc));
    const matched = alerts.filter(a => iocSet.has(a.ioc));
    const score = Math.round((matched.length / Math.max(alerts.length, 1)) * 100);
    const avgConfidence = intel.length > 0
      ? Math.round(intel.reduce((s, i) => s + i.confidence, 0) / intel.length * 100)
      : 0;
    console.log(`  [severity-score] Score: ${score}/100, Confidence: ${avgConfidence}%, Matched IOCs: ${matched.length}`);
    return { score, matchedCount: matched.length, avgConfidence, alertCount: alerts.length };
  }, getResolve),

  'blast-radius': createCallbackHandler(async ({ state }) => {
    await sleep(30);
    const scoreData = state['severity-score'] as
      { alertCount?: number } | undefined;
    const services = ['auth-service', 'api-gateway', 'user-db', 'payment-service'];
    const affected = services.slice(0, Math.min(scoreData?.alertCount ?? 0, services.length));
    console.log(`  [blast-radius] ${affected.length} services affected: ${affected.join(', ')}`);
    return { affected_services: affected, count: affected.length };
  }, getResolve),

  'slack-alert': createFireAndForgetHandler(async ({ state }) => {
    await sleep(20);
    const scoreData = state['severity-score'] as
      { alertCount?: number; score?: number } | undefined;
    const msg = `INCIDENT: ${scoreData?.alertCount ?? '?'} alerts, severity ${scoreData?.score ?? '?'}/100`;
    console.log(`  [slack-alert] → #incident-response: "${msg}"`);
    sideEffects.push(`slack: ${msg}`);
  }, getResolve),

  'create-ticket': createCallbackHandler(async () => {
    await sleep(20);
    const ticketId = `INC${Date.now().toString().slice(-6)}`;
    console.log(`  [create-ticket] → ServiceNow ticket ${ticketId} created`);
    sideEffects.push(`ticket: ${ticketId}`);
    return { ticketId, status: 'open' };
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
      console.log(`  [drain] ${events.length} events, ${done}/${total} tasks done, eligible: [${result.eligible.join(', ')}]`);
    }
  },
});
graphRef = graph;

// ============================================================================
// 4. T0: Initial incident — push alert data + threat intel externally
// ============================================================================

console.log('=== SOC Incident Board ===');
console.log(`Tasks: ${Object.keys(config.tasks).join(', ')}`);
console.log(`alert-feed, threat-intel: NO handler (external push)`);
console.log(`create-ticket: refreshStrategy 'once' (no duplicate tickets)\n`);

console.log(`--- T0: Initial incident (${siemAlerts.length} alerts, ${threatIntelV1.length} IOCs) ---\n`);

// Push both source_defs simultaneously — engine stores data, auto-hash computed
graph.pushAll([
  {
    type: 'task-completed',
    taskName: 'alert-feed',
    data: { alerts: siemAlerts },
    timestamp: new Date().toISOString(),
  },
  {
    type: 'task-completed',
    taskName: 'threat-intel',
    data: { intel: threatIntelV1 },
    timestamp: new Date().toISOString(),
  },
]);

await sleep(2000);

console.log('\n--- T0 Result ---');
printState();
console.log(`  Side effects: ${sideEffects.length} fired`);
sideEffects.forEach(se => console.log(`    • ${se}`));

// ============================================================================
// 5. T1: New threat intel arrives — retrigger via external push
// ============================================================================

console.log(`\n--- T1: Threat intel update (false-positive reclassification + new C2) ---\n`);

// Push new intel data. Auto-hash will differ → data-changed cascade.
// alert-feed data unchanged → its hash stays the same.
// severity-score re-runs because one upstream (threat-intel) hash changed.
// create-ticket: refreshStrategy 'once' → already completed → NOT re-triggered.
// slack-alert: data-changed → re-fires with updated score.
graph.push({
  type: 'task-completed',
  taskName: 'threat-intel',
  data: { intel: threatIntelV2 },
  timestamp: new Date().toISOString(),
});

await sleep(2000);

console.log('\n--- T1 Result ---');
printState();
console.log(`  Side effects: ${sideEffects.length} total`);
sideEffects.forEach(se => console.log(`    • ${se}`));

const ticketExecs = graph.getState().state.tasks['create-ticket'].executionCount;
const slackExecs = graph.getState().state.tasks['slack-alert'].executionCount;
console.log(`\n  create-ticket ran ${ticketExecs}x (once strategy — no duplicate)`);
console.log(`  slack-alert ran ${slackExecs}x (re-notified on updated severity)`);

// ============================================================================
// 6. Validate
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

function printState(): void {
  const state = graph.getState();
  for (const [name, task] of Object.entries(state.state.tasks)) {
    const hash = task.lastDataHash ? ` (hash: ${task.lastDataHash.slice(0, 8)}…)` : '';
    console.log(`  ${name}: ${task.status} (${task.executionCount}x)${hash}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
