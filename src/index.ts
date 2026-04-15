/**
 * yaml-flow — Unified Workflow Engine
 *
 * Two modes, one package:
 *   - step-machine: stateful sequential executor (steps + transitions)
 *   - event-graph:  stateless graph engine (tasks + requires/provides)
 *
 * Both share the same store adapters.
 *
 * @example Step Machine
 * ```typescript
 * import { StepMachine } from 'yaml-flow/step-machine';
 * const machine = new StepMachine(flow, handlers, { store });
 * const result = await machine.run();
 * ```
 *
 * @example Event Graph — Library Mode (you drive)
 * ```typescript
 * import { next, apply } from 'yaml-flow/event-graph';
 * const { eligibleTasks } = next(graph, state);
 * const newState = apply(state, { type: 'task-completed', taskName: 'fetch', timestamp: '...' }, graph);
 * ```
 */

// ============================================================================
// Step Machine
// ============================================================================
export { StepMachine, createStepMachine } from './step-machine/index.js';
export { applyStepResult, checkCircuitBreaker, computeStepInput, extractReturnData, createInitialState } from './step-machine/index.js';
export { loadStepFlow, validateStepFlowConfig } from './step-machine/index.js';
export type {
  StepFlowConfig, StepFlowSettings, StepConfig, TerminalStateConfig,
  RetryConfig, CircuitBreakerConfig,
  StepHandler, StepInput, StepContext, StepResult,
  StepMachineState, StepReducerResult, StepMachineOptions, StepMachineResult,
  StepMachineStore, StepEventType, StepEvent, StepEventListener,
} from './step-machine/index.js';

// ============================================================================
// Event Graph
// ============================================================================
export {
  next, apply, applyAll, getCandidateTasks,
  getProvides, getRequires, getAllTasks, getTask, hasTask,
  isNonActiveTask, isTaskCompleted, isTaskRunning,
  isRepeatableTask, computeAvailableOutputs,
  addDynamicTask, createDefaultTaskState, createInitialExecutionState,
  isExecutionComplete, detectStuckState,
  TASK_STATUS, EXECUTION_STATUS, COMPLETION_STRATEGIES, EXECUTION_MODES, CONFLICT_STRATEGIES, DEFAULTS,
} from './event-graph/index.js';
export type {
  GraphConfig, GraphSettings, TaskConfig as GraphTaskConfig,
  ExecutionState, ExecutionConfig, TaskState, StuckDetection,
  GraphEvent, TaskStartedEvent, TaskCompletedEvent, TaskFailedEvent,
  InjectTokensEvent, AgentActionEvent, TaskCreationEvent,
  SchedulerResult, CompletionResult,
  TaskStatus, ExecutionStatus, CompletionStrategy, ExecutionMode, ConflictStrategy,
} from './event-graph/index.js';

// ============================================================================
// Stores (shared)
// ============================================================================
export { MemoryStore } from './stores/memory.js';
export { LocalStorageStore } from './stores/localStorage.js';
export { FileStore } from './stores/file.js';

// ============================================================================
// Backward compat aliases (deprecated — use new names)
// ============================================================================
export { StepMachine as FlowEngine } from './step-machine/index.js';
export { createStepMachine as createEngine } from './step-machine/index.js';
