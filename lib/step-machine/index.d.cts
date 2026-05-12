import { e as StepFlowConfig, g as StepHandler, i as StepMachineOptions, d as StepEventType, c as StepEventListener, j as StepMachineResult, k as StepMachineState, n as StepResult, m as StepReducerResult } from '../types-ycun84cq.cjs';
export { C as CircuitBreakerConfig, R as RetryConfig, S as StepConfig, a as StepContext, b as StepEvent, f as StepFlowSettings, h as StepInput, l as StepMachineStore, T as TerminalStateConfig } from '../types-ycun84cq.cjs';

/**
 * Step Machine — Convenience Driver Class
 *
 * Wraps the pure reducer with a run loop and store I/O.
 * This is the framework layer. The reducer is the pure core.
 */

declare class StepMachine {
    private flow;
    private handlers;
    private store;
    private components;
    private options;
    private listeners;
    private aborted;
    constructor(flow: StepFlowConfig, handlers: Record<string, StepHandler>, options?: StepMachineOptions);
    private validateFlow;
    on(eventType: StepEventType, listener: StepEventListener): void;
    off(eventType: StepEventType, listener: StepEventListener): void;
    private emit;
    private sleep;
    run(initialData?: Record<string, unknown>): Promise<StepMachineResult>;
    resume(runId: string): Promise<StepMachineResult>;
    pause(runId: string): Promise<void>;
    private executeLoop;
}
/** Convenience factory */
declare function createStepMachine(flow: StepFlowConfig, handlers: Record<string, StepHandler>, options?: StepMachineOptions): StepMachine;

/**
 * Step Machine Reducer — Pure Functions
 *
 * currentState + stepResult → newState
 * No I/O, no side effects, deterministic.
 */

/**
 * Apply a step result to the current state and compute the next state.
 * Pure function: no side effects.
 */
declare function applyStepResult(flow: StepFlowConfig, state: StepMachineState, stepName: string, stepResult: StepResult): StepReducerResult;
/**
 * Check circuit breaker for a step. Returns the redirected step if broken.
 * Pure function.
 */
declare function checkCircuitBreaker(flow: StepFlowConfig, state: StepMachineState, stepName: string): {
    broken: boolean;
    redirectStep?: string;
    newState: StepMachineState;
};
/**
 * Compute what a step needs as input. Pure function.
 */
declare function computeStepInput(flow: StepFlowConfig, stepName: string, allData: Record<string, unknown>): Record<string, unknown>;
/**
 * Extract return data from terminal state. Pure function.
 */
declare function extractReturnData(returnArtifacts: string | string[] | false | undefined, allData: Record<string, unknown>): Record<string, unknown>;
/**
 * Create initial state for a new run. Pure function.
 */
declare function createInitialState(flow: StepFlowConfig, runId: string): StepMachineState;

/**
 * Step Machine — Loader
 *
 * Utilities for loading and validating step-machine flow configurations.
 */

declare function parseStepFlowYaml(yamlString: string): Promise<StepFlowConfig>;
declare function validateStepFlowConfig(flow: unknown): string[];
declare function loadStepFlow(source: string | StepFlowConfig): Promise<StepFlowConfig>;

/**
 * schema-validator — Full JSON Schema validation for StepFlow configs.
 *
 * Uses AJV to validate against the published flow.schema.json.
 * For a lightweight sync check without AJV, use `validateStepFlowConfig()` instead.
 *
 * @example
 * ```typescript
 * import { validateFlowSchema } from 'yaml-flow/step-machine';
 *
 * const result = validateFlowSchema(config);
 * if (!result.ok) console.error(result.errors);
 * ```
 */
interface SchemaValidationResult {
    ok: boolean;
    errors: string[];
}
/**
 * Validate a step-flow config against the full flow.schema.json (draft-07).
 *
 * Requires `ajv` and `ajv-formats` to be installed.
 */
declare function validateFlowSchema(config: unknown): SchemaValidationResult;

export { StepEventListener, StepEventType, StepFlowConfig, StepHandler, StepMachine, StepMachineOptions, StepMachineResult, StepMachineState, StepReducerResult, StepResult, applyStepResult, checkCircuitBreaker, computeStepInput, createInitialState, createStepMachine, extractReturnData, loadStepFlow, parseStepFlowYaml, validateFlowSchema, validateStepFlowConfig };
