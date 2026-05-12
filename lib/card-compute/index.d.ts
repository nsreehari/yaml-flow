/**
 * schema-validator — Full JSON Schema validation for LiveCards nodes.
 *
 * Uses AJV to validate against the published live-cards.schema.json.
 * For a lightweight sync check without AJV, use `CardCompute.validate()` instead.
 *
 * @example
 * ```typescript
 * import { validateLiveCardSchema } from 'yaml-flow/card-compute';
 *
 * const result = validateLiveCardSchema(node);
 * if (!result.ok) console.error(result.errors);
 * ```
 */

/**
 * Validate a node against the full LiveCards JSON Schema (draft-07).
 *
 * Requires `ajv` and `ajv-formats` to be installed.
 * Returns the same `ValidationResult` shape as `CardCompute.validate()`.
 */
declare function validateLiveCardSchema(node: unknown): ValidationResult;
/**
 * Validate JSONata expressions in compute[] by compiling with the same parser used at runtime.
 */
declare function validateLiveCardRuntimeExpressions(node: unknown): ValidationResult;
declare function validateLiveCard(node: unknown): ValidationResult;
/**
 * Full validation for live card definitions:
 * 1) JSON Schema structure/contract checks
 * 2) Runtime JSONata parser compatibility checks for compute expressions
 */
declare function validateLiveCardDefinition(node: unknown): ValidationResult;

/**
 * card-compute — JSONata-powered compute engine for LiveCards nodes.
 *
 * Isomorphic: works in browser, Node.js, and bundlers.
 * No DOM dependency. Compute expressions are JSONata strings.
 *
 * @example
 * ```typescript
 * import { CardCompute } from 'yaml-flow/card-compute';
 *
 * const node = {
 *   id: 'sales',
 *   card_data: { data: [{ revenue: 100 }, { revenue: 200 }] },
 *   compute: [
 *     { bindTo: 'total', expr: '$sum(card_data.data.revenue)' },
 *     { bindTo: 'avg',   expr: '$average(card_data.data.revenue)' },
 *   ],
 * };
 * await CardCompute.run(node);
 * // node.computed_values.total === 300
 * // node.computed_values.avg   === 150
 * ```
 *
 * Expressions are evaluated against { card_data, requires, fetched_sources, computed_values }.
 * computed_values is ephemeral — never persisted to disk.
 */
/** A source definition: cli writes to outputFile; bindTo names the fetched_sources.* key in compute context. Both bindTo and outputFile must be unique across source_defs in a card. */
interface ComputeSource {
    bindTo: string;
    outputFile: string;
    cli?: string;
    script?: string;
    optionalForCompletionGating?: boolean;
    /** Named data projections: each key maps to a JSONata expression rooted at card_data or requires.
     *  The engine evaluates these before spawning the executor and passes results as _projections. */
    projections?: Record<string, string>;
    [key: string]: unknown;
}
/** Options for CardCompute.run() */
interface RunOptions {
    /** Pre-loaded source results map (keyed by bindTo). Use in browser or when caller loads files. */
    sourcesData?: Record<string, unknown>;
}
/** A single compute step: bindTo names the computed_values key; expr is a JSONata expression. */
interface ComputeStep {
    bindTo: string;
    expr: string;
}
/** Minimal node shape expected by CardCompute. */
interface ComputeNode {
    id?: string;
    card_data?: Record<string, unknown>;
    requires?: Record<string, unknown>;
    source_defs?: ComputeSource[];
    compute?: ComputeStep[];
    computed_values?: Record<string, unknown>;
    /** Ephemeral: populated by run() from sourcesData option. Never persisted. */
    _sourcesData?: Record<string, unknown>;
    [key: string]: unknown;
}
/**
 * Run all compute steps on a node.
 * Each step's expr is evaluated against { card_data, requires, fetched_sources, computed_values }.
 * Results are written to node.computed_values[bindTo].
 * computed_values and _sourcesData are reset on each call — ephemeral, never persisted.
 *
 * @param options.sourcesData  Pre-loaded map of { [bindTo]: data } for fetched_sources namespace.
 *   In Node/CLI: loaded from outputFiles by the caller (card-handler).
 *   In browser:  passed in by the caller (e.g. from fetch results).
 */
declare function run(node: ComputeNode, options?: RunOptions): Promise<ComputeNode>;
/**
 * Synchronous version of run() — uses a vendored sync JSONata build
 * (async/await stripped from jsonata.js since all built-in functions
 * are CPU-only).
 *
 * Same semantics as `run()`: evaluates all compute steps, populates
 * `node.computed_values`, returns the mutated node.
 *
 * @returns `{ ok: true, node }` when all steps evaluated successfully.
 *          `{ ok: false, node }` is currently never returned but reserved
 *          for future use if an expression requires true async evaluation.
 */
declare function runSync(node: ComputeNode, options?: RunOptions): {
    ok: boolean;
    node: ComputeNode;
    errors?: Array<{
        bindTo: string;
        error: string;
    }>;
};
/**
 * Evaluate a single JSONata expression against a node's context.
 * Context is { card_data, requires, fetched_sources, computed_values }.
 */
declare function evalExpr(expr: string, node: ComputeNode, vars?: Record<string, unknown>): Promise<unknown>;
declare function resolve(node: ComputeNode, path: string): unknown;
/** Result of validateNode — ok: true means valid, ok: false has errors[]. */
interface ValidationResult {
    ok: boolean;
    errors: string[];
}
declare function validateNode(node: unknown): ValidationResult;
/**
 * Enrich source_defs with execution context for template interpolation and prompt rendering.
 * Pure function: no side effects, returns new enriched source_defs array.
 *
 * @param source_defs - Array of source definitions
 * @param context - Execution context containing requires, sourcesData, computed_values
 * @returns Promise resolving to a new array of source_defs with _projections attached.
 *          Each _projections entry is the evaluated result of the corresponding projections expression.
 */
declare function enrichSources(source_defs: any[] | undefined, context: {
    card_data?: Record<string, any>;
    requires?: Record<string, any>;
    sourcesData?: Record<string, any>;
    computed_values?: Record<string, any>;
}): Promise<any[]>;
declare function enrichSourcesSync(source_defs: any[] | undefined, context: {
    card_data?: Record<string, any>;
    requires?: Record<string, any>;
}): any[];
declare const CardCompute: {
    run: typeof run;
    runSync: typeof runSync;
    eval: typeof evalExpr;
    resolve: typeof resolve;
    validate: typeof validateNode;
    enrichSources: typeof enrichSources;
    enrichSourcesSync: typeof enrichSourcesSync;
};

export { CardCompute, type ComputeNode, type ComputeSource, type ComputeStep, type RunOptions, type ValidationResult, CardCompute as default, validateLiveCard, validateLiveCardDefinition, validateLiveCardRuntimeExpressions, validateLiveCardSchema };
