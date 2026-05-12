export { C as COMPLETION_STRATEGIES, a as CONFLICT_STRATEGIES, b as CompletionResult, D as DEFAULTS, E as EXECUTION_MODES, c as EXECUTION_STATUS, d as ExecutionPlan, e as ExportOptions, M as MermaidOptions, T as TASK_STATUS, f as addDynamicTask, L as addKeyToProvides, N as addKeyToRequires, g as apply, h as applyAll, i as computeAvailableOutputs, j as createDefaultGraphEngineStore, k as createInitialExecutionState, l as detectStuckState, m as exportGraphConfig, n as exportGraphConfigToFile, o as flowToMermaid, p as getAllTasks, q as getCandidateTasks, r as getMaxExecutions, s as getProvides, t as getRefreshStrategy, u as getRequires, v as getTask, w as graphToMermaid, O as groupTasksByProvides, P as hasOutputConflict, x as hasTask, y as isExecutionComplete, z as isNonActiveTask, A as isRerunnable, B as isTaskCompleted, F as isTaskRunning, G as loadGraphConfig, H as next, I as planExecution, Q as removeKeyFromProvides, R as removeKeyFromRequires, J as validateGraphConfig, K as validateGraphSchema } from '../constants-BzZUyYlp.cjs';
export { G as GraphIssue, a as GraphValidationResult, I as IssueSeverity, v as validateGraph } from '../validate-Dbu7ygys.cjs';
import { T as TaskConfig, c as ExecutionState, a as ConflictStrategy, G as GraphConfig } from '../types-BBhqYGhE.cjs';
export { A as AgentActionEvent, C as CompletionStrategy, E as ExecutionConfig, b as ExecutionMode, d as ExecutionStatus, e as GraphEngineStore, f as GraphEvent, g as GraphSettings, I as InjectTokensEvent, R as RefreshStrategy, S as SchedulerResult, h as StuckDetection, m as TaskCircuitBreakerConfig, i as TaskCompletedEvent, j as TaskFailedEvent, n as TaskMessage, o as TaskProgressEvent, p as TaskRestartEvent, q as TaskRetryConfig, k as TaskStartedEvent, l as TaskStatus } from '../types-BBhqYGhE.cjs';
import '../types-ycun84cq.cjs';

/**
 * Event Graph — Conflict Resolution Strategies
 *
 * Pure functions for selecting tasks when multiple candidates compete
 * for the same output.
 */

/**
 * Select the best alternative from a group of competing tasks.
 * Pure function.
 */
declare function selectBestAlternative(alternatives: string[], graphTasks: Record<string, TaskConfig>, _executionState: ExecutionState, strategy: ConflictStrategy): string;
/**
 * Get tasks that don't have output conflicts with any other candidate.
 */
declare function getNonConflictingTasks(candidates: string[], graphTasks: Record<string, TaskConfig>): string[];
/**
 * Select random task from each conflict group (for A/B testing).
 */
declare function selectRandomTasks(candidates: string[], graphTasks: Record<string, TaskConfig>): string[];

/**
 * Event Graph — Task State Transitions
 *
 * Pure functions for applying task lifecycle events to execution state.
 * Each function: f(state, ...) → newState
 */

/**
 * Apply task start to execution state. Pure function.
 */
declare function applyTaskStart(state: ExecutionState, taskName: string, graph?: GraphConfig): ExecutionState;
/**
 * Apply task completion to execution state.
 * Handles: default provides, conditional provides (on), refresh strategy, data hash tracking.
 * Pure function.
 */
declare function applyTaskCompletion(state: ExecutionState, graph: GraphConfig, taskName: string, result?: string, dataHash?: string, data?: Record<string, unknown>): ExecutionState;
/**
 * Apply task failure to execution state.
 * Handles: retry logic, on_failure token injection, circuit breaker.
 * Pure function.
 */
declare function applyTaskFailure(state: ExecutionState, graph: GraphConfig, taskName: string, error: string): ExecutionState;
/**
 * Apply task progress update. Pure function.
 */
declare function applyTaskProgress(state: ExecutionState, taskName: string, message?: string, progress?: number): ExecutionState;
/**
 * Apply task restart to execution state.
 * Resets the task to not-started, preserving executionCount and lastEpoch
 * (history). Clears data, error, progress. The task becomes eligible for
 * scheduling again on the next drain cycle.
 * Pure function.
 */
declare function applyTaskRestart(state: ExecutionState, taskName: string): ExecutionState;

export { ConflictStrategy, ExecutionState, GraphConfig, TaskConfig, applyTaskCompletion, applyTaskFailure, applyTaskProgress, applyTaskRestart, applyTaskStart, getNonConflictingTasks, selectBestAlternative, selectRandomTasks };
