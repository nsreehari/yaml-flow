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
  planExecution,
  graphToMermaid, flowToMermaid,
  loadGraphConfig, validateGraphConfig, exportGraphConfig, exportGraphConfigToFile,
  validateGraph,
  TASK_STATUS, EXECUTION_STATUS, COMPLETION_STRATEGIES, EXECUTION_MODES, CONFLICT_STRATEGIES, DEFAULTS,
} from './event-graph/index.js';
export type {
  GraphConfig, GraphSettings, TaskConfig as GraphTaskConfig,
  ExecutionState, ExecutionConfig, TaskState, StuckDetection,
  GraphEvent, TaskStartedEvent, TaskCompletedEvent, TaskFailedEvent,
  InjectTokensEvent, AgentActionEvent, TaskCreationEvent,
  SchedulerResult, CompletionResult,
  ExecutionPlan, MermaidOptions, ExportOptions,
  GraphIssue, GraphValidationResult, IssueSeverity,
  TaskStatus, ExecutionStatus, CompletionStrategy, ExecutionMode, ConflictStrategy,
} from './event-graph/index.js';

// ============================================================================
// Stores (shared)
// ============================================================================
export { MemoryStore } from './stores/memory.js';
export { LocalStorageStore } from './stores/localStorage.js';
export { FileStore } from './stores/file.js';

// ============================================================================
// Batch
// ============================================================================
export { batch } from './batch/index.js';
export type { BatchOptions, BatchResult, BatchItemResult, BatchProgress } from './batch/index.js';

// ============================================================================
// Config utilities (pre-processing transforms)
// ============================================================================
export { resolveVariables, resolveConfigTemplates } from './config/index.js';
export type { Variables, ConfigTemplates } from './config/index.js';

// ============================================================================
// Continuous Event Graph
// ============================================================================
export {
  createLiveGraph, applyEvent,
  addNode, removeNode,
  addRequires, removeRequires, addProvides, removeProvides,
  injectTokens, drainTokens, schedule, inspect,
  resetNode, disableNode, enableNode, getNode,
  snapshot, restore,
  getUnreachableTokens, getUnreachableNodes,
  getUpstream, getDownstream,
} from './continuous-event-graph/index.js';
export type {
  LiveGraph, ScheduleResult, PendingTask, UnresolvedDependency, BlockedTask, LiveGraphHealth,
  NodeInfo, LiveGraphSnapshot,
  UnreachableTokensResult, UnreachableNodesResult,
  UpstreamResult, DownstreamResult,
} from './continuous-event-graph/index.js';

// ============================================================================
// Inference
// ============================================================================
export {
  buildInferencePrompt, inferCompletions, applyInferences, inferAndApply,
  createCliAdapter, createHttpAdapter,
} from './inference/index.js';
export type {
  InferenceAdapter, InferenceHints, InferenceOptions,
  InferenceResult, InferredCompletion, InferAndApplyResult,
  CliAdapterOptions, HttpAdapterOptions,
} from './inference/index.js';

// ============================================================================
// Card Compute
// ============================================================================
export { CardCompute } from './card-compute/index.js';
export type { ComputeExpr, ComputeNode, ComputeFn, EvalFn, ValidationResult } from './card-compute/index.js';

// ============================================================================
// Backward compat aliases (deprecated — use new names)
// ============================================================================
export { StepMachine as FlowEngine } from './step-machine/index.js';
export { createStepMachine as createEngine } from './step-machine/index.js';
