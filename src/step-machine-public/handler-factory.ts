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

import { jsonata } from './jsonata-loader.js';
import { wrapWithInputValidations, wrapWithOutputFiltering } from './result-utils.js';
import { resolveOutputTransforms } from '../cli/common/args-massaging.js';
import { serializeRef } from '../cli/common/storage-interface.js';
import type {
  ComputeJsonataSpec,
  ForEachConfig,
  HandlerSpec,
  InvokeRefFn,
  NormalizedHandlerResult,
  RefSpec,
  StepConfigForFactory,
  StepHandler,
} from './types.js';

// ============================================================================
// Discriminators
// ============================================================================

export function isComputeJsonataSpec(spec: unknown): spec is ComputeJsonataSpec {
  return (
    !!spec &&
    typeof spec === 'object' &&
    (spec as Record<string, unknown>).type === 'compute-jsonata' &&
    Array.isArray((spec as Record<string, unknown>).expr) &&
    ((spec as Record<string, unknown>).expr as unknown[]).length > 0
  );
}

export function isRefSpec(spec: unknown): spec is RefSpec {
  if (!spec || typeof spec !== 'object') return false;
  const s = spec as Record<string, unknown>;
  if (s.type !== 'ref' || typeof s.howToRun !== 'string') return false;
  if (typeof s.whatToRun === 'string') return true;
  if (s.whatToRun && typeof s.whatToRun === 'object') {
    const w = s.whatToRun as Record<string, unknown>;
    return typeof w.kind === 'string' && typeof w.value === 'string';
  }
  return false;
}

// ============================================================================
// Compute-jsonata handler
// ============================================================================

interface NormalizedComputeStep {
  bindTo: string;
  expr: string;
}

function normalizeComputeStep(item: string | { bindTo: string; expr: string }): NormalizedComputeStep {
  if (typeof item === 'string') {
    const eq = item.indexOf('=');
    if (eq < 1) {
      throw new Error(`[step-machine-public] Invalid compute expression (missing "="): "${item}"`);
    }
    return { bindTo: item.slice(0, eq).trim(), expr: item.slice(eq + 1).trim() };
  }
  if (item && typeof item === 'object' && typeof item.bindTo === 'string' && typeof item.expr === 'string') {
    return item;
  }
  throw new Error(`[step-machine-public] Invalid compute step: ${JSON.stringify(item)}`);
}

/** Mutate nested dict via dot-path key. */
function deepSet(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

export function createComputeJsonataHandler(
  spec: ComputeJsonataSpec,
  stepName: string,
  config?: Record<string, unknown>,
): StepHandler {
  const steps = spec.expr.map(normalizeComputeStep);
  return async (input) => {
    const expects_data: Record<string, unknown> =
      input && typeof input === 'object' && !Array.isArray(input)
        ? { ...input }
        : {};

    // `data` accumulates computed outputs; it is placed in ctx by reference
    // so subsequent expressions can read `data.x` after earlier steps set it.
    const data: Record<string, unknown> = {};

    // Context shape:
    //   expects_data — named namespace for declared step inputs (from flow state)
    //   data         — accumulating output namespace (required, mutated by reference)
    //   config       — optional step-level config
    const ctx: Record<string, unknown> = {
      expects_data,
      data,                 // same reference — mutations visible in later steps
      ...(config ? { config } : {}),
    };

    let transitionResult: string | undefined;
    let transitionError: string | undefined;

    for (const step of steps) {
      try {
        const val = jsonata(step.expr).evaluate(ctx);

        if (step.bindTo === 'result') {
          // Transition outcome
          transitionResult = val != null ? String(val) : 'success';
        } else if (step.bindTo === 'error') {
          // Transition error detail
          transitionError = val != null ? String(val) : undefined;
        } else if (step.bindTo.startsWith('data.')) {
          // Namespaced output — mutates the shared data reference
          deepSet(data, step.bindTo.slice('data.'.length), val);
        } else {
          return {
            result: 'failure',
            data: {},
            error: `[${stepName}] invalid bindTo "${step.bindTo}": must be "result", "error", or start with "data."`,
          };
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          result: 'failure',
          data: {},
          error: `[${stepName}] compute "${step.bindTo}" failed: ${msg}`,
        };
      }
    }

    if (transitionResult === undefined) {
      return {
        result: 'failure',
        data: {},
        error: `[${stepName}] compute-jsonata: no "result" binding declared — add '- result = "success"' to expr`,
      };
    }
    return transitionError
      ? { result: transitionResult, data, error: transitionError }
      : { result: transitionResult, data };
  };
}

// ============================================================================
// Ref handler — dispatches via InvokeFn
// ============================================================================

export function createRefStepHandler(
  spec: RefSpec,
  stepName: string,
  invoke: InvokeRefFn,
  config?: Record<string, unknown>,
): StepHandler {
  // The handler spec itself is a superset of ExecutionRef. Strip the discriminator
  // before passing to the adapter so it sees a plain ExecutionRef.
  // Normalize whatToRun from object form { kind, value } → b64 string.
  const { type: _t, ...refOnly } = spec;
  const ref = {
    ...refOnly,
    whatToRun: typeof refOnly.whatToRun === 'object'
      ? serializeRef(refOnly.whatToRun)
      : refOnly.whatToRun,
  };

  return async (input) => {
    const stepInput: Record<string, unknown> =
      input && typeof input === 'object' && !Array.isArray(input)
        ? { ...input }
        : {};
    if (config) stepInput.config = config;

    try {
      const raw = await invoke(ref, stepInput);
      if (!spec.outputTransforms) return raw;
      if (raw && raw.result !== 'success') {
        const dataError = raw.data && typeof (raw.data as Record<string, unknown>).error === 'string'
          ? String((raw.data as Record<string, unknown>).error)
          : undefined;
        if (dataError && !raw.error) return { ...raw, error: dataError };
        return raw;
      }
      try {
        return resolveOutputTransforms(spec.outputTransforms, raw, stepName);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { result: 'failure', data: {}, error: msg };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        result: 'failure',
        data: { error: `[step-machine-public] step "${stepName}" invoke threw: ${msg}` },
      };
    }
  };
}

// ============================================================================
// Passthrough handler
// ============================================================================

export function createPassthroughHandler(): StepHandler {
  return async (input) => {
    const data: Record<string, unknown> =
      input && typeof input === 'object' && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : {};
    return { result: 'success', data };
  };
}

// ============================================================================
// forEach wrapper — iterates a handler over an array with concurrency control
// ============================================================================

function wrapWithForEach(
  handler: StepHandler,
  forEach: ForEachConfig,
  stepName: string,
): StepHandler {
  return async (input, context) => {
    const rawArr = input?.[forEach.items];
    if (!Array.isArray(rawArr)) {
      return {
        result: 'failure',
        data: {},
        error: `[${stepName}] forEach: "${forEach.items}" is not an array (got ${typeof rawArr})`,
      };
    }
    const arr = rawArr as unknown[];

    const dataKey = forEach.collectAs ?? `${forEach.items}_results`;
    if (arr.length === 0) {
      return { result: 'success', data: { [dataKey]: [] } };
    }

    const { [forEach.items]: _arr, ...restInput } = input;
    const concurrency = Math.max(1, forEach.concurrency ?? 1);
    const results = new Array<NormalizedHandlerResult>(arr.length);

    // Slot-based concurrency limiter (inline — no external dependency)
    let active = 0;
    let nextIdx = 0;
    let failCount = 0;

    await new Promise<void>((resolve) => {
      function startNext() {
        while (active < concurrency && nextIdx < arr.length) {
          const i = nextIdx++;
          active++;
          const itemInput = { ...restInput, [forEach.as]: arr[i] };
          handler(itemInput, context)
            .then((r) => { results[i] = r; })
            .catch((err) => {
              const msg = err instanceof Error ? err.message : String(err);
              results[i] = { result: 'failure', data: {}, error: msg };
            })
            .finally(() => {
              active--;
              if (results[i]?.result === 'failure') failCount++;
              if (nextIdx >= arr.length && active === 0) resolve();
              else startNext();
            });
        }
        if (active === 0 && nextIdx >= arr.length) resolve();
      }
      startNext();
    });

    if (failCount > 0) {
      const errors = results.filter(r => r.result === 'failure').map(r => r.error);
      return {
        result: 'failure',
        data: { errors },
        error: `[${stepName}] forEach: ${failCount}/${arr.length} items failed`,
      };
    }

    return {
      result: 'success',
      data: { [dataKey]: results.map(r => r.data) },
    };
  };
}

// ============================================================================
// resolveStepHandler — pick + decorate the right handler for a step
// ============================================================================

export interface ResolveStepHandlerOptions {
  invoke: InvokeRefFn;
}

export function resolveStepHandler(
  stepName: string,
  stepConfig: StepConfigForFactory | undefined,
  options: ResolveStepHandlerOptions,
): StepHandler {
  const produces = Array.isArray(stepConfig?.produces_data) ? stepConfig?.produces_data : undefined;
  const inputValidations = Array.isArray(stepConfig?.input_validations)
    ? stepConfig?.input_validations
    : undefined;
  const config = stepConfig?.config ?? undefined;
  const spec: HandlerSpec | undefined = stepConfig?.handler;

  let base: StepHandler;
  if (isComputeJsonataSpec(spec)) {
    // compute-jsonata: validations are baked in via the wrapper as well; both work.
    base = createComputeJsonataHandler(spec, stepName, config);
  } else if (isRefSpec(spec)) {
    base = createRefStepHandler(spec, stepName, options.invoke, config);
  } else {
    base = createPassthroughHandler();
  }

  // forEach wraps before output filtering so collected results flow through produces_data
  if (stepConfig?.forEach) {
    base = wrapWithForEach(base, stepConfig.forEach, stepName);
  }

  return wrapWithInputValidations(
    wrapWithOutputFiltering(base, produces),
    inputValidations,
    stepName,
  );
}

// ============================================================================
// buildStepHandlersForFlow — produce the Record<stepName, StepHandler> map
// ============================================================================

export interface BuildStepHandlersOptions {
  invoke: InvokeRefFn;
}

export function buildStepHandlersForFlow(
  flow: { steps?: Record<string, StepConfigForFactory> },
  options: BuildStepHandlersOptions,
): Record<string, StepHandler> {
  const handlers: Record<string, StepHandler> = {};
  for (const [stepName, stepConfig] of Object.entries(flow.steps ?? {})) {
    handlers[stepName] = resolveStepHandler(stepName, stepConfig, options);
  }
  return handlers;
}

// Re-export for adapter convenience.
export type { NormalizedHandlerResult };
