/**
 * Event Graph — Public API
 *
 * Two layers:
 *   scheduler.next(graph, state)  → { eligibleTasks, isComplete, isStuck }
 *   reducer.apply(state, event, graph) → newState
 */

// Scheduler (pure: state → eligible tasks)
export { next, getCandidateTasks } from './scheduler.js';

// Reducer (pure: state + event → new state)
export { apply, applyAll } from './reducer.js';

// Graph helpers (pure utilities)
export {
  getProvides, getRequires, getAllTasks, getTask, hasTask,
  isNonActiveTask, isTaskCompleted, isTaskRunning,
  isRepeatableTask, getRepeatableMax,
  computeAvailableOutputs, groupTasksByProvides, hasOutputConflict,
  addKeyToProvides, removeKeyFromProvides, addKeyToRequires, removeKeyFromRequires,
  addDynamicTask, createDefaultTaskState, createInitialExecutionState,
} from './graph-helpers.js';

// Completion
export { isExecutionComplete } from './completion.js';
export type { CompletionResult } from './completion.js';

// Stuck detection
export { detectStuckState } from './stuck-detection.js';

// Execution plan (dry run)
export { planExecution } from './plan.js';
export type { ExecutionPlan } from './plan.js';

// Mermaid diagram export
export { graphToMermaid, flowToMermaid } from './mermaid.js';
export type { MermaidOptions } from './mermaid.js';

// Loader & exporter
export { loadGraphConfig, validateGraphConfig, exportGraphConfig, exportGraphConfigToFile } from './loader.js';
export type { ExportOptions } from './loader.js';

// Semantic graph validation
export { validateGraph } from './validate.js';
export type { GraphIssue, GraphValidationResult, IssueSeverity } from './validate.js';

// Conflict resolution
export { selectBestAlternative, getNonConflictingTasks, selectRandomTasks } from './conflict-resolution.js';

// Task transitions (low-level — prefer reducer.apply)
export { applyTaskStart, applyTaskCompletion, applyTaskFailure, applyTaskProgress } from './task-transitions.js';

// Constants
export { TASK_STATUS, EXECUTION_STATUS, COMPLETION_STRATEGIES, EXECUTION_MODES, CONFLICT_STRATEGIES, DEFAULTS } from './constants.js';

// Types
export type {
  GraphConfig, GraphSettings, TaskConfig, TaskRetryConfig, RepeatableConfig, TaskCircuitBreakerConfig,
  ExecutionState, ExecutionConfig, TaskState, TaskMessage, StuckDetection,
  GraphEvent, TaskStartedEvent, TaskCompletedEvent, TaskFailedEvent, TaskProgressEvent,
  InjectTokensEvent, AgentActionEvent, TaskCreationEvent,
  SchedulerResult,
  TaskStatus, ExecutionStatus, CompletionStrategy, ExecutionMode, ConflictStrategy,
} from './types.js';
