/**
 * Batch Example: Process tickets through a Step Machine flow
 *
 * Demonstrates:
 *  - batch() with step-machine processor
 *  - Concurrency control (3 slots)
 *  - Progress tracking
 *  - Mixed success/failure handling
 *
 * Run with: npx tsx examples/batch/batch-step-machine.ts
 */

import { batch } from '../../src/batch/index.js';
import { createStepMachine } from '../../src/step-machine/index.js';
import type { StepFlowConfig, StepHandler } from '../../src/step-machine/types.js';

// ============================================================================
// 1. Define a simple flow
// ============================================================================

const ticketFlow: StepFlowConfig = {
  id: 'support-ticket',
  settings: { start_step: 'classify', max_total_steps: 10 },
  steps: {
    classify: {
      produces_data: ['category'],
      transitions: { billing: 'handle', technical: 'handle', unknown: 'escalate' },
    },
    handle: {
      expects_data: ['category'],
      produces_data: ['resolution'],
      transitions: { resolved: 'done', failed: 'escalate' },
    },
    escalate: {
      expects_data: ['category'],
      produces_data: ['escalation_id'],
      transitions: { done: 'done' },
    },
  },
  terminal_states: {
    done: { return_intent: 'resolved', return_artifacts: ['resolution', 'escalation_id'] },
  },
};

const handlers: Record<string, StepHandler> = {
  classify: async (input) => {
    const msg = (input.message as string) || '';
    if (msg.includes('bill') || msg.includes('charge')) return { result: 'billing', data: { category: 'billing' } };
    if (msg.includes('crash') || msg.includes('error')) return { result: 'technical', data: { category: 'technical' } };
    return { result: 'unknown', data: { category: 'unknown' } };
  },
  handle: async (input) => {
    // Simulate occasional failure
    if (Math.random() < 0.2) return { result: 'failed' };
    return { result: 'resolved', data: { resolution: `Resolved ${input.category} issue` } };
  },
  escalate: async (input) => {
    return { result: 'done', data: { escalation_id: `ESC-${Date.now()}` } };
  },
};

// ============================================================================
// 2. Batch of tickets
// ============================================================================

const tickets = [
  { id: 'T-001', message: 'I was double-charged on my bill' },
  { id: 'T-002', message: 'App crashes on startup' },
  { id: 'T-003', message: 'How do I change my password?' },
  { id: 'T-004', message: 'Billing error on invoice #1234' },
  { id: 'T-005', message: 'Error 500 on checkout page' },
  { id: 'T-006', message: 'Cannot access my account' },
  { id: 'T-007', message: 'Refund not processed on my bill' },
  { id: 'T-008', message: 'App throws error on login' },
];

// ============================================================================
// 3. Run batch
// ============================================================================

async function main() {
  console.log(`Processing ${tickets.length} tickets with 3 concurrent slots\n`);

  const result = await batch(tickets, {
    concurrency: 3,

    processor: async (ticket) => {
      const machine = createStepMachine(ticketFlow, handlers);
      return machine.run({ message: ticket.message });
    },

    onItemComplete: (ticket, flowResult) => {
      console.log(`  ✓ ${ticket.id}: ${flowResult.intent} — ${flowResult.stepHistory.join(' → ')}`);
    },

    onItemError: (ticket, error) => {
      console.log(`  ✗ ${ticket.id}: ${error.message}`);
    },

    onProgress: (p) => {
      if (p.percent % 25 === 0) {
        console.log(`  [${p.percent}%] ${p.completed + p.failed}/${p.total} done, ${p.active} active`);
      }
    },
  });

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${result.completed} completed, ${result.failed} failed (${result.durationMs}ms)`);

  // Show per-item breakdown
  for (const item of result.items) {
    const ticket = item.item;
    if (item.status === 'completed') {
      console.log(`  ${ticket.id}: ${item.result?.intent} (${item.durationMs}ms)`);
    } else {
      console.log(`  ${ticket.id}: FAILED — ${item.error?.message}`);
    }
  }
}

main().catch(console.error);
