import { G as GraphConfig, c as ExecutionState, T as TaskConfig, e as GraphEngineStore } from './types-BBhqYGhE.cjs';

/**
 * Continuous Event Graph — Types
 *
 * A long-lived, evolving event-graph where both config and state
 * mutate over time. The single `LiveGraph` type bundles them.
 *
 * Events are shared with event-graph (task-started, task-completed, etc.).
 * Graph mutations (addNode, removeNode, etc.) are unique to this mode.
 */

/**
 * The single evolving object for a continuous-mode graph.
 * Bundles config + state so they can't get out of sync.
 */
interface LiveGraph {
    /** The current graph configuration (evolves as nodes are added/removed) */
    config: GraphConfig;
    /** The current execution state (evolves as events arrive) */
    state: ExecutionState;
}
interface ScheduleResult {
    /** Tasks ready to dispatch now — all requires satisfied */
    eligible: string[];
    /** Tasks waiting on tokens that some producer will eventually provide (normal) */
    pending: PendingTask[];
    /** Tasks waiting on tokens that NO task can produce (caller's problem) */
    unresolved: UnresolvedDependency[];
    /** Tasks waiting on tokens whose producer FAILED (caller's problem) */
    blocked: BlockedTask[];
    /** Token conflicts: multiple tasks produce the same token */
    conflicts: Record<string, string[]>;
}
interface PendingTask {
    taskName: string;
    /** Tokens this task needs that haven't been produced yet but have a viable producer */
    waitingOn: string[];
}
interface UnresolvedDependency {
    taskName: string;
    /** Tokens this task needs that no task in the graph can produce */
    missingTokens: string[];
}
interface BlockedTask {
    taskName: string;
    /** Tokens this task needs whose only producer has failed */
    failedTokens: string[];
    /** The tasks that failed and would have produced those tokens */
    failedProducers: string[];
}
interface LiveGraphHealth {
    /** Total number of tasks in the graph */
    totalNodes: number;
    /** Task counts by status */
    running: number;
    completed: number;
    failed: number;
    waiting: number;
    notStarted: number;
    /** Number of disabled (inactivated) nodes */
    disabled: number;
    /** Number of tasks with unresolvable dependencies */
    unresolvedCount: number;
    /** Number of tasks whose producer has failed */
    blockedCount: number;
    /** Tokens that no task produces (open dependencies) */
    openDependencies: string[];
    /** Cycles detected in the current graph (if any) */
    cycles: string[][];
    /** Tokens produced by multiple tasks */
    conflictTokens: string[];
}
interface NodeInfo {
    /** Node name */
    name: string;
    /** The task configuration */
    config: TaskConfig;
    /** The current runtime state */
    state: GraphEngineStore;
}
interface LiveGraphSnapshot {
    /** Schema version for forward compatibility */
    version: number;
    /** The graph config at snapshot time */
    config: GraphConfig;
    /** The execution state at snapshot time */
    state: ExecutionState;
    /** ISO timestamp of when the snapshot was taken */
    snapshotAt: string;
}
interface UnreachableTokensResult {
    tokens: {
        /** The token that cannot be produced */
        token: string;
        /** Why it's unreachable */
        reason: 'no-producer' | 'all-producers-failed' | 'transitive';
        /** Tasks that could produce it (but are themselves unreachable/failed) */
        producers: string[];
    }[];
}
interface UnreachableNodesResult {
    nodes: {
        /** The node that can never become eligible */
        nodeName: string;
        /** Unreachable tokens this node requires (empty if the node itself is failed/disabled) */
        missingTokens: string[];
    }[];
}
interface UpstreamResult {
    /** The target node being inspected */
    nodeName: string;
    /** All upstream nodes that transitively feed into the target */
    nodes: {
        nodeName: string;
        /** Tokens this node provides that are in the dependency chain */
        providesTokens: string[];
    }[];
    /** All tokens in the upstream dependency chain */
    tokens: string[];
}
interface DownstreamResult {
    /** The target node being inspected */
    nodeName: string;
    /** All downstream nodes that transitively depend on the target */
    nodes: {
        nodeName: string;
        /** Tokens this node requires that are in the dependency chain */
        requiresTokens: string[];
    }[];
    /** All tokens in the downstream dependency chain */
    tokens: string[];
}

export type { BlockedTask as B, DownstreamResult as D, LiveGraph as L, NodeInfo as N, PendingTask as P, ScheduleResult as S, UnreachableNodesResult as U, LiveGraphHealth as a, LiveGraphSnapshot as b, UnreachableTokensResult as c, UnresolvedDependency as d, UpstreamResult as e };
