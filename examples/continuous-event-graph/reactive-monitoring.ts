/**
 * Reactive Graph Example: Live Monitoring Dashboard
 *
 * Demonstrates the reactive graph's advanced features:
 *  - Self-sustaining execution (no loops, no daemon)
 *  - createCallbackHandler + createFireAndForgetHandler
 *  - Adding nodes at runtime with handlers
 *  - Conditional routing (on)
 *  - Handler failure → core engine on_failure tokens
 *  - Auto dataHash (no explicit hash in handlers)
 *  - validateReactiveGraph for handler/dispatch checks
 *  - Observability via onDrain
 *  - Journal-based event batching
 *
 * Scenario: A monitoring system that collects metrics, evaluates alerts,
 * and dynamically adds notification channels at runtime.
 *
 * Run with: npx tsx examples/continuous-event-graph/reactive-monitoring.ts
 */

import {
  createReactiveGraph,
  MemoryJournal,
  createCallbackHandler,
  createFireAndForgetHandler,
  validateReactiveGraph,
} from '../../src/continuous-event-graph/index.js';
import type { GraphConfig, TaskConfig } from '../../src/continuous-event-graph/types.js';
import type { TaskHandlerFn, ReactiveGraph } from '../../src/continuous-event-graph/reactive.js';
import type { ResolveCallbackFn } from '../../src/continuous-event-graph/handlers.js';

// ============================================================================
// 1. Define the initial graph
// ============================================================================

const config: GraphConfig = {
  id: 'monitoring-dashboard',
  settings: {
    completion: 'manual', // continuous — never auto-completes
    execution_mode: 'eligibility-mode',
  },
  tasks: {
    collect_cpu: {
      provides: ['cpu-metrics'],
      taskHandlers: ['collect_cpu'],
      description: 'Collect CPU utilization metrics',
    },
    collect_memory: {
      provides: ['memory-metrics'],
      taskHandlers: ['collect_memory'],
      description: 'Collect memory usage metrics',
    },
    evaluate_health: {
      requires: ['cpu-metrics', 'memory-metrics'],
      provides: ['health-status'],
      taskHandlers: ['evaluate_health'],
      on: {
        healthy: ['system-ok'],
        degraded: ['system-degraded'],
        critical: ['system-critical'],
      },
      description: 'Evaluate system health from all metrics',
    },
    alert_oncall: {
      requires: ['system-critical'],
      provides: ['oncall-notified'],
      taskHandlers: ['alert_oncall'],
      description: 'Page the on-call engineer',
    },
    log_status: {
      requires: ['system-ok'],
      provides: ['status-logged'],
      taskHandlers: ['log_status'],
      description: 'Log healthy status for audit',
    },
    scale_up: {
      requires: ['system-degraded'],
      provides: ['scaled-up'],
      taskHandlers: ['scale_up'],
      on_failure: ['scale-failed'],
      description: 'Auto-scale infrastructure',
    },
    escalate: {
      requires: ['scale-failed'],
      provides: ['escalated'],
      taskHandlers: ['escalate'],
      description: 'Escalate to platform team when auto-scale fails',
    },
  },
};

// ============================================================================
// 2. Simulated metrics
// ============================================================================

let cpuLoad = 45; // start normal
let memoryUsage = 60;

function simulateMetrics(): { cpu: number; memory: number } {
  // Gradually increase load to trigger different paths
  cpuLoad = Math.min(99, cpuLoad + Math.floor(Math.random() * 15));
  memoryUsage = Math.min(95, memoryUsage + Math.floor(Math.random() * 10));
  return { cpu: cpuLoad, memory: memoryUsage };
}

// ============================================================================
// 3. Create reactive graph
// ============================================================================

console.log('=== Reactive Monitoring Dashboard ===\n');

// Lazy resolver — graph doesn't exist at handler-creation time
let graphRef: ReactiveGraph;
const getResolve = (): ResolveCallbackFn => graphRef.resolveCallback.bind(graphRef);

// Handlers use createCallbackHandler for data-producing tasks and
// createFireAndForgetHandler for side-effect-only tasks.
// No explicit dataHash — the reactive layer auto-computes from data.

const handlers: Record<string, TaskHandlerFn> = {
  // Data-producing handlers — return data and let auto-hash do the rest
  collect_cpu: createCallbackHandler(async ({ nodeId }) => {
    const { cpu } = simulateMetrics();
    console.log(`  [${nodeId}] CPU: ${cpu}%`);
    return { cpu };
  }, getResolve),

  collect_memory: createCallbackHandler(async ({ nodeId }) => {
    const { memory } = simulateMetrics();
    console.log(`  [${nodeId}] Memory: ${memory}%`);
    return { memory };
  }, getResolve),

  // evaluate_health uses conditional routing (on: { healthy, degraded, critical })
  // resolveCallback doesn't support `result`, so we push directly to the graph
  evaluate_health: async ({ nodeId, callbackToken }) => {
    setTimeout(() => {
      let status: string;
      if (cpuLoad > 90 || memoryUsage > 90) {
        status = 'critical';
      } else if (cpuLoad > 70 || memoryUsage > 75) {
        status = 'degraded';
      } else {
        status = 'healthy';
      }
      console.log(`  [${nodeId}] Health: ${status.toUpperCase()} (CPU=${cpuLoad}%, Mem=${memoryUsage}%)`);
      // Use graph.push directly for conditional routing (result field)
      graphRef.push({
        type: 'task-completed',
        taskName: nodeId,
        result: status,
        data: { status, cpu: cpuLoad, memory: memoryUsage },
        timestamp: new Date().toISOString(),
      });
    }, 50);
    return 'task-initiated';
  },

  // Side-effect-only handlers — fire and forget (logging, alerting)
  alert_oncall: createFireAndForgetHandler(async ({ nodeId }) => {
    console.log(`  [${nodeId}] 🚨 PAGING ON-CALL: System critical!`);
    await sleep(100);
  }, getResolve),

  log_status: createFireAndForgetHandler(({ nodeId }) => {
    console.log(`  [${nodeId}] ✅ System healthy — logged.`);
  }, getResolve),

  scale_up: createCallbackHandler(async ({ nodeId }) => {
    console.log(`  [${nodeId}] ⚡ Scaling up infrastructure...`);
    await sleep(100);
    // Simulate scale failure 50% of the time
    if (Math.random() > 0.5) {
      throw new Error('Auto-scale service unavailable');
    }
    console.log(`  [${nodeId}] Scaled up successfully.`);
    return {};
  }, getResolve),

  escalate: createFireAndForgetHandler(({ nodeId }) => {
    console.log(`  [${nodeId}] 📢 Escalating to platform team — auto-scale failed.`);
  }, getResolve),
};

const rg = createReactiveGraph(config, {
  handlers,

  onDrain: (events, live, result) => {
    const statuses = Object.entries(live.state.tasks)
      .map(([n, s]) => `${n}=${s.status}`)
      .join(', ');
    console.log(`  [drain] ${events.length} events | eligible: [${result.eligible.join(', ')}]`);
  },
});
graphRef = rg;

// ============================================================================
// 4. Kick it off — one push, the graph drives itself
// ============================================================================

console.log('Phase 1: Initial metrics collection\n');
rg.push({ type: 'inject-tokens', tokens: [], timestamp: new Date().toISOString() });

await sleep(1000);

// ============================================================================
// 5. Add a Slack notification node at runtime
// ============================================================================

console.log('\n--- Adding Slack notification node at runtime ---\n');

const slackConfig: TaskConfig = {
  requires: ['system-degraded'],
  provides: ['slack-notified'],
  taskHandlers: ['notify_slack'],
  description: 'Send alert to #incidents Slack channel',
};

// Use createFireAndForgetHandler — Slack notification is a side-effect
const slackHandler: TaskHandlerFn = createFireAndForgetHandler(({ nodeId }) => {
  console.log(`  [${nodeId}] 💬 Slack → #incidents: System degraded, auto-scaling...`);
}, getResolve);

rg.registerHandler('notify_slack', slackHandler);
rg.addNode('notify_slack', slackConfig);

await sleep(500);

// ============================================================================
// 6. Show final state
// ============================================================================

console.log('\n=== Final State ===\n');

const state = rg.getState();
for (const [name, task] of Object.entries(state.state.tasks)) {
  const hash = task.lastDataHash ? ` (hash: ${task.lastDataHash})` : '';
  console.log(`  ${name}: ${task.status} [${task.executionCount}x]${hash}`);
}

console.log(`\n  Outputs: [${state.state.availableOutputs.join(', ')}]`);

// ============================================================================
// 7. Validate reactive graph consistency
// ============================================================================

console.log('\n=== Validation ===');
const validation = validateReactiveGraph({
  graph: rg,
  handlers: { ...handlers, notify_slack: slackHandler },
});
console.log(`  Valid: ${validation.valid} (${validation.issues.length} issues)`);
for (const issue of validation.issues) {
  console.log(`    [${issue.severity}] ${issue.code}: ${issue.message}`);
}

rg.dispose();

// ============================================================================
// Util
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
