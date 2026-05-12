import { ExecutionRef } from '../execution-refs.js';

/**
 * step-machine-public — types
 *
 * Platform-free types for the declarative handler model.
 * No Node imports. Safe for any runtime (Node, browser, Python via codegen, etc.).
 */

/**
 * The single normalized shape the engine consumes.
 *
 *  - `result`  drives transitions (e.g. 'success' | 'failure' | 'timeout' | <custom>)
 *  - `data`    drives produces_data projection into flow context
 *  - `error`   optional human-readable failure detail
 *
 * Adapters MUST normalize their transport-specific output into this shape
 * before returning. The engine never inspects payload format.
 */
interface NormalizedHandlerResult {
    result: string;
    data: Record<string, unknown>;
    error?: string;
}
/**
 * Pure JSONata compute step.
 * Each `expr` entry is `"<bindTo> = <jsonata-expression>"` or
 * `{ bindTo: "...", expr: "..." }`.
 *
 * Evaluated sequentially against the flat flow context; each binding is added
 * before the next expression is evaluated.
 */
interface ComputeJsonataSpec {
    type: 'compute-jsonata';
    expr: Array<string | {
        bindTo: string;
        expr: string;
    }>;
}
/**
 * External reference step. The handler spec IS an ExecutionRef plus a
 * `type: 'ref'` discriminator.
 *
 * The engine never invokes refs directly — invocation is delegated to an
 * `InvokeFn` adapter (e.g. Node spawn, HTTP, Azure Function).
 *
 * `whatToRun` may be either:
 *   - a `b64:<base64url(json)>` wire string (programmatically generated)
 *   - a plain `{ kind, value }` object (human-authored flow files)
 *
 * The handler factory normalizes the object form via `serializeRef` before
 * dispatching, so downstream adapters always receive the string form.
 */
interface RefSpec extends ExecutionRef {
    type: 'ref';
}
type HandlerSpec = ComputeJsonataSpec | RefSpec;
/**
 * Single invocation boundary. The framework calls this for every ref step;
 * the adapter (Node spawn / HTTP / Azure Function / etc.) decides how to
 * actually invoke the ref and normalizes the outcome to {result, data, error?}.
 *
 * `args` is the flat flow context for the step. The adapter is responsible
 * for honoring `ref.argsMassaging` (cmdTemplate / urlTemplate / bodyTemplate)
 * before performing the transport.
 *
 * May return synchronously (sync transports) or as a Promise (async transports).
 * The framework awaits regardless.
 */
type InvokeRefFn = (ref: ExecutionRef, args: Record<string, unknown>) => NormalizedHandlerResult | Promise<NormalizedHandlerResult>;
/**
 * Handler signature consumed by the existing pure step machine.
 *
 * (Mirrors the StepHandler type in src/step-machine/types.ts but typed in
 * platform-free terms.)
 */
type StepHandler = (input: Record<string, unknown>, context?: {
    stepName?: string;
    runId?: string;
}) => Promise<NormalizedHandlerResult>;
/**
 * The subset of step configuration the handler factory consumes.
 *
 * (We do NOT re-export StepFlowConfig here — that lives in src/step-machine/.
 * This is just the shape the factory needs.)
 */
interface StepConfigForFactory {
    handler?: HandlerSpec;
    produces_data?: string[];
    input_validations?: string[];
    config?: Record<string, unknown>;
}

/**
 * step-machine-public — handler factory
 *
 * Builds engine-facing StepHandlers from declarative HandlerSpec entries.
 * Pure: no Node imports, no transport. Refs are dispatched through the
 * caller-supplied `InvokeFn`, which is the single boundary between this lib
 * and any transport (Node spawn, HTTP, Azure Function, etc.).
 *
 * Layering:
 *
 *   step-machine (pure FSM)            — runs handlers, never builds them.
 *   step-machine-public (this lib)     — declarative spec → StepHandler map.
 *   adapter (e.g. node-spawn-invoker)  — InvokeFn implementation per transport.
 *   step-machine-cli (thin shell)      — wires adapter + flow loader + run.
 */

declare function isComputeJsonataSpec(spec: unknown): spec is ComputeJsonataSpec;
declare function isRefSpec(spec: unknown): spec is RefSpec;
declare function createComputeJsonataHandler(spec: ComputeJsonataSpec, stepName: string, config?: Record<string, unknown>): StepHandler;
declare function createRefStepHandler(spec: RefSpec, stepName: string, invoke: InvokeRefFn, config?: Record<string, unknown>): StepHandler;
declare function createPassthroughHandler(): StepHandler;
interface ResolveStepHandlerOptions {
    invoke: InvokeRefFn;
}
declare function resolveStepHandler(stepName: string, stepConfig: StepConfigForFactory | undefined, options: ResolveStepHandlerOptions): StepHandler;
interface BuildStepHandlersOptions {
    invoke: InvokeRefFn;
}
declare function buildStepHandlersForFlow(flow: {
    steps?: Record<string, StepConfigForFactory>;
}, options: BuildStepHandlersOptions): Record<string, StepHandler>;

/**
 * step-machine-public — result utilities
 *
 * Pure helpers that:
 *  - Normalize handler return shapes into NormalizedHandlerResult.
 *  - Filter `data` to the keys declared in `produces_data`.
 *  - Wrap a handler with output filtering / input validation.
 *
 * No transport, no I/O — only object reshaping.
 */

declare function normalizeHandlerResult(raw: unknown, stepName: string): NormalizedHandlerResult;
declare function filterProducedData(data: Record<string, unknown>, produces: string[] | undefined): Record<string, unknown>;
declare function wrapWithOutputFiltering(handler: StepHandler, produces: string[] | undefined): StepHandler;
/**
 * Evaluate each validation as a JSONata expression returning truthy.
 *
 * Returns `null` on success, or a normalized failure result on the first
 * failed/throwing validation.
 */
declare function runInputValidations(input: Record<string, unknown>, validations: string[] | undefined, stepName: string): NormalizedHandlerResult | null;
declare function wrapWithInputValidations(handler: StepHandler, validations: string[] | undefined, stepName: string): StepHandler;

/**
 * step-machine-public — jsonata loader
 *
 * Synchronous jsonata wrapper. Mirrors the loader pattern in
 * src/card-compute/index.ts — uses createRequire to load the vendored
 * synchronous CommonJS build.
 *
 * Runtime portability:
 *   - Node ESM: createRequire works.
 *   - Browser/cloud: package this lib for that runtime; the consumer ships
 *     jsonata-sync.cjs alongside (tsup post-build does this automatically).
 */
type JsonataExpression = {
    evaluate: (data: unknown) => unknown;
};
declare const jsonata: (expr: string) => JsonataExpression;

export { type BuildStepHandlersOptions, type ComputeJsonataSpec, type HandlerSpec, type InvokeRefFn, type JsonataExpression, type NormalizedHandlerResult, type RefSpec, type ResolveStepHandlerOptions, type StepConfigForFactory, type StepHandler, buildStepHandlersForFlow, createComputeJsonataHandler, createPassthroughHandler, createRefStepHandler, filterProducedData, isComputeJsonataSpec, isRefSpec, jsonata, normalizeHandlerResult, resolveStepHandler, runInputValidations, wrapWithInputValidations, wrapWithOutputFiltering };
