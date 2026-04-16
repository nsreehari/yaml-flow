/**
 * Reactive Graph Example: Live Monitoring Dashboard
 *
 * Demonstrates the reactive graph's advanced features:
 *  - Self-sustaining execution (no loops, no daemon)
 *  - Adding nodes at runtime with handlers
 *  - Conditional routing (on)
 *  - Handler failure → core engine on_failure tokens
 *  - Observability via onDrain + getDispatchState
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
} from '../../src/continuous-event-graph/index.js';
import type { GraphConfig, TaskConfig } from '../../src/continuous-event-graph/types.js';
import type { TaskHandler } from '../../src/continuous-event-graph/reactive.js';

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
      description: 'Collect CPU utilization metrics',
    },
    collect_memory: {
      provides: ['memory-metrics'],
      description: 'Collect memory usage metrics',
    },
    evaluate_health: {
      requires: ['cpu-metrics', 'memory-metrics'],
      provides: ['health-status'],
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
      description: 'Page the on-call engineer',
    },
    log_status: {
      requires: ['system-ok'],
      provides: ['status-logged'],
      description: 'Log healthy status for audit',
    },
    scale_up: {
      requires: ['system-degraded'],
      provides: ['scaled-up'],
      on_failure: ['scale-failed'],
      description: 'Auto-scale infrastructure',
    },
    escalate: {
      requires: ['scale-failed'],
      provides: ['escalated'],
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

const rg = createReactiveGraph(config, {
  handlers: {
    collect_cpu: async ({ taskName }) => {
      const { cpu } = simulateMetrics();
      console.log(`  [${taskName}] CPU: ${cpu}%`);
      return { data: { cpu }, dataHash: `cpu-${cpu}` };
    },

    collect_memory: async ({ taskName }) => {
      const { memory } = simulateMetrics();
      console.log(`  [${taskName}] Memory: ${memory}%`);
      return { data: { memory }, dataHash: `mem-${memory}` };
    },

    evaluate_health: async ({ taskName }) => {
      await sleep(50);
      let status: string;
      if (cpuLoad > 90 || memoryUsage > 90) {
        status = 'critical';
      } else if (cpuLoad > 70 || memoryUsage > 75) {
        status = 'degraded';
      } else {
        status = 'healthy';
      }
      console.log(`  [${taskName}] Health: ${status.toUpperCase()} (CPU=${cpuLoad}%, Mem=${memoryUsage}%)`);
      return { result: status, data: { status, cpu: cpuLoad, memory: memoryUsage } };
    },

    alert_oncall: async ({ taskName }) => {
      console.log(`  [${taskName}] 🚨 PAGING ON-CALL: System critical!`);
      await sleep(100);
      return {};
    },

    log_status: async ({ taskName }) => {
      console.log(`  [${taskName}] ✅ System healthy — logged.`);
      return {};
    },

    scale_up: async ({ taskName }) => {
      console.log(`  [${taskName}] ⚡ Scaling up infrastructure...`);
      await sleep(100);
      // Simulate scale failure 50% of the time
      if (Math.random() > 0.5) {
        throw new Error('Auto-scale service unavailable');
      }
      console.log(`  [${taskName}] Scaled up successfully.`);
      return {};
    },

    escalate: async ({ taskName }) => {
      console.log(`  [${taskName}] 📢 Escalating to platform team — auto-scale failed.`);
      return {};
    },
  },

  defaultTimeoutMs: 5_000,

  onDrain: (events, live, result) => {
    const statuses = Object.entries(live.state.tasks)
      .map(([n, s]) => `${n}=${s.status}`)
      .join(', ');
    console.log(`  [drain] ${events.length} events | eligible: [${result.eligible.join(', ')}]`);
  },

  onDispatchFailed: (name, err, attempt) => {
    console.log(`  [dispatch-failed] ${name}: ${err.message} (attempt ${attempt})`);
  },

  onAbandoned: (name) => {
    console.log(`  [abandoned] ${name} — giving up.`);
  },
});

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
  description: 'Send alert to #incidents Slack channel',
};

const slackHandler: TaskHandler = async ({ taskName }) => {
  console.log(`  [${taskName}] 💬 Slack → #incidents: System degraded, auto-scaling...`);
  return {};
};

rg.addNode('notify_slack', slackConfig, slackHandler);

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

// Show dispatch tracking
const dispatch = rg.getDispatchState();
if (dispatch.size > 0) {
  console.log('\n  In-flight dispatches:');
  for (const [name, entry] of dispatch) {
    console.log(`    ${name}: ${entry.status} (${entry.dispatchAttempts} attempts)`);
  }
} else {
  console.log('\n  No in-flight dispatches.');
}

rg.dispose();

// ============================================================================
// Util
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
