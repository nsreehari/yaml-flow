/**
 * yaml-flow - Isomorphic Workflow Engine
 * 
 * A lightweight, universal state machine engine with declarative YAML flows 
 * and pluggable persistence.
 * 
 * @example
 * ```typescript
 * import { createEngine, loadFlow, MemoryStore } from 'yaml-flow';
 * 
 * const flow = await loadFlow('./my-flow.yaml');
 * 
 * const handlers = {
 *   start: (input) => ({ result: 'success', data: { message: 'Hello!' } }),
 *   process: (input) => ({ result: 'success', data: { processed: true } }),
 * };
 * 
 * const engine = createEngine(flow, handlers);
 * const result = await engine.run({ userId: '123' });
 * ```
 */

// Core exports
export {
  FlowEngine,
  createEngine,
} from './core/engine.js';

export {
  loadFlow,
  loadFlowFromUrl,
  loadFlowFromFile,
  parseYaml,
  validateFlowConfig,
} from './core/loader.js';

export type {
  FlowConfig,
  FlowSettings,
  StepConfig,
  TerminalStateConfig,
  RetryConfig,
  CircuitBreakerConfig,
  StepHandler,
  StepInput,
  StepContext,
  StepResult,
  EngineOptions,
  FlowResult,
  FlowStore,
  RunState,
  FlowEvent,
  FlowEventType,
  FlowEventListener,
} from './core/types.js';

// Store exports
export { MemoryStore } from './stores/memory.js';
export { LocalStorageStore } from './stores/localStorage.js';
export { FileStore } from './stores/file.js';
