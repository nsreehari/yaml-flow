/**
 * Event Graph — Core Types
 *
 * Type definitions for the stateless event-graph engine.
 * Pure: f(state, event) → newState
 */

// ============================================================================
// Graph Configuration Types (YAML structure)
// ============================================================================

export interface GraphConfig {
  id?: string;
  settings: GraphSettings;
  tasks: Record<string, TaskConfig>;
}

export interface GraphSettings {
  /** Completion strategy */
  completion: CompletionStrategy;
  /** Conflict resolution strategy */
  conflict_strategy?: ConflictStrategy;
  /** Execution mode */
  execution_mode?: ExecutionMode;
  /** Default refresh strategy for all tasks (default: 'data-changed') */
  refreshStrategy?: RefreshStrategy;
  /** Goal outputs — used with 'goal-reached' completion */
  goal?: string[];
  /** Max total scheduler iterations (safety limit, default: 1000) */
  max_iterations?: number;
  /** Timeout in ms (declared for drivers, not enforced by pure engine) */
  timeout_ms?: number;
}

export interface TaskConfig {
  /** What this task needs to become eligible */
  requires?: string[];
  /** What this task produces on successful completion */
  provides: string[];
  /** Conditional provides based on handler result */
  on?: Record<string, string[]>;
  /** Tokens to inject into available outputs on failure */
  on_failure?: string[];
  /** Task execution method (informational — driver concern) */
  method?: string;
  /** Named task handler references — looked up in the handler registry at dispatch time */
  taskHandlers?: string[];
  /** Arbitrary task configuration (driver concern) */
  config?: Record<string, unknown>;
  /** Task priority (higher = preferred in conflict resolution) */
  priority?: number;
  /** Estimated duration in ms (used by duration-first strategy) */
  estimatedDuration?: number;
  /** Estimated cost (used by cost-optimized strategy) */
  estimatedCost?: number;
  /** Resource requirements (used by resource-aware strategy) */
  estimatedResources?: Record<string, number>;
  /** Retry configuration */
  retry?: TaskRetryConfig;
  /** Refresh strategy — controls when a completed task re-runs (default: 'data-changed') */
  refreshStrategy?: RefreshStrategy;
  /** Refresh interval in seconds — only used with 'time-based' strategy */
  refreshInterval?: number;
  /** Max executions cap (safety limit, optional) */
  maxExecutions?: number;
  /** Circuit breaker: max executions before breaking */
  circuit_breaker?: TaskCircuitBreakerConfig;
  /** Description */
  description?: string;
  /** LLM inference hints — opt-in metadata for AI-assisted completion detection */
  inference?: {
    /** Human-readable completion criteria */
    criteria?: string;
    /** Keywords to help the LLM understand the domain */
    keywords?: string[];
    /** Suggested checks for verification */
    suggestedChecks?: string[];
    /** Whether the LLM should attempt to auto-detect completion (default: false) */
    autoDetectable?: boolean;
  };
}

export interface TaskRetryConfig {
  max_attempts: number;
  delay_ms?: number;
  backoff_multiplier?: number;
}

export interface TaskCircuitBreakerConfig {
  /** Max executions before injecting break tokens */
  max_executions: number;
  /** Tokens to inject when breaker trips */
  on_break: string[];
}

// ============================================================================
// Execution State — the blob that moves through the reducer
// ============================================================================

export interface ExecutionState {
  /** Current status of the execution */
  status: ExecutionStatus;
  /** Task states keyed by task name */
  tasks: Record<string, GraphEngineStore>;
  /** Tokens currently available in the system */
  availableOutputs: string[];
  /** Stuck detection result */
  stuckDetection: StuckDetection;
  /** Last update timestamp */
  lastUpdated: string;
  /** Execution ID for this run */
  executionId: string | null;
  /** Execution configuration */
  executionConfig: ExecutionConfig;
}

export interface ExecutionConfig {
  executionMode: ExecutionMode;
  conflictStrategy: ConflictStrategy;
  completionStrategy: CompletionStrategy;
}

export interface GraphEngineStore {
  status: TaskStatus;
  executionCount: number;
  retryCount: number;
  lastEpoch: number;
  /** Hash of this task's last output (for data-changed strategy) */
  lastDataHash?: string;
  /** The task's last output data payload */
  data?: Record<string, unknown>;
  /** Per-require token: the data hash consumed on last run */
  lastConsumedHashes?: Record<string, string>;
  /** Per-require token: upstream hashes snapshot at task-start time.
   * Used by applyTaskCompletion so mid-flight upstream changes are not
   * silently absorbed into lastConsumedHashes. */
  startConsumedHashes?: Record<string, string>;
  startedAt?: string;
  completedAt?: string;
  failedAt?: string;
  lastUpdated?: string;
  error?: string;
  messages?: TaskMessage[];
  progress?: number | null;
}

export interface TaskMessage {
  message: string;
  timestamp: string;
  status: string;
}

export interface StuckDetection {
  is_stuck: boolean;
  stuck_description: string | null;
  outputs_unresolvable: string[];
  tasks_blocked: string[];
}

// ============================================================================
// Events — inputs to the reducer
// ============================================================================

export type GraphEvent =
  | TaskStartedEvent
  | TaskCompletedEvent
  | TaskFailedEvent
  | TaskProgressEvent
  | TaskRestartEvent
  | InjectTokensEvent
  | AgentActionEvent
  | TaskUpsertEvent
  | TaskRemovalEvent
  | NodeRequiresAddEvent
  | NodeRequiresRemoveEvent
  | NodeProvidesAddEvent
  | NodeProvidesRemoveEvent;

export interface TaskStartedEvent {
  type: 'task-started';
  taskName: string;
  timestamp: string;
  executionId?: string;
}

export interface TaskCompletedEvent {
  type: 'task-completed';
  taskName: string;
  /** Handler result key — used for conditional routing via `on` */
  result?: string;
  /** Data payload from task execution */
  data?: Record<string, unknown>;
  /** Content hash of the output — used by 'data-changed' refresh strategy */
  dataHash?: string;
  timestamp: string;
  executionId?: string;
}

export interface TaskFailedEvent {
  type: 'task-failed';
  taskName: string;
  error: string;
  timestamp: string;
  executionId?: string;
}

export interface TaskProgressEvent {
  type: 'task-progress';
  taskName: string;
  message?: string;
  progress?: number;
  /**
   * Arbitrary update payload — used by source delivery to carry
   * { bindTo, fetchedAt, dest } or { bindTo, failure, reason }.
   * card-handler receives this via TaskHandlerInput.update.
   */
  update?: Record<string, unknown>;
  timestamp: string;
  executionId?: string;
}

export interface TaskRestartEvent {
  type: 'task-restart';
  taskName: string;
  timestamp: string;
  executionId?: string;
}

export interface InjectTokensEvent {
  type: 'inject-tokens';
  tokens: string[];
  timestamp: string;
}

export interface AgentActionEvent {
  type: 'agent-action';
  action: 'start' | 'stop' | 'pause' | 'resume';
  timestamp: string;
  config?: Partial<ExecutionConfig>;
}

export interface TaskUpsertEvent {
  type: 'task-upsert';
  taskName: string;
  taskConfig: TaskConfig;
  timestamp: string;
}

export interface TaskRemovalEvent {
  type: 'task-removal';
  taskName: string;
  timestamp: string;
}

export interface NodeRequiresAddEvent {
  type: 'node-requires-add';
  nodeName: string;
  tokens: string[];
  timestamp: string;
}

export interface NodeRequiresRemoveEvent {
  type: 'node-requires-remove';
  nodeName: string;
  tokens: string[];
  timestamp: string;
}

export interface NodeProvidesAddEvent {
  type: 'node-provides-add';
  nodeName: string;
  tokens: string[];
  timestamp: string;
}

export interface NodeProvidesRemoveEvent {
  type: 'node-provides-remove';
  nodeName: string;
  tokens: string[];
  timestamp: string;
}

// ============================================================================
// Scheduler Output
// ============================================================================

export interface SchedulerResult {
  /** Tasks eligible for execution */
  eligibleTasks: string[];
  /** Whether the graph execution is complete */
  isComplete: boolean;
  /** Stuck detection result */
  stuckDetection: StuckDetection;
  /** Whether conflicts were detected */
  hasConflicts: boolean;
  /** Conflict groups: output → competing task names */
  conflicts: Record<string, string[]>;
  /** Strategy used for conflict resolution */
  strategy: ConflictStrategy;
  /** Processing log for diagnostics */
  processingLog: string[];
}

// ============================================================================
// Enums (as string unions)
// ============================================================================

export type TaskStatus = 'not-started' | 'running' | 'completed' | 'failed' | 'inactivated';
export type ExecutionStatus = 'created' | 'running' | 'paused' | 'stopped' | 'completed' | 'failed';

export type CompletionStrategy =
  | 'all-tasks-done'
  | 'all-outputs-done'
  | 'only-resolved'
  | 'goal-reached'
  | 'manual';

export type ExecutionMode = 'dependency-mode' | 'eligibility-mode';

export type ConflictStrategy =
  | 'alphabetical'
  | 'priority-first'
  | 'duration-first'
  | 'cost-optimized'
  | 'resource-aware'
  | 'random-select'
  | 'user-choice'
  | 'parallel-all'
  | 'skip-conflicts'
  | 'round-robin';

export type RefreshStrategy =
  | 'data-changed'
  | 'epoch-changed'
  | 'time-based'
  | 'manual'
  | 'once';
