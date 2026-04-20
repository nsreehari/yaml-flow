/**
 * Event Graph Example: CI/CD Pipeline
 *
 * Demonstrates:
 *  - External event injection (human approval gate)
 *  - Conditional routing via `on`
 *  - Failure tokens via `on_failure`
 *  - Retry configuration
 *  - Stuck detection
 *
 * Run with: npx tsx examples/npm-libs/event-graph/ci-cd-pipeline.ts
 */

import {
  next,
  apply,
  createInitialExecutionState,
} from '../../src/event-graph/index.js';
import type { GraphConfig } from '../../src/event-graph/index.js';

// ============================================================================
// 1. Define the graph
// ============================================================================

const graph: GraphConfig = {
  id: 'ci-cd-pipeline',
  settings: {
    completion: 'goal-reached',
    goal: ['deployed'],
    conflict_strategy: 'alphabetical',
  },
  tasks: {
    build: {
      provides: ['build-artifact'],
      description: 'Compile the project',
    },
    unit_tests: {
      requires: ['build-artifact'],
      provides: ['tests-passed'],
      retry: { max_attempts: 2 },
      on_failure: ['tests-failed'],
      description: 'Run unit tests',
    },
    lint: {
      requires: ['build-artifact'],
      provides: ['lint-passed'],
      description: 'Run linter',
    },
    security_scan: {
      requires: ['build-artifact'],
      provides: ['scan-passed'],
      on: {
        clean: ['scan-passed'],
        vulnerable: ['scan-blocked'],
      },
      description: 'Run security scan',
    },
    approve: {
      // Needs all checks AND a human approval token
      requires: ['tests-passed', 'lint-passed', 'scan-passed', 'human-approval'],
      provides: ['approved'],
      description: 'Human approval gate',
    },
    deploy: {
      requires: ['approved'],
      provides: ['deployed'],
      retry: { max_attempts: 3 },
      on_failure: ['deploy-failed'],
      description: 'Deploy to production',
    },
    notify_failure: {
      // Activates if tests fail, scan is blocked, or deploy fails
      requires: ['tests-failed'],
      provides: ['failure-notified'],
      description: 'Notify team of failure',
    },
    notify_blocked: {
      requires: ['scan-blocked'],
      provides: ['block-notified'],
      description: 'Notify team of security block',
    },
  },
};

// ============================================================================
// 2. Simulated task executor
// ============================================================================

// Simulate tasks with controlled outcomes
const taskOutcomes: Record<string, { success: boolean; result?: string }> = {
  build: { success: true },
  unit_tests: { success: true },
  lint: { success: true },
  security_scan: { success: true, result: 'clean' },
  approve: { success: true },
  deploy: { success: true },
  notify_failure: { success: true },
  notify_blocked: { success: true },
};

async function executeTask(taskName: string): Promise<{ success: boolean; result?: string; error?: string }> {
  await new Promise((r) => setTimeout(r, Math.random() * 100 + 20));
  const outcome = taskOutcomes[taskName] ?? { success: true };

  if (!outcome.success) {
    console.log(`  ✗ ${taskName} FAILED`);
    return { success: false, error: `${taskName} execution error` };
  }

  console.log(`  ✓ ${taskName} completed${outcome.result ? ` (result: ${outcome.result})` : ''}`);
  return { success: true, result: outcome.result };
}

// ============================================================================
// 3. Driver loop with external event injection
// ============================================================================

async function main() {
  let state = createInitialExecutionState(graph, 'pipeline-42');
  let iteration = 0;
  let approvalInjected = false;

  console.log('CI/CD Pipeline — Event Graph Demo');
  console.log('==================================\n');

  while (iteration < 20) {
    iteration++;

    // Simulate human approval after all automated checks pass
    if (
      !approvalInjected &&
      state.availableOutputs.includes('tests-passed') &&
      state.availableOutputs.includes('lint-passed') &&
      state.availableOutputs.includes('scan-passed')
    ) {
      console.log('\n  🔔 All checks passed — simulating human approval...');
      state = apply(
        state,
        { type: 'inject-tokens', tokens: ['human-approval'], timestamp: new Date().toISOString() },
        graph
      );
      approvalInjected = true;
    }

    const schedule = next(graph, state);

    console.log(`\n[iteration ${iteration}] eligible: [${schedule.eligibleTasks.join(', ')}]`);

    if (schedule.isComplete) {
      console.log('\n✅ Pipeline complete! Deployment successful.');
      console.log('Final outputs:', state.availableOutputs);
      break;
    }

    if (schedule.stuckDetection.is_stuck) {
      console.error('\n❌ Pipeline stuck:', schedule.stuckDetection.stuck_description);
      console.log('Blocked tasks:', schedule.stuckDetection.tasks_blocked);
      break;
    }

    if (schedule.eligibleTasks.length === 0) {
      console.log('   (no eligible tasks — waiting for events)');
      break;
    }

    // Start + execute eligible tasks
    const ts = new Date().toISOString();
    for (const taskName of schedule.eligibleTasks) {
      state = apply(state, { type: 'task-started', taskName, timestamp: ts }, graph);
    }

    const results = await Promise.all(schedule.eligibleTasks.map(executeTask));

    for (let i = 0; i < results.length; i++) {
      const taskName = schedule.eligibleTasks[i];
      const r = results[i];
      const ts2 = new Date().toISOString();

      if (r.success) {
        state = apply(state, { type: 'task-completed', taskName, result: r.result, timestamp: ts2 }, graph);
      } else {
        state = apply(state, { type: 'task-failed', taskName, error: r.error!, timestamp: ts2 }, graph);
      }
    }

    console.log(`   outputs: [${state.availableOutputs.join(', ')}]`);
  }

  // ------------------------------------------------------------------
  // Now demonstrate a failure scenario
  // ------------------------------------------------------------------
  console.log('\n\n========== Failure Scenario ==========\n');

  // Override: make security scan find vulnerabilities
  taskOutcomes.security_scan = { success: true, result: 'vulnerable' };

  state = createInitialExecutionState(graph, 'pipeline-43');
  iteration = 0;
  approvalInjected = false;

  while (iteration < 20) {
    iteration++;
    const schedule = next(graph, state);

    console.log(`\n[iteration ${iteration}] eligible: [${schedule.eligibleTasks.join(', ')}]`);

    if (schedule.isComplete) {
      console.log('\n✅ Complete.');
      break;
    }

    if (schedule.stuckDetection.is_stuck) {
      console.log('\n⚠️  Pipeline blocked (as expected with vulnerability).');
      console.log('Reason:', schedule.stuckDetection.stuck_description);
      break;
    }

    if (schedule.eligibleTasks.length === 0) break;

    const ts = new Date().toISOString();
    for (const taskName of schedule.eligibleTasks) {
      state = apply(state, { type: 'task-started', taskName, timestamp: ts }, graph);
    }

    const results = await Promise.all(schedule.eligibleTasks.map(executeTask));

    for (let i = 0; i < results.length; i++) {
      const taskName = schedule.eligibleTasks[i];
      const r = results[i];
      const ts2 = new Date().toISOString();

      if (r.success) {
        state = apply(state, { type: 'task-completed', taskName, result: r.result, timestamp: ts2 }, graph);
      } else {
        state = apply(state, { type: 'task-failed', taskName, error: r.error!, timestamp: ts2 }, graph);
      }
    }

    console.log(`   outputs: [${state.availableOutputs.join(', ')}]`);
  }
}

main().catch(console.error);
