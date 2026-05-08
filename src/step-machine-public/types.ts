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
 */
export interface RefSpec extends ExecutionRef {
  type: 'ref';
}

export type HandlerSpec = ComputeJsonataSpec | RefSpec;

// ============================================================================
// Invocation adapter — the boundary between framework and transport
// ============================================================================

/**
 * Single invocation boundary. Implementations:
 *   - Node spawn:     spawnSync(node|python|process, args, { input: stdin })
 *   - HTTP:           fetch(url, { method, body })
 *   - Azure Function: HTTP POST with platform-specific auth
 *
 * Adapter responsibilities:
 *   1. Apply ref.argsMassaging (cmdTemplate / urlTemplate / bodyTemplate)
 *   2. Perform the transport
 *   3. Normalize transport outcome (exit code / status code / etc.) into
 *      `{ result, data, error? }`
 *   4. Pass through the response payload as `data` (object preferred; raw
 *      stdout/blob/etc. as the adapter sees fit)
 */
export type InvokeFn = (
  ref: ExecutionRef,
  input: Record<string, unknown>,
  context: { stepName: string },
) => Promise<NormalizedHandlerResult>;

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
}
