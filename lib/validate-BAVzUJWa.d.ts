import { G as GraphConfig } from './types-BBhqYGhE.js';

/**
 * Event Graph — Semantic Graph Validation
 *
 * Validates the logical correctness of a static graph configuration.
 * Unlike validateGraphConfig() which checks JSON structure, this checks:
 *   - Dangling requires (tokens no task produces)
 *   - Circular dependencies
 *   - Provide conflicts (multiple tasks producing same token)
 *   - Unreachable goal tokens
 *   - Dead-end tasks (no provides)
 *   - Self-dependencies
 *   - Orphaned tasks (disconnected from the graph)
 *
 * Pure function — config in, diagnostics out.
 */

type IssueSeverity = 'error' | 'warning' | 'info';
interface GraphIssue {
    /** Severity: error = will break execution, warning = may cause problems, info = notable */
    severity: IssueSeverity;
    /** Machine-readable issue code */
    code: string;
    /** Human-readable description */
    message: string;
    /** Affected task names (if applicable) */
    tasks?: string[];
    /** Affected tokens (if applicable) */
    tokens?: string[];
}
interface GraphValidationResult {
    /** true if no errors (warnings/info are allowed) */
    valid: boolean;
    /** All issues found */
    issues: GraphIssue[];
    /** Just the errors */
    errors: GraphIssue[];
    /** Just the warnings */
    warnings: GraphIssue[];
}
/**
 * Validate the semantic correctness of a static event-graph configuration.
 *
 * Checks for logical issues that would cause execution failures, stuck states,
 * or unexpected behavior. Does NOT check JSON structure (use validateGraphConfig for that).
 *
 * @param graph - The event-graph configuration to validate
 * @returns Validation result with categorized issues
 */
declare function validateGraph(graph: GraphConfig): GraphValidationResult;

export { type GraphIssue as G, type IssueSeverity as I, type GraphValidationResult as a, validateGraph as v };
