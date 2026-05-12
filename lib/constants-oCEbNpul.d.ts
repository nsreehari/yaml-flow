import { G as GraphConfig, c as ExecutionState, S as SchedulerResult, f as GraphEvent, T as TaskConfig, e as GraphEngineStore, R as RefreshStrategy, h as StuckDetection, C as CompletionStrategy, a as ConflictStrategy, b as ExecutionMode, d as ExecutionStatus, l as TaskStatus } from './types-BBhqYGhE.js';
import { e as StepFlowConfig } from './types-ycun84cq.js';

/**
 * Event Graph — Scheduler
 *
 * The core pure function: f(graph, state) → { eligibleTasks, isComplete, isStuck }
 * No I/O, no side effects, deterministic.
 */

/**
 * Determine what tasks should be executed next.
 * Pure function — the heart of the event-graph engine.
 */
declare function next(graph: GraphConfig, state: ExecutionState): SchedulerResult;
/**
 * Get candidate tasks whose dependencies are all met.
 * Uses refreshStrategy to determine re-execution eligibility.
 * Pure function.
 */
declare function getCandidateTasks(graph: GraphConfig, state: ExecutionState): string[];

/**
 * Event Graph — Reducer
 *
 * The core state transition function: f(state, event, graph) → newState
 * No I/O, no side effects, deterministic.
 */

/**
 * Apply an event to the current execution state, producing a new state.
 * Pure function — the heart of the event-graph reducer.
 *
 * @param state - Current execution state
 * @param event - Event to apply
 * @param graph - Graph configuration (needed for task definitions)
 * @returns New execution state
 */
declare function apply(state: ExecutionState, event: GraphEvent, graph: GraphConfig): ExecutionState;
/**
 * Apply multiple events sequentially. Pure function.
 */
declare function applyAll(state: ExecutionState, events: GraphEvent[], graph: GraphConfig): ExecutionState;

/**
 * Event Graph — Graph Helpers
 *
 * Pure functions for manipulating the requires/provides task dependency graph.
 * No I/O, no side effects.
 */

declare function getProvides(task: TaskConfig | undefined): string[];
declare function getRequires(task: TaskConfig | undefined): string[];
declare function getAllTasks(graph: GraphConfig): Record<string, TaskConfig>;
declare function getTask(graph: GraphConfig, taskName: string): TaskConfig | undefined;
declare function hasTask(graph: GraphConfig, taskName: string): boolean;
declare function isNonActiveTask(taskState: GraphEngineStore | undefined): boolean;
declare function isTaskCompleted(taskState: GraphEngineStore | undefined): boolean;
declare function isTaskRunning(taskState: GraphEngineStore | undefined): boolean;
declare function getRefreshStrategy(taskConfig: TaskConfig, graphSettings?: {
    refreshStrategy?: RefreshStrategy;
}): RefreshStrategy;
declare function isRerunnable(taskConfig: TaskConfig, graphSettings?: {
    refreshStrategy?: RefreshStrategy;
}): boolean;
declare function getMaxExecutions(taskConfig: TaskConfig): number | undefined;
/**
 * Dynamically compute available outputs from all completed tasks.
 * Tasks with strategies other than 'once' may have completed and reset.
 * Pure function.
 */
declare function computeAvailableOutputs(graph: GraphConfig, taskStates: Record<string, GraphEngineStore>): string[];
/**
 * Group candidate tasks by the outputs they provide.
 * Used to detect conflicts (multiple tasks providing the same output).
 */
declare function groupTasksByProvides(candidateTaskNames: string[], tasks: Record<string, TaskConfig>): Record<string, string[]>;
/**
 * Check if a task's outputs conflict with other candidates.
 */
declare function hasOutputConflict(taskName: string, taskProvides: string[], candidates: string[], tasks: Record<string, TaskConfig>): boolean;
declare function addKeyToProvides(task: TaskConfig, key: string): TaskConfig;
declare function removeKeyFromProvides(task: TaskConfig, key: string): TaskConfig;
declare function addKeyToRequires(task: TaskConfig, key: string): TaskConfig;
declare function removeKeyFromRequires(task: TaskConfig, key: string): TaskConfig;
/**
 * Add a new task to a graph config. Returns a new GraphConfig (immutable).
 */
declare function addDynamicTask(graph: GraphConfig, taskName: string, taskConfig: TaskConfig): GraphConfig;
/**
 * Create default task state for a new task.
 */
declare function createDefaultGraphEngineStore(): GraphEngineStore;
/**
 * Create the initial execution state for a graph.
 */
declare function createInitialExecutionState(graph: GraphConfig, executionId: string): ExecutionState;

/**
 * Event Graph — Completion Detection
 *
 * Pure functions to determine if a graph execution is complete.
 */

interface CompletionResult {
    isComplete: boolean;
    expectedCompletion: {
        taskNames: string[];
        outputs: string[];
    };
}
/**
 * Check if graph execution is complete based on the configured strategy.
 * Pure function.
 */
declare function isExecutionComplete(graph: GraphConfig, state: ExecutionState): CompletionResult;

/**
 * Event Graph — Stuck Detection
 *
 * Pure function to detect when a graph execution cannot make progress.
 */

/**
 * Detect if the graph execution is stuck.
 * Stuck = no eligible tasks AND execution is not complete.
 * Pure function.
 */
declare function detectStuckState(params: {
    graph: GraphConfig;
    state: ExecutionState;
    eligibleTasks: string[];
    completionResult?: CompletionResult;
}): StuckDetection;

/**
 * Event Graph — Execution Plan (Dry Run)
 *
 * Compute the full execution plan from a GraphConfig without running anything.
 * Shows phases (what runs in parallel), dependency edges, and potential issues.
 *
 * Pure function — no I/O, no side effects.
 */

interface ExecutionPlan {
    /** Ordered phases — tasks within a phase can run in parallel */
    phases: string[][];
    /** Dependency edges: taskName → tasks it depends on */
    dependencies: Record<string, string[]>;
    /** Tasks that provide conflicts (same output from multiple tasks) */
    conflicts: Record<string, string[]>;
    /** Tasks that have no requires (entry points) */
    entryPoints: string[];
    /** Tasks that nothing depends on (leaf nodes) */
    leafTasks: string[];
    /** Tokens required but not produced by any task */
    unreachableTokens: string[];
    /** Tasks blocked by unreachable tokens */
    blockedTasks: string[];
    /** Total number of phases (depth of the graph) */
    depth: number;
    /** Max parallelism (widest phase) */
    maxParallelism: number;
}
/**
 * Compute a full execution plan from a graph config.
 *
 * Shows the order tasks would execute, what can run in parallel,
 * where conflicts exist, and what's unreachable — all without
 * actually running anything.
 *
 * @param graph - The event-graph configuration
 * @returns ExecutionPlan with phases, dependencies, conflicts, and diagnostics
 */
declare function planExecution(graph: GraphConfig): ExecutionPlan;

/**
 * Mermaid Diagram Export
 *
 * Generate Mermaid diagram strings from GraphConfig (event-graph)
 * and StepFlowConfig (step-machine). Useful for documentation,
 * debugging, and CI reports.
 *
 * Pure functions — no I/O, no side effects.
 */

interface MermaidOptions {
    /** Diagram direction: TB (top-bottom), LR (left-right), etc. Default: 'TD' */
    direction?: 'TD' | 'TB' | 'LR' | 'RL' | 'BT';
    /** Show token labels on edges. Default: true */
    showTokens?: boolean;
    /** Title comment at top. Default: graph.id or 'Event Graph' */
    title?: string;
}
/**
 * Generate a Mermaid dependency graph from an event-graph config.
 *
 * Tasks are nodes. Edges represent token dependencies:
 * if task B requires token X and task A provides X, then A --> B.
 *
 * @param graph - Event graph configuration
 * @param options - Diagram options
 * @returns Mermaid diagram string
 */
declare function graphToMermaid(graph: GraphConfig, options?: MermaidOptions): string;
/**
 * Generate a Mermaid flowchart from a step-machine config.
 *
 * Steps are nodes. Transitions are labeled edges.
 * Terminal states are shown as filled/rounded nodes.
 *
 * @param flow - Step machine flow configuration
 * @param options - Diagram options
 * @returns Mermaid diagram string
 */
declare function flowToMermaid(flow: StepFlowConfig, options?: MermaidOptions): string;

/**
 * Event Graph — Loader & Exporter
 *
 * Load GraphConfig from YAML/JSON files or strings, and export back.
 * Mirrors the step-machine's loadStepFlow/validateStepFlowConfig pattern.
 */

/**
 * Validate a GraphConfig object. Returns an array of error strings.
 * Empty array = valid config.
 */
declare function validateGraphConfig(config: unknown): string[];
/**
 * Load a GraphConfig from a file path, URL, JSON string, or object.
 * Validates the config and throws if invalid.
 *
 * @param source - File path (.yaml/.yml/.json), URL, JSON string, or GraphConfig object
 * @returns Validated GraphConfig
 */
declare function loadGraphConfig(source: string | GraphConfig): Promise<GraphConfig>;
interface ExportOptions {
    /** Output format. Default: 'json' */
    format?: 'json' | 'yaml';
    /** Indentation for JSON (default: 2) or YAML */
    indent?: number;
}
/**
 * Export a GraphConfig to a JSON or YAML string.
 *
 * @param config - The graph configuration to export
 * @param options - Export format options
 * @returns Serialized config string
 */
declare function exportGraphConfig(config: GraphConfig, options?: ExportOptions): string;
/**
 * Export a GraphConfig to a file.
 *
 * @param config - The graph configuration to export
 * @param filePath - Output file path (.json or .yaml/.yml)
 * @param options - Export format options (format auto-detected from extension if not specified)
 */
declare function exportGraphConfigToFile(config: GraphConfig, filePath: string, options?: ExportOptions): Promise<void>;

/**
 * schema-validator — Full JSON Schema validation for EventGraph configs.
 *
 * Uses AJV to validate against the published event-graph.schema.json.
 * For a lightweight sync check without AJV, use `validateGraphConfig()` instead.
 *
 * @example
 * ```typescript
 * import { validateGraphSchema } from 'yaml-flow/event-graph';
 *
 * const result = validateGraphSchema(config);
 * if (!result.ok) console.error(result.errors);
 * ```
 */
interface SchemaValidationResult {
    ok: boolean;
    errors: string[];
}
/**
 * Validate an event-graph config against the full event-graph.schema.json (draft-07).
 *
 * Requires `ajv` and `ajv-formats` to be installed.
 */
declare function validateGraphSchema(config: unknown): SchemaValidationResult;

/**
 * Event Graph — Constants
 */

declare const TASK_STATUS: Record<string, TaskStatus>;
declare const EXECUTION_STATUS: Record<string, ExecutionStatus>;
declare const COMPLETION_STRATEGIES: Record<string, CompletionStrategy>;
declare const EXECUTION_MODES: Record<string, ExecutionMode>;
declare const CONFLICT_STRATEGIES: Record<string, ConflictStrategy>;
declare const DEFAULTS: {
    readonly EXECUTION_MODE: ExecutionMode;
    readonly CONFLICT_STRATEGY: ConflictStrategy;
    readonly COMPLETION_STRATEGY: CompletionStrategy;
    readonly MAX_ITERATIONS: 1000;
};

export { isRerunnable as A, isTaskCompleted as B, COMPLETION_STRATEGIES as C, DEFAULTS as D, EXECUTION_MODES as E, isTaskRunning as F, loadGraphConfig as G, next as H, planExecution as I, validateGraphConfig as J, validateGraphSchema as K, addKeyToProvides as L, type MermaidOptions as M, addKeyToRequires as N, groupTasksByProvides as O, hasOutputConflict as P, removeKeyFromProvides as Q, removeKeyFromRequires as R, TASK_STATUS as T, CONFLICT_STRATEGIES as a, type CompletionResult as b, EXECUTION_STATUS as c, type ExecutionPlan as d, type ExportOptions as e, addDynamicTask as f, apply as g, applyAll as h, computeAvailableOutputs as i, createDefaultGraphEngineStore as j, createInitialExecutionState as k, detectStuckState as l, exportGraphConfig as m, exportGraphConfigToFile as n, flowToMermaid as o, getAllTasks as p, getCandidateTasks as q, getMaxExecutions as r, getProvides as s, getRefreshStrategy as t, getRequires as u, getTask as v, graphToMermaid as w, hasTask as x, isExecutionComplete as y, isNonActiveTask as z };
