/**
 * step-machine-public — types
 *
 * Platform-free types for the declarative handler model.
 * No Node imports. Safe for any runtime (Node, browser, Python via codegen, etc.).
 */

import type { ExecutionRef } from '../cli/common/execution-interface.js';

// ============================================================================
// Handler return contract — strict normalized envelope
// ============================================================================

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
export interface NormalizedHandlerResult {
  result: string;
  data: Record<string, unknown>;
  error?: string;
}

// ============================================================================
// Handler spec discriminator types
// ============================================================================

/**
 * Pure JSONata compute step.
 * Each `expr` entry is `"<bindTo> = <jsonata-expression>"` or
 * `{ bindTo: "...", expr: "..." }`.
 *
 * Evaluated sequentially against the flat flow context; each binding is added
 * before the next expression is evaluated.
 */
export interface ComputeJsonataSpec {
  type: 'compute-jsonata';
  expr: Array<string | { bindTo: string; expr: string }>;
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
export interface RefSpec extends ExecutionRef {
  type: 'ref';
}

export type HandlerSpec = ComputeJsonataSpec | RefSpec;

// ============================================================================
// Invocation adapter — the boundary between framework and transport
// ============================================================================

/**
 * Single invocation boundary. The framework calls this for every ref step;
 * the adapter (Node spawn / HTTP / Azure Function / etc.) decides how to
 * actually invoke the ref and normalizes the outcome to {result, data, error?}.
 *
 * `args` is the flat flow context for the step. The adapter is responsible
 * for honoring `ref.argsMassaging` (cmdTemplate / stdinTemplate for local,
 * urlTemplate / headerTemplate / bodyTemplate for HTTP)
 * before performing the transport.
 *
 * May return synchronously (sync transports) or as a Promise (async transports).
 * The framework awaits regardless.
 */
export type InvokeRefFn = (
  ref: ExecutionRef,
  args: Record<string, unknown>,
) => NormalizedHandlerResult | Promise<NormalizedHandlerResult>;

export interface CreateStepMachineChatFlowRunnerOptions {
  invokeRef: InvokeRefFn;
  storeFactory?: () => import('../step-machine/types.js').StepMachineStore;
}

export interface StepMachineChatFlowRunnerResult {
  dispatched: boolean;
  error?: string;
}

export interface StepMachineChatFlowRunner {
  run(flow: unknown, args: Record<string, unknown>): Promise<StepMachineChatFlowRunnerResult>;
}

// ============================================================================
// StepHandler — the engine-facing handler signature
// ============================================================================

/**
 * Handler signature consumed by the existing pure step machine.
 *
 * (Mirrors the StepHandler type in src/step-machine/types.ts but typed in
 * platform-free terms.)
 */
export type StepHandler = (
  input: Record<string, unknown>,
  context?: { stepName?: string; runId?: string },
) => Promise<NormalizedHandlerResult>;

// ============================================================================
// Step config (the subset of StepFlowConfig.steps[stepName] this lib reads)
// ============================================================================

/**
 * The subset of step configuration the handler factory consumes.
 *
 * (We do NOT re-export StepFlowConfig here — that lives in src/step-machine/.
 * This is just the shape the factory needs.)
 */
export interface StepConfigForFactory {
  handler?: HandlerSpec;
  produces_data?: string[];
  input_validations?: string[];
  config?: Record<string, unknown>;
  forEach?: ForEachConfig;
}

export interface ForEachConfig {
  items: string;
  as: string;
  concurrency?: number;
  collectAs?: string;
}
