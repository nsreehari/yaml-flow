import { createStepMachine } from '../../step-machine/index.js';
import { MemoryStore } from '../../stores/memory.js';
import type { StepFlowConfig, StepHandler, StepMachineStore, StepMachineState, StepResult } from '../../step-machine/types.js';
import { createRequire } from 'module';
const _requireJsonata = createRequire(import.meta.url);
const jsonata: (expr: string) => { evaluate: (data: unknown) => unknown } = _requireJsonata('../../card-compute/jsonata-sync.cjs');

declare global {
  // Injected by Python host bridge.
  // eslint-disable-next-line no-var
  var __hostCall: (payload: unknown) => unknown;
  // QuickJS callable surface.
  // eslint-disable-next-line no-var
  var pycliStepMachineInvoke: (payload: StepMachineInvokePayload) => Promise<StepMachineInvokeResult>;
}

type StepMachineInvokePayload = {
  mode: 'run' | 'resume';
  flow: StepFlowConfig;
  flowDir: string;
  store:
    | { type: 'memory' }
    | { type: 'file'; directory: string };
  runId?: string;
  initialData?: Record<string, unknown>;
  inlineHandlerNames?: string[];
  pauseFilePath?: string;
  handlerVars?: Record<string, unknown>;
};

type StepMachineInvokeResult = {
  status: 'completed' | 'failed' | 'paused' | 'noop';
  runId?: string;
  intent?: string;
  finalStep?: string;
  stepHistory?: string[];
  data?: Record<string, unknown>;
  currentStep?: string;
  pausedAt?: number;
  reason?: string;
  error?: string;
};

type HostCliExecResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
};

type AbortControllerLike = {
  signal: AbortSignal;
  abort: () => void;
};

function createAbortControllerCompat(): AbortControllerLike {
  if (typeof AbortController !== 'undefined') {
    return new AbortController();
  }

  let aborted = false;
  const listeners: Array<() => void> = [];
  const signal = {
    get aborted() {
      return aborted;
    },
    addEventListener(type: string, listener: unknown) {
      if (type !== 'abort') return;
      if (typeof listener === 'function') {
        listeners.push(listener as () => void);
      }
    },
  } as unknown as AbortSignal;

  return {
    signal,
    abort() {
      if (aborted) return;
      aborted = true;
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

function hostCall<T>(payload: unknown): T {
  return globalThis.__hostCall(payload) as T;
}

class HostFileStore implements StepMachineStore {
  constructor(private readonly directory: string) {}

  async saveRunState(runId: string, state: StepMachineState): Promise<void> {
    hostCall<boolean>({ op: 'step.store.saveRunState', directory: this.directory, runId, state });
  }

  async loadRunState(runId: string): Promise<StepMachineState | null> {
    return hostCall<StepMachineState | null>({ op: 'step.store.loadRunState', directory: this.directory, runId });
  }

  async deleteRunState(runId: string): Promise<void> {
    hostCall<boolean>({ op: 'step.store.deleteRunState', directory: this.directory, runId });
  }

  async setData(runId: string, key: string, value: unknown): Promise<void> {
    hostCall<boolean>({ op: 'step.store.setData', directory: this.directory, runId, key, value });
  }

  async getData(runId: string, key: string): Promise<unknown> {
    return hostCall<unknown>({ op: 'step.store.getData', directory: this.directory, runId, key });
  }

  async getAllData(runId: string): Promise<Record<string, unknown>> {
    return hostCall<Record<string, unknown>>({ op: 'step.store.getAllData', directory: this.directory, runId });
  }

  async clearData(runId: string): Promise<void> {
    hostCall<boolean>({ op: 'step.store.clearData', directory: this.directory, runId });
  }

  async listRuns(): Promise<string[]> {
    return hostCall<string[]>({ op: 'step.store.listRuns', directory: this.directory });
  }
}

function isCliSpec(spec: unknown): spec is { cli: string; ['input-transforms']?: Record<string, unknown>; ['output-transforms']?: Record<string, unknown>; ['result-mode']?: string } {
  return !!spec && typeof spec === 'object' && typeof (spec as { cli?: string }).cli === 'string' && (spec as { cli: string }).cli.trim().length > 0;
}

function isInlineSpec(spec: unknown): spec is { inline: string } {
  return !!spec && typeof spec === 'object' && typeof (spec as { inline?: string }).inline === 'string' && (spec as { inline: string }).inline.trim().length > 0;
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('empty stdout');
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).filter(Boolean);
    const last = lines[lines.length - 1];
    return JSON.parse(last);
  }
}

function normalizeHandlerResult(raw: unknown, stepName: string): StepResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`[step-machine-pycli] Step "${stepName}" returned a non-object result.`);
  }

  const obj = raw as { result?: unknown; status?: unknown; data?: unknown; error?: unknown };
  const result = obj.result ?? obj.status;
  if (typeof result !== 'string' || result.trim().length === 0) {
    throw new Error(`[step-machine-pycli] Step "${stepName}" result must include a non-empty "result" (or "status") string.`);
  }

  const data = obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)
    ? { ...(obj.data as Record<string, unknown>) }
    : {};

  const error = typeof obj.error === 'string' ? obj.error : undefined;
  if (error && !('error' in data)) {
    data.error = error;
  }

  return {
    result,
    data,
  };
}

function filterProducedData(data: Record<string, unknown> | undefined, produces?: string[]): Record<string, unknown> {
  const src = data ?? {};
  if (!produces || produces.length === 0) {
    return src;
  }

  const filtered: Record<string, unknown> = {};
  for (const key of produces) {
    if (Object.prototype.hasOwnProperty.call(src, key)) {
      filtered[key] = src[key];
    }
  }
  return filtered;
}

async function evaluateTransforms(
  transformSpec: unknown,
  source: Record<string, unknown>,
  stepName: string,
  label: string,
): Promise<Record<string, unknown>> {
  if (transformSpec === undefined || transformSpec === null) {
    return {};
  }

  if (!transformSpec || typeof transformSpec !== 'object' || Array.isArray(transformSpec)) {
    throw new Error(`[step-machine-pycli] Step "${stepName}" ${label} must be an object map of key -> JSONata expression.`);
  }

  const result: Record<string, unknown> = {};
  for (const [key, expression] of Object.entries(transformSpec as Record<string, unknown>)) {
    if (typeof expression !== 'string') {
      result[key] = expression;
      continue;
    }

    if (expression.trim().length === 0) {
      throw new Error(`[step-machine-pycli] Step "${stepName}" ${label}.${key} must be a non-empty string expression.`);
    }

    if (label === 'handler_vars' && !expression.startsWith('=')) {
      result[key] = expression;
      continue;
    }

    const jsonataExpression = label === 'handler_vars' && expression.startsWith('=')
      ? expression.slice(1)
      : expression;

    if (Object.prototype.hasOwnProperty.call(source, jsonataExpression)) {
      result[key] = source[jsonataExpression];
      continue;
    }

    try {
      const compiled = jsonata(jsonataExpression);
      result[key] = await compiled.evaluate(source);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`[step-machine-pycli] Step "${stepName}" ${label}.${key} failed: ${msg}`);
    }
  }

  return result;
}

function applyCommandTemplate(command: string, source: Record<string, unknown>, stepName: string): string {
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new Error(`[step-machine-pycli] Step "${stepName}" handler.cli must be a non-empty command string.`);
  }

  return command.replace(/%%([A-Za-z0-9_-]+)%%/g, (full, key) => {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      throw new Error(`[step-machine-pycli] Step "${stepName}" command placeholder ${full} has no matching input or input-transform value.`);
    }
    const value = source[key];
    if (value === undefined || value === null) {
      throw new Error(`[step-machine-pycli] Step "${stepName}" command placeholder ${full} resolved to empty value.`);
    }
    return String(value);
  });
}

function wrapWithOutputFiltering(handler: StepHandler, produces?: string[]): StepHandler {
  return async (input, context) => {
    const raw = await handler(input, context);
    const normalized = normalizeHandlerResult(raw, context.stepName);
    return {
      result: normalized.result,
      data: filterProducedData(normalized.data, produces),
    };
  };
}

function createPassthroughHandler(): StepHandler {
  return async (input) => {
    const data = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};
    return { result: 'success', data };
  };
}

function createCliStepHandler(
  spec: { cli: string; ['input-transforms']?: Record<string, unknown>; ['output-transforms']?: Record<string, unknown>; ['result-mode']?: string },
  flowDir: string,
  stepName: string,
  handlerVars: Record<string, unknown>,
): StepHandler {
  return async (input) => {
    const stepInput = input && typeof input === 'object' && !Array.isArray(input)
      ? input as Record<string, unknown>
      : {};

    const resolvedHandlerVars = await evaluateTransforms(
      handlerVars,
      stepInput,
      stepName,
      'handler_vars',
    );

    const inputTransforms = await evaluateTransforms(
      spec['input-transforms'],
      { ...stepInput, ...resolvedHandlerVars },
      stepName,
      'input-transforms',
    );

    const effectiveInput = { ...stepInput, ...resolvedHandlerVars, ...inputTransforms };
    const command = applyCommandTemplate(spec.cli, effectiveInput, stepName);

    const result = hostCall<HostCliExecResult>({
      op: 'step.runCli',
      command,
      cwd: flowDir,
      payloadJson: JSON.stringify(effectiveInput),
    });

    if (result.error) {
      return {
        result: 'failure',
        data: { error: `[step-machine-pycli] step "${stepName}" failed to start: ${result.error}` },
      };
    }

    const stdout = result.stdout ?? '';
    const stderr = (result.stderr ?? '').trim();
    const resultMode = String(spec['result-mode'] ?? 'json').toLowerCase();

    if (result.status !== 0) {
      return {
        result: 'failure',
        data: {
          error: `[step-machine-pycli] step "${stepName}" exited with status ${result.status}${stderr ? `: ${stderr}` : ''}`,
        },
      };
    }

    if (resultMode === 'exit-code') {
      const outputTransforms = await evaluateTransforms(
        spec['output-transforms'],
        {
          ...effectiveInput,
          result: 'success',
          stdout,
          stderr,
        },
        stepName,
        'output-transforms',
      );

      return {
        result: 'success',
        data: outputTransforms,
      };
    }

    try {
      const parsed = parseJsonOutput(stdout);
      const normalized = normalizeHandlerResult(parsed, stepName);
      const outputTransforms = await evaluateTransforms(
        spec['output-transforms'],
        {
          ...effectiveInput,
          result: normalized.result,
          data: normalized.data,
        },
        stepName,
        'output-transforms',
      );

      if (Object.keys(outputTransforms).length === 0) {
        return normalized;
      }

      return {
        result: normalized.result,
        data: outputTransforms,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        result: 'failure',
        data: {
          error: `[step-machine-pycli] step "${stepName}" returned invalid JSON on stdout: ${msg}`,
        },
      };
    }
  };
}

function createInlinePythonStepHandler(inlineName: string): StepHandler {
  return async (input, context) => {
    return hostCall<StepResult>({
      op: 'step.invokePythonInline',
      handlerName: inlineName,
      stepName: context.stepName,
      runId: context.runId,
      input,
    });
  };
}

function buildStepHandlers(
  flow: StepFlowConfig,
  flowDir: string,
  inlineHandlerNames: Set<string>,
  handlerVars: Record<string, unknown>,
): Record<string, StepHandler> {
  const handlers: Record<string, StepHandler> = {};

  for (const [stepName, stepConfig] of Object.entries(flow.steps ?? {})) {
    const produces = Array.isArray(stepConfig?.produces_data) ? stepConfig.produces_data : undefined;
    const spec = (stepConfig as { handler?: unknown }).handler;

    if (isCliSpec(spec)) {
      handlers[stepName] = wrapWithOutputFiltering(
        createCliStepHandler(spec, flowDir, stepName, handlerVars),
        produces,
      );
      continue;
    }

    if (isInlineSpec(spec)) {
      const inlineName = spec.inline;
      if (!inlineHandlerNames.has(inlineName)) {
        throw new Error(`[step-machine-pycli] Inline Python handler "${inlineName}" for step "${stepName}" was not found in --handlers module.`);
      }
      handlers[stepName] = wrapWithOutputFiltering(createInlinePythonStepHandler(inlineName), produces);
      continue;
    }

    handlers[stepName] = wrapWithOutputFiltering(createPassthroughHandler(), produces);
  }

  return handlers;
}

function makeStore(payloadStore: StepMachineInvokePayload['store']): StepMachineStore {
  if (payloadStore.type === 'memory') {
    return new MemoryStore();
  }
  return new HostFileStore(payloadStore.directory);
}

async function invoke(payload: StepMachineInvokePayload): Promise<StepMachineInvokeResult> {
  const store = makeStore(payload.store);
  const inlineHandlerNames = new Set(payload.inlineHandlerNames ?? []);
  const handlers = buildStepHandlers(
    payload.flow,
    payload.flowDir,
    inlineHandlerNames,
    (payload.handlerVars ?? {}) as Record<string, unknown>,
  );

  if (payload.pauseFilePath) {
    hostCall<boolean>({ op: 'step.pause.clear', pauseFilePath: payload.pauseFilePath });
  }

  const abortController = createAbortControllerCompat();
  let pauseSignalSeen = false;

  const machine = createStepMachine(payload.flow, handlers, {
    store,
    signal: abortController.signal,
    onStep: () => {
      if (!payload.pauseFilePath || pauseSignalSeen) return;
      const requested = hostCall<boolean>({ op: 'step.pause.requested', pauseFilePath: payload.pauseFilePath });
      if (requested) {
        pauseSignalSeen = true;
        abortController.abort();
      }
    },
  });

  const result = payload.mode === 'resume'
    ? await machine.resume(String(payload.runId ?? ''))
    : await machine.run(payload.initialData);

  if (pauseSignalSeen && result.status === 'cancelled') {
    const state = await store.loadRunState(result.runId);
    if (state) {
      const pausedAt = Date.now();
      await store.saveRunState(result.runId, {
        ...state,
        status: 'paused',
        pausedAt,
        updatedAt: pausedAt,
      });
    }
    if (payload.pauseFilePath) {
      hostCall<boolean>({ op: 'step.pause.clear', pauseFilePath: payload.pauseFilePath });
    }
    const pausedState = await store.loadRunState(result.runId);
    return {
      status: 'paused',
      runId: result.runId,
      currentStep: pausedState?.currentStep,
      pausedAt: pausedState?.pausedAt,
      stepHistory: result.stepHistory,
      data: result.data,
    };
  }

  if (result.status !== 'completed') {
    const reason = result.error?.message ?? result.intent ?? result.status;
    return {
      status: 'failed',
      runId: result.runId,
      finalStep: result.finalStep,
      stepHistory: result.stepHistory,
      data: result.data,
      reason,
      error: reason,
    };
  }

  return {
    status: 'completed',
    runId: result.runId,
    intent: result.intent,
    finalStep: result.finalStep,
    stepHistory: result.stepHistory,
    data: result.data,
  };
}

globalThis.pycliStepMachineInvoke = invoke;
