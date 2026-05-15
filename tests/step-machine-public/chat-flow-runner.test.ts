import { describe, expect, it } from 'vitest';

import { createStepMachineChatFlowRunner } from '../../src/step-machine-public/chat-flow-runner.js';
import type { StepFlowConfig } from '../../src/step-machine/types.js';

const successFlow: StepFlowConfig = {
  settings: { start_step: 'respond' },
  steps: {
    respond: {
      handler: {
        type: 'ref',
        howToRun: 'local-node',
        whatToRun: { kind: 'fs-path', value: './demo-chat-handler.js' },
        meta: 'chat-handler',
      },
      transitions: { success: 'completed', failure: 'failed' },
    },
  },
  terminal_states: {
    completed: { return_intent: 'success', return_artifacts: false },
    failed: { return_intent: 'failure', return_artifacts: false },
  },
};

const invalidFlow: StepFlowConfig = {
  settings: { start_step: 'respond' },
  steps: {
    respond: {
      handler: {
        type: 'ref',
        howToRun: 'local-node',
        whatToRun: { kind: 'fs-path', value: './demo-chat-handler.js' },
        meta: 'chat-handler',
      },
      transitions: { success: 'missing-terminal' },
    },
  },
  terminal_states: {
    completed: { return_intent: 'success', return_artifacts: false },
  },
};

describe('createStepMachineChatFlowRunner', () => {
  it('runs a ref-backed flow through invokeRef', async () => {
    let calls = 0;
    const runner = createStepMachineChatFlowRunner({
      invokeRef: async (_ref, args) => {
        calls += 1;
        return { result: 'success', data: { echoedCardId: args.cardId } };
      },
    });

    const result = await runner.run(successFlow, { cardId: 'card-1' });

    expect(result).toEqual({ dispatched: true });
    expect(calls).toBe(1);
  });

  it('returns dispatched false when the flow does not complete successfully', async () => {
    const runner = createStepMachineChatFlowRunner({
      invokeRef: async () => ({ result: 'success', data: {} }),
    });

    const result = await runner.run(invalidFlow, { cardId: 'card-2' });

    expect(result.dispatched).toBe(false);
    expect(result.error).toContain('missing-terminal');
  });
});