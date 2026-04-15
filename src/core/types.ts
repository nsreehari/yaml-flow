/**
 * yaml-flow - Core Types
 * 
 * All type definitions for the workflow engine.
 */

// ============================================================================
// Flow Configuration Types (YAML structure)
// ============================================================================

/**
 * Root flow configuration - maps to YAML file structure
 */
export interface FlowConfig {
  /** Optional flow identifier */
  id?: string;
  
  /** Flow settings */
  settings: FlowSettings;
  
  /** Step definitions */
  steps: Record<string, StepConfig>;
  
  /** Terminal state definitions */
  terminal_states: Record<string, TerminalStateConfig>;
}

/**
 * Flow-level settings
 */
export interface FlowSettings {
  /** Step to start execution from */
  start_step: string;
  
  /** Maximum steps before forced termination (default: 100) */
  max_total_steps?: number;
  
  /** Flow timeout in milliseconds (optional) */
  timeout_ms?: number;
}

/**
 * Individual step configuration
 */
export interface StepConfig {
  /** Human-readable description */
  description?: string;
  
  /** Data keys this step expects as input */
  expects_data?: string[];
  
  /** Data keys this step produces as output */
  produces_data?: string[];
  
  /** Transition mapping: result -> next step name */
  transitions: Record<string, string>;
  
  /** Retry configuration for failures */
  retry?: RetryConfig;
  
  /** Circuit breaker for loops */
  circuit_breaker?: CircuitBreakerConfig;
}

/**
 * Retry configuration for step failures
 */
export interface RetryConfig {
  /** Maximum retry attempts */
  max_attempts: number;
  
  /** Delay between retries in ms */
  delay_ms?: number;
  
  /** Backoff multiplier (e.g., 2 for exponential) */
  backoff_multiplier?: number;
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Maximum iterations before circuit opens */
  max_iterations: number;
  
  /** Step to transition to when circuit opens */
  on_open: string;
}

/**
 * Terminal state configuration
 */
export interface TerminalStateConfig {
  /** Human-readable description */
  description?: string;
  
  /** Intent/status to return (e.g., 'success', 'error', 'cancelled') */
  return_intent: string;
  
  /** Data key(s) to include in result, or false to exclude */
  return_artifacts?: string | string[] | false;
  
  /** Data keys this terminal state expects */
  expects_data?: string[];
}

// ============================================================================
// Runtime Types
// ============================================================================

/**
 * Step handler function signature
 */
export type StepHandler = (
  input: StepInput,
  context: StepContext
) => StepResult | Promise<StepResult>;

/**
 * Input passed to step handlers
 */
export interface StepInput {
  /** Data from previous steps based on expects_data */
  [key: string]: unknown;
}

/**
 * Context available to step handlers
 */
export interface StepContext {
  /** Run identifier */
  runId: string;
  
  /** Current step name */
  stepName: string;
  
  /** Injected components (DB, API clients, etc.) */
  components: Record<string, unknown>;
  
  /** Store instance for direct access if needed */
  store: FlowStore;
  
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  
  /** Emit events for UI updates */
  emit: (event: string, data: unknown) => void;
}

/**
 * Result returned from step handlers
 */
export interface StepResult {
  /** Result key for transition routing (e.g., 'success', 'failure', 'retry') */
  result: string;
  
  /** Data to merge into flow state (must match produces_data) */
  data?: Record<string, unknown>;
}

// ============================================================================
// Engine Types
// ============================================================================

/**
 * Engine configuration options
 */
export interface EngineOptions {
  /** Persistence store (default: MemoryStore) */
  store?: FlowStore;
  
  /** Injected components available to handlers */
  components?: Record<string, unknown>;
  
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  
  /** Callback on each step execution */
  onStep?: (stepName: string, result: StepResult) => void;
  
  /** Callback on step transition */
  onTransition?: (from: string, to: string) => void;
  
  /** Callback on flow completion */
  onComplete?: (result: FlowResult) => void;
  
  /** Callback on flow error */
  onError?: (error: Error) => void;
}

/**
 * Final result of flow execution
 */
export interface FlowResult {
  /** Run identifier */
  runId: string;
  
  /** Completion status */
  status: 'completed' | 'failed' | 'cancelled' | 'timeout' | 'max_iterations';
  
  /** Return intent from terminal state */
  intent?: string;
  
  /** Returned artifacts/data */
  data: Record<string, unknown>;
  
  /** Final step name */
  finalStep: string;
  
  /** Steps executed (in order) */
  stepHistory: string[];
  
  /** Total execution time in ms */
  durationMs: number;
  
  /** Error if failed */
  error?: Error;
}

// ============================================================================
// Store Types
// ============================================================================

/**
 * Pluggable store interface for persistence
 */
export interface FlowStore {
  /**
   * Save run state
   */
  saveRunState(runId: string, state: RunState): Promise<void>;
  
  /**
   * Load run state
   */
  loadRunState(runId: string): Promise<RunState | null>;
  
  /**
   * Delete run state
   */
  deleteRunState(runId: string): Promise<void>;
  
  /**
   * Set a data value for a run
   */
  setData(runId: string, key: string, value: unknown): Promise<void>;
  
  /**
   * Get a data value for a run
   */
  getData(runId: string, key: string): Promise<unknown>;
  
  /**
   * Get all data for a run
   */
  getAllData(runId: string): Promise<Record<string, unknown>>;
  
  /**
   * Clear all data for a run
   */
  clearData(runId: string): Promise<void>;
  
  /**
   * List all active run IDs (optional - for management)
   */
  listRuns?(): Promise<string[]>;
}

/**
 * Persisted run state
 */
export interface RunState {
  /** Run identifier */
  runId: string;
  
  /** Flow identifier */
  flowId: string;
  
  /** Current step name */
  currentStep: string;
  
  /** Execution status */
  status: 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
  
  /** Ordered list of executed steps */
  stepHistory: string[];
  
  /** Iteration count per step (for circuit breakers) */
  iterationCounts: Record<string, number>;
  
  /** Retry counts per step */
  retryCounts: Record<string, number>;
  
  /** Timestamp when run started (ms since epoch) */
  startedAt: number;
  
  /** Timestamp of last update (ms since epoch) */
  updatedAt: number;
  
  /** Timestamp when paused (if applicable) */
  pausedAt?: number;
}

// ============================================================================
// Event Types
// ============================================================================

/**
 * Event types emitted by the engine
 */
export type FlowEventType = 
  | 'step:start'
  | 'step:complete'
  | 'step:error'
  | 'transition'
  | 'flow:start'
  | 'flow:complete'
  | 'flow:error'
  | 'flow:paused'
  | 'flow:resumed';

/**
 * Event payload structure
 */
export interface FlowEvent {
  type: FlowEventType;
  runId: string;
  timestamp: number;
  data: Record<string, unknown>;
}

/**
 * Event listener function
 */
export type FlowEventListener = (event: FlowEvent) => void;
