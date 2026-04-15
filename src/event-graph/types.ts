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
  /** Repeatable task configuration */
  repeatable?: boolean | RepeatableConfig;
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

export interface RepeatableConfig {
  /** Max times this task can repeat (undefined = unlimited) */
  max?: number;
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
  tasks: Record<string, TaskState>;
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

export interface TaskState {
  status: TaskStatus;
  executionCount: number;
  retryCount: number;
  lastEpoch: number;
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
  | InjectTokensEvent
  | AgentActionEvent
  | TaskCreationEvent;

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

export interface TaskCreationEvent {
  type: 'task-creation';
  taskName: string;
  taskConfig: TaskConfig;
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
