/**
 * step-machine-public — public API
 *
 * Platform-free declarative handler model for the pure step machine.
 *
 * Usage:
 *   import { buildStepHandlersForFlow } from 'step-machine-public';
 *   import { createNodeSpawnInvoker } from 'step-machine-public-node-adapter';
 *
 *   const handlers = buildStepHandlersForFlow(flow, {
 *     invoke: createNodeSpawnInvoker({ flowDir }),
 *   });
 *   const machine = createStepMachine(flow, handlers, { store });
 *   await machine.run(initialData);
 */

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

export { resolveArgsMassaging } from './args-massaging.js';
export type { MassagedArgs } from './args-massaging.js';

export { jsonata } from './jsonata-loader.js';
export type { JsonataExpression } from './jsonata-loader.js';

export type {
  ComputeJsonataSpec,
  RefSpec,
  HandlerSpec,
  InvokeFn,
  NormalizedHandlerResult,
  StepHandler,
  StepConfigForFactory,
} from './types.js';
