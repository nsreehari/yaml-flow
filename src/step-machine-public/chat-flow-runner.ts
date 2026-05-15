import { createStepMachine } from '../step-machine/index.js';
import { MemoryStore } from '../stores/memory.js';
import type { StepFlowConfig, StepMachineStore } from '../step-machine/types.js';
import { buildStepHandlersForFlow } from './handler-factory.js';
import type { InvokeRefFn } from './types.js';

export interface CreateStepMachineChatFlowRunnerOptions {
  invokeRef: InvokeRefFn;
  storeFactory?: () => StepMachineStore;
}

export interface StepMachineChatFlowRunnerResult {
  dispatched: boolean;
  error?: string;
}

export interface StepMachineChatFlowRunner {
  run(flow: unknown, args: Record<string, unknown>): Promise<StepMachineChatFlowRunnerResult>;
}

export function createStepMachineChatFlowRunner(
  options: CreateStepMachineChatFlowRunnerOptions,
): StepMachineChatFlowRunner {
  const storeFactory = options.storeFactory || (() => new MemoryStore());

  return {
    async run(flow: unknown, args: Record<string, unknown>): Promise<StepMachineChatFlowRunnerResult> {
      try {
        const handlers = buildStepHandlersForFlow(flow as StepFlowConfig, { invoke: options.invokeRef });
        const machine = createStepMachine(flow as StepFlowConfig, handlers, { store: storeFactory() });
        const result = await machine.run(args);
        if (result.status !== 'completed') {
          return { dispatched: false, error: result.error?.message || result.status };
        }
        return { dispatched: true };
      } catch (err) {
        return {
          dispatched: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}