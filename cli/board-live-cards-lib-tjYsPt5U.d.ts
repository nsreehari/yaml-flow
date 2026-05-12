/**
 * Event Graph — Core Types
 *
 * Type definitions for the stateless event-graph engine.
 * Pure: f(state, event) → newState
 */
interface GraphConfig {
    id?: string;
    settings: GraphSettings;
    tasks: Record<string, TaskConfig>;
}
interface GraphSettings {
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
interface TaskConfig {
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
interface TaskRetryConfig {
    max_attempts: number;
    delay_ms?: number;
    backoff_multiplier?: number;
}
interface TaskCircuitBreakerConfig {
    /** Max executions before injecting break tokens */
    max_executions: number;
    /** Tokens to inject when breaker trips */
    on_break: string[];
}
interface ExecutionConfig {
    executionMode: ExecutionMode;
    conflictStrategy: ConflictStrategy;
    completionStrategy: CompletionStrategy;
}
type GraphEvent = TaskStartedEvent | TaskCompletedEvent | TaskFailedEvent | TaskProgressEvent | TaskRestartEvent | InjectTokensEvent | AgentActionEvent | TaskUpsertEvent | TaskRemovalEvent | NodeRequiresAddEvent | NodeRequiresRemoveEvent | NodeProvidesAddEvent | NodeProvidesRemoveEvent;
interface TaskStartedEvent {
    type: 'task-started';
    taskName: string;
    timestamp: string;
    executionId?: string;
}
interface TaskCompletedEvent {
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
interface TaskFailedEvent {
    type: 'task-failed';
    taskName: string;
    error: string;
    timestamp: string;
    executionId?: string;
}
interface TaskProgressEvent {
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
interface TaskRestartEvent {
    type: 'task-restart';
    taskName: string;
    timestamp: string;
    executionId?: string;
}
interface InjectTokensEvent {
    type: 'inject-tokens';
    tokens: string[];
    timestamp: string;
}
interface AgentActionEvent {
    type: 'agent-action';
    action: 'start' | 'stop' | 'pause' | 'resume';
    timestamp: string;
    config?: Partial<ExecutionConfig>;
}
interface TaskUpsertEvent {
    type: 'task-upsert';
    taskName: string;
    taskConfig: TaskConfig;
    timestamp: string;
}
interface TaskRemovalEvent {
    type: 'task-removal';
    taskName: string;
    timestamp: string;
}
interface NodeRequiresAddEvent {
    type: 'node-requires-add';
    nodeName: string;
    tokens: string[];
    timestamp: string;
}
interface NodeRequiresRemoveEvent {
    type: 'node-requires-remove';
    nodeName: string;
    tokens: string[];
    timestamp: string;
}
interface NodeProvidesAddEvent {
    type: 'node-provides-add';
    nodeName: string;
    tokens: string[];
    timestamp: string;
}
interface NodeProvidesRemoveEvent {
    type: 'node-provides-remove';
    nodeName: string;
    tokens: string[];
    timestamp: string;
}
type CompletionStrategy = 'all-tasks-done' | 'all-outputs-done' | 'only-resolved' | 'goal-reached' | 'manual';
type ExecutionMode = 'dependency-mode' | 'eligibility-mode';
type ConflictStrategy = 'alphabetical' | 'priority-first' | 'duration-first' | 'cost-optimized' | 'resource-aware' | 'random-select' | 'user-choice' | 'parallel-all' | 'skip-conflicts' | 'round-robin';
type RefreshStrategy = 'data-changed' | 'epoch-changed' | 'time-based' | 'manual' | 'once';

/**
 * board-live-cards-lib — Pure logic library for the board-live-cards CLI.
 *
 * Merged from:
 *   board-live-cards-all-stores.ts
 *   board-live-cards-lib-types.ts
 *   board-live-cards-lib-board-status.ts
 *   board-live-cards-lib-card-handler.ts
 *   board-live-cards-cli-board-commands.ts
 *   board-live-cards-cli-card-commands.ts
 *   board-live-cards-cli-callbacks.ts
 *
 * Zero platform imports. All storage is injected via adapter interfaces.
 * Safe for Node, browser, and neutral (V8/PyMiniRacer) bundles.
 */

interface LiveCard {
    id: string;
    [key: string]: unknown;
}
interface CardIndexEntry {
    /** Storage-specific address (file path, Cosmos doc id, localStorage key). */
    key: string;
    /** Checksum of card content — computed by the adapter at write time. */
    checksum: string;
    updatedAt: string;
}
type CardIndex = Record<string, CardIndexEntry>;
type CardChecksumIndex = Record<string, string>;
interface CardStorageAdapter {
    readIndex(): CardIndex | null;
    writeIndex(index: CardIndex): void;
    readCard(key: string): LiveCard | null;
    /** Write card content; returns checksum of what was written. */
    writeCard(key: string, card: LiveCard): string;
    cardExists(key: string): boolean;
    defaultCardKey(cardId: string): string;
}
interface CardStore {
    readCard(id: string): LiveCard | null;
    readCardKey(id: string): string | null;
    readAllCards(): LiveCard[];
    readChecksumIndex(): CardChecksumIndex;
    changedSince(snapshotChecksumIndex: CardChecksumIndex): string[];
}
interface CardUpsertValidation {
    ok: boolean;
    error?: string;
}
interface CardAdminStore extends CardStore {
    validateUpsert(id: string, cardKey: string): CardUpsertValidation;
    writeCard(id: string, card: LiveCard, cardKey?: string): void;
    patchCard(id: string, jsonPath: string, value: unknown): void;
    removeCard(id: string): void;
    readIndex(): CardIndex;
}
declare function createCardStore(adapter: CardStorageAdapter, onWarn?: (msg: string) => void): CardAdminStore;
interface JournalEntry {
    id: string;
    event: GraphEvent;
}
interface JournalStorageAdapter {
    readAllEntries(): JournalEntry[];
    appendEntry(entry: JournalEntry): void;
    generateId(): string;
}
declare const SNAPSHOT_SCHEMA_VERSION_V1 = "v1";
declare const BOARD_GRAPH_KEY = "board/graph";
type OutputStoreEvent = {
    kind: 'computed_values';
    cardId: string;
    values: Record<string, unknown>;
} | {
    kind: 'data_object';
    key: string;
    payload: unknown;
} | {
    kind: 'status';
    status: unknown;
};
interface BoardStatusCard {
    name: string;
    status: string;
    error?: {
        message: string;
        code?: string;
        at?: string;
        source?: 'task-runtime' | 'source-fetch' | 'timeout' | 'unknown';
    };
    requires: string[];
    requires_satisfied: string[];
    requires_missing: string[];
    provides_declared: string[];
    provides_runtime: string[];
    blocked_by: string[];
    unblocks: string[];
    runtime: {
        attempt_count: number;
        restart_count: number;
        in_progress_since: string | null;
        last_transition_at: string | null;
        last_completed_at: string | null;
        last_restarted_at: string | null;
        status_age_ms: number | null;
    };
}
interface BoardStatusObject {
    schema_version: 'v1';
    meta: {
        board: {
            path: string;
        };
    };
    summary: {
        card_count: number;
        completed: number;
        eligible: number;
        pending: number;
        blocked: number;
        unresolved: number;
        failed?: number;
        in_progress?: number;
        orphan_cards?: number;
        topology?: {
            edge_count: number;
            max_fan_out_card: string | null;
            max_fan_out: number;
        };
    };
    cards: BoardStatusCard[];
}
declare const EMPTY_CONFIG: GraphConfig;

export { type BoardStatusObject as B, type CardAdminStore as C, EMPTY_CONFIG as E, type JournalStorageAdapter as J, type LiveCard as L, type OutputStoreEvent as O, SNAPSHOT_SCHEMA_VERSION_V1 as S, BOARD_GRAPH_KEY as a, createCardStore as c };
