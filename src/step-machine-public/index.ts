/**
 * step-machine-public — public API
 *
 * Platform-free step machine: load flows, run them, persist state via KVStorage.
 *
 * Usage:
 *   import { loadStepFlow, createStepMachine, buildStepHandlersForFlow,
 *            KVStorageStore, MemoryStore } from 'yaml-flow/step-machine-public';
 *   import { invokeRefSync } from 'yaml-flow/board-live-cards-node';
 *
 *   const invoke = (ref, args) => invokeRefSync(ref, args, { cliDir: flowDir });
 *   const handlers = buildStepHandlersForFlow(flow, { invoke });
 *   const machine = createStepMachine(flow, handlers, { store: new MemoryStore() });
 *   await machine.run(initialData);
 */

export { createStepMachine } from '../step-machine/index.js';
export { loadStepFlow } from '../step-machine/index.js';
export type { StepMachineStore } from '../step-machine/types.js';
export { MemoryStore } from '../stores/memory.js';
export { KVStorageStore } from '../stores/kv.js';

export {
  buildStepHandlersForFlow,
  resolveStepHandler,
  createComputeJsonataHandler,
  createRefStepHandler,
  createPassthroughHandler,
  isComputeJsonataSpec,
  isRefSpec,
} from './handler-factory.js';

export type {
  BuildStepHandlersOptions,
  ResolveStepHandlerOptions,
} from './handler-factory.js';

export {
  normalizeHandlerResult,
  filterProducedData,
  wrapWithOutputFiltering,
  wrapWithInputValidations,
  runInputValidations,
} from './result-utils.js';

export { jsonata } from './jsonata-loader.js';
export type { JsonataExpression } from './jsonata-loader.js';

export { createStepMachineChatFlowRunner } from './chat-flow-runner.js';

export type {
  CreateStepMachineChatFlowRunnerOptions,
  ComputeJsonataSpec,
  RefSpec,
  HandlerSpec,
  InvokeRefFn,
  NormalizedHandlerResult,
  StepHandler,
  StepMachineChatFlowRunner,
  StepMachineChatFlowRunnerResult,
  StepConfigForFactory,
} from './types.js';
