#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'module';
const __require = createRequire(import.meta.url);
const jsonata = __require('./src/card-compute/jsonata-sync.cjs');

const { loadStepFlow, createStepMachine, MemoryStore, FileStore } = await import('./dist/index.js');
const PAUSE_FILE_NAME = '.pause';

async function main() {
  const args = process.argv.slice(2);
  const parsed = parseCliArgs(args);

  if (parsed.help || args.length === 0) {
    printUsage();
    process.exit(args.length === 0 ? 1 : 0);
  }

  const {
    flowArg,
    dataArg,
    storeArg,
    storeDirArg,
    resumeRequested,
    pauseRequested,
    statusRequested,
  } = parsed;

  if ((pauseRequested || statusRequested) && (dataArg || resumeRequested || flowArg)) {
    throw new Error('[step-machine-cli] --pause and --status are store-level operations. Do not provide flow, data, or --resume.');
  }

  if (resumeRequested && dataArg) {
    throw new Error('[step-machine-cli] --initial-data cannot be combined with --resume.');
  }

  const storeContext = createStoreContext(storeArg, storeDirArg);

  if (statusRequested) {
    await printStoreStatus(storeContext);
    return;
  }

  if (pauseRequested) {
    await requestPause(storeContext);
    return;
  }

  if (!flowArg) {
    throw new Error('[step-machine-cli] Flow path is required for run/resume operations.');
  }

  const flowPath = resolveInputPath(flowArg);
  const flowDir = path.dirname(flowPath);
  const initialData = parseInitialData(dataArg);
  const { store } = storeContext;

  const flow = await loadStepFlow(flowPath);
  const handlers = buildStepHandlers(flow, flowDir);

  // Resume/start should ignore stale pause markers from previous runs.
  clearPauseRequest(storeContext);

  const abortController = new AbortController();
  let pauseSignalSeen = false;

  const machine = createStepMachine(flow, handlers, {
    store,
    signal: abortController.signal,
    onStep: () => {
      if (!pauseSignalSeen && hasPauseRequest(storeContext)) {
        pauseSignalSeen = true;
        abortController.abort();
      }
    },
  });

  let runIdToResume;
  if (resumeRequested) {
    runIdToResume = await resolveRunIdToResume(storeContext);
    if (!runIdToResume) {
      console.warn('[step-machine-cli] No paused run found in store directory.');
      console.log(JSON.stringify({ status: 'noop', reason: 'no-paused-run' }, null, 2));
      return;
    }
  } else if (storeContext.storeType === 'file' && !initialData) {
    runIdToResume = await resolveRunIdToResume(storeContext);
  }

  const result = runIdToResume
    ? await machine.resume(runIdToResume)
    : await machine.run(initialData);

  if (pauseSignalSeen && result.status === 'cancelled') {
    const pausedState = await markRunPaused(store, result.runId);
    clearPauseRequest(storeContext);
    console.log(JSON.stringify({
      runId: result.runId,
      status: 'paused',
      currentStep: pausedState?.currentStep,
      pausedAt: pausedState?.pausedAt,
      stepHistory: result.stepHistory,
      data: result.data,
    }, null, 2));
    return;
  }

  if (result.status !== 'completed') {
    const reason = result.error?.message ?? result.intent ?? result.status;
    console.error(`[step-machine-cli] Run failed: ${reason}`);
    process.exit(1);
  }

  console.log(JSON.stringify({
    runId: result.runId,
    status: result.status,
    intent: result.intent,
    finalStep: result.finalStep,
    stepHistory: result.stepHistory,
    data: result.data,
  }, null, 2));
}

function parseCliArgs(args) {
  const valueFlags = new Set(['--initial-data', '--store', '--store-dir']);
  const values = {};
  const positionals = [];
  let help = false;
  let resumeRequested = false;
  let pauseRequested = false;
  let statusRequested = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      help = true;
      continue;
    }

    if (arg === '--resume') {
      resumeRequested = true;
      continue;
    }

    if (arg === '--pause') {
      pauseRequested = true;
      continue;
    }

    if (arg === '--status') {
      statusRequested = true;
      continue;
    }

    if (valueFlags.has(arg)) {
      const value = args[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`[step-machine-cli] Missing value for ${arg}.`);
      }
      values[arg] = value;
      i++;
      continue;
    }

    if (arg.startsWith('--')) {
      throw new Error(`[step-machine-cli] Unknown flag: ${arg}`);
    }

    positionals.push(arg);
  }

  if ([resumeRequested, pauseRequested, statusRequested].filter(Boolean).length > 1) {
    throw new Error('[step-machine-cli] Use only one of --resume, --pause, or --status at a time.');
  }

  return {
    help,
    flowArg: positionals[0],
    dataArg: values['--initial-data'],
    storeArg: String(values['--store'] ?? 'memory').toLowerCase(),
    storeDirArg: values['--store-dir'],
    resumeRequested,
    pauseRequested,
    statusRequested,
  };
}

function resolveInputPath(inputPath) {
  return path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(process.cwd(), inputPath);
}

function createStoreContext(storeType, storeDirArg) {
  if (storeType !== 'memory' && storeType !== 'file') {
    throw new Error(`[step-machine-cli] Invalid --store value "${storeType}". Expected "memory" or "file".`);
  }

  if (storeType === 'memory') {
    return {
      storeType,
      storeDir: undefined,
      pauseFilePath: undefined,
      store: new MemoryStore(),
    };
  }

  if (!storeDirArg || storeDirArg.trim().length === 0) {
    throw new Error('[step-machine-cli] --store file requires --store-dir <directory>.');
  }

  const storeDir = resolveInputPath(storeDirArg);
  return {
    storeType,
    storeDir,
    pauseFilePath: path.join(storeDir, PAUSE_FILE_NAME),
    store: new FileStore({ directory: storeDir }),
  };
}

async function listRunStates(store) {
  if (!store.listRuns) {
    return [];
  }

  const runIds = await store.listRuns();
  const states = [];
  for (const runId of runIds) {
    const state = await store.loadRunState(runId);
    if (state) {
      states.push(state);
    }
  }

  states.sort((a, b) => (b.updatedAt ?? b.startedAt ?? 0) - (a.updatedAt ?? a.startedAt ?? 0));
  return states;
}

function hasPauseRequest(storeContext) {
  if (storeContext.storeType !== 'file' || !storeContext.pauseFilePath) {
    return false;
  }
  return fs.existsSync(storeContext.pauseFilePath);
}

function clearPauseRequest(storeContext) {
  if (!hasPauseRequest(storeContext)) {
    return;
  }
  fs.unlinkSync(storeContext.pauseFilePath);
}

async function requestPause(storeContext) {
  if (storeContext.storeType !== 'file' || !storeContext.pauseFilePath) {
    throw new Error('[step-machine-cli] --pause requires --store file --store-dir <directory>.');
  }

  const states = await listRunStates(storeContext.store);
  if (states.length === 0) {
    console.warn('[step-machine-cli] No runs found in store directory. Pause is a no-op.');
    console.log(JSON.stringify({ status: 'noop', reason: 'no-runs' }, null, 2));
    return;
  }

  const running = states.find((s) => s.status === 'running');
  if (!running) {
    console.warn('[step-machine-cli] No running run found. Pause is a no-op.');
    console.log(JSON.stringify({ status: 'noop', reason: 'no-running-run' }, null, 2));
    return;
  }

  fs.mkdirSync(storeContext.storeDir, { recursive: true });
  fs.writeFileSync(storeContext.pauseFilePath, JSON.stringify({ requestedAt: Date.now() }), 'utf-8');
  console.log(JSON.stringify({ status: 'pause-requested', storeDir: storeContext.storeDir }, null, 2));
}

async function resolveRunIdToResume(storeContext) {
  const states = await listRunStates(storeContext.store);
  const pausedStates = states.filter((s) => s.status === 'paused');
  if (pausedStates.length === 0) {
    return undefined;
  }
  if (pausedStates.length > 1) {
    console.warn('[step-machine-cli] Multiple paused runs found; resuming the most recently updated run.');
  }
  return pausedStates[0].runId;
}

async function markRunPaused(store, runId) {
  const state = await store.loadRunState(runId);
  if (!state) {
    return null;
  }
  const pausedState = {
    ...state,
    status: 'paused',
    pausedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.saveRunState(runId, pausedState);
  return pausedState;
}

async function printStoreStatus(storeContext) {
  if (storeContext.storeType !== 'file') {
    throw new Error('[step-machine-cli] --status requires --store file --store-dir <directory>.');
  }

  const states = await listRunStates(storeContext.store);
  const summary = {
    store: 'file',
    storeDir: storeContext.storeDir,
    pauseRequested: hasPauseRequest(storeContext),
    totalRuns: states.length,
    runs: states.map((s) => ({
      runId: s.runId,
      status: s.status,
      currentStep: s.currentStep,
      startedAt: s.startedAt,
      updatedAt: s.updatedAt,
      pausedAt: s.pausedAt,
    })),
  };

  console.log(JSON.stringify(summary, null, 2));
}

function parseInitialData(dataArg) {
  if (!dataArg) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(dataArg);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Initial data must be a JSON object.');
    }
    return parsed;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`[step-machine-cli] Invalid --initial-data value: ${msg}`);
  }
}

function buildStepHandlers(flow, flowDir) {
  const handlers = {};

  for (const [stepName, stepConfig] of Object.entries(flow.steps ?? {})) {
    handlers[stepName] = resolveStepHandler(stepName, stepConfig, flowDir);
  }

  return handlers;
}

function resolveStepHandler(stepName, stepConfig, flowDir) {
  const produces = Array.isArray(stepConfig?.produces_data) ? stepConfig.produces_data : undefined;
  const inputValidations = Array.isArray(stepConfig?.input_validations) ? stepConfig.input_validations : undefined;
  const config = stepConfig?.config ?? undefined;
  const spec = stepConfig?.handler;

  if (isComputeJsonataSpec(spec)) {
    const base = createComputeJsonataHandler(spec, stepName, inputValidations, config);
    return wrapWithOutputFiltering(base, produces);
  }

  if (isRefSpec(spec)) {
    const base = createRefStepHandler(spec, flowDir, stepName, config);
    return wrapWithInputValidations(wrapWithOutputFiltering(base, produces), inputValidations, stepName);
  }

  // Default behavior is explicit and predictable: no configured handler means passthrough.
  return wrapWithInputValidations(wrapWithOutputFiltering(createPassthroughHandler(), produces), inputValidations, stepName);
}

function isComputeJsonataSpec(spec) {
  return !!spec && typeof spec === 'object' && spec.type === 'compute-jsonata' && Array.isArray(spec.expr) && spec.expr.length > 0;
}

function isRefSpec(spec) {
  return !!spec && typeof spec === 'object' && spec.type === 'ref' && typeof spec.howToRun === 'string' && typeof spec.whatToRun === 'string';
}

function normalizeComputeStep(item) {
  if (typeof item === 'string') {
    const eq = item.indexOf('=');
    if (eq < 1) throw new Error(`[step-machine-cli] Invalid compute expression (missing "="): "${item}"`);
    return { bindTo: item.slice(0, eq).trim(), expr: item.slice(eq + 1).trim() };
  }
  if (item && typeof item === 'object' && typeof item.bindTo === 'string' && typeof item.expr === 'string') {
    return item;
  }
  throw new Error(`[step-machine-cli] Invalid compute step: ${JSON.stringify(item)}`);
}

function runInputValidations(input, validations, stepName) {
  if (!validations || validations.length === 0) return null;
  for (const expr of validations) {
    try {
      const result = jsonata(expr).evaluate(input);
      if (!result) {
        return { result: 'failure', data: { error: `[${stepName}] input validation failed: ${expr}` } };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { result: 'failure', data: { error: `[${stepName}] input validation error on "${expr}": ${msg}` } };
    }
  }
  return null;
}

function wrapWithInputValidations(handler, validations, stepName) {
  if (!validations || validations.length === 0) return handler;
  return async (input, context) => {
    const failure = runInputValidations(input, validations, stepName);
    if (failure) return failure;
    return handler(input, context);
  };
}

function createComputeJsonataHandler(spec, stepName, inputValidations, config) {
  const steps = spec.expr.map(normalizeComputeStep);
  return async (input) => {
    const ctx = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
    if (config) ctx.config = config;

    // Run input validations
    const validationFailure = runInputValidations(ctx, inputValidations, stepName);
    if (validationFailure) return validationFailure;

    // Evaluate compute expressions sequentially
    const computed = {};
    for (const step of steps) {
      try {
        const evalCtx = { ...ctx, ...computed };
        const val = jsonata(step.expr).evaluate(evalCtx);
        computed[step.bindTo] = val;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          result: 'failure',
          data: { error: `[${stepName}] compute "${step.bindTo}" failed: ${msg}` },
        };
      }
    }

    return { result: 'success', data: computed };
  };
}

function parseKindRef(whatToRun) {
  const match = whatToRun.match(/^::([^:]+)::(.+)$/);
  if (!match) {
    throw new Error(`[step-machine-cli] Invalid whatToRun KindRef: "${whatToRun}". Expected ::kind::value format.`);
  }
  return { kind: match[1], value: match[2] };
}

function resolveRefCommand(spec, flowDir) {
  const { kind, value } = parseKindRef(spec.whatToRun);
  const howToRun = spec.howToRun;

  if (kind === 'fs-path') {
    const scriptPath = path.isAbsolute(value) ? value : path.resolve(flowDir, value);
    switch (howToRun) {
      case 'local-node': return { cmd: process.execPath, args: [scriptPath], cwd: flowDir };
      case 'local-python': return { cmd: 'python', args: [scriptPath], cwd: flowDir };
      case 'local-process': return { cmd: scriptPath, args: [], cwd: flowDir };
      default: throw new Error(`[step-machine-cli] Unsupported howToRun "${howToRun}" for fs-path ref.`);
    }
  }

  throw new Error(`[step-machine-cli] Unsupported whatToRun kind "${kind}". Only fs-path is supported for local execution.`);
}

function evaluateExprArray(exprArray, source, stepName, label) {
  if (!exprArray || !Array.isArray(exprArray) || exprArray.length === 0) {
    return null;
  }

  const result = {};
  for (const item of exprArray) {
    const { bindTo, expr } = normalizeComputeStep(item);
    try {
      result[bindTo] = jsonata(expr).evaluate(source);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[step-machine-cli] Step "${stepName}" ${label} "${bindTo}" failed: ${msg}`);
    }
  }
  return result;
}

function createRefStepHandler(spec, flowDir, stepName, config) {
  return async (input) => {
    const stepInput = input && typeof input === 'object' && !Array.isArray(input)
      ? input
      : {};

    const inputCtx = config ? { ...stepInput, config } : { ...stepInput };

    // Evaluate input-transforms to build what the ref receives
    const transformed = evaluateExprArray(spec['input-transforms'], inputCtx, stepName, 'input-transforms');
    const payload = transformed ?? inputCtx;

    const { cmd, args, cwd } = resolveRefCommand(spec, flowDir);

    const result = spawnSync(cmd, args, {
      cwd,
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      windowsHide: true,
    });

    if (result.error) {
      return {
        result: 'failure',
        data: { error: `[step-machine-cli] step "${stepName}" ref failed to start: ${result.error.message}` },
      };
    }

    const stdout = result.stdout ?? '';
    const stderr = (result.stderr ?? '').trim();

    if (result.status !== 0) {
      return {
        result: 'failure',
        data: {
          error: `[step-machine-cli] step "${stepName}" ref exited with status ${result.status}${stderr ? `: ${stderr}` : ''}`,
        },
      };
    }

    try {
      const parsed = parseJsonOutput(stdout);
      const normalized = normalizeHandlerResult(parsed, stepName);

      // Evaluate output-transforms against context that includes both spread data and nested data
      const outputCtx = { ...normalized.data, data: normalized.data, result: normalized.result };
      const outputTransformed = evaluateExprArray(spec['output-transforms'], outputCtx, stepName, 'output-transforms');

      return {
        result: normalized.result,
        data: outputTransformed ?? normalized.data,
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        result: 'failure',
        data: {
          error: `[step-machine-cli] step "${stepName}" ref returned invalid JSON on stdout: ${msg}`,
        },
      };
    }
  };
}

function createPassthroughHandler() {
  return async (input) => {
    const data = input && typeof input === 'object' && !Array.isArray(input)
      ? input
      : {};

    return {
      result: 'success',
      data,
    };
  };
}

function parseJsonOutput(stdout) {
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

function wrapWithOutputFiltering(handler, produces) {
  return async (input, context) => {
    const raw = await handler(input, context);
    const normalized = normalizeHandlerResult(raw, context?.stepName ?? 'unknown');
    const filteredData = filterProducedData(normalized.data, produces);
    return {
      result: normalized.result,
      data: filteredData,
    };
  };
}

function normalizeHandlerResult(raw, stepName) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`[step-machine-cli] Step "${stepName}" returned a non-object result.`);
  }

  const result = raw.result ?? raw.status;
  if (typeof result !== 'string' || result.trim().length === 0) {
    throw new Error(`[step-machine-cli] Step "${stepName}" result must include a non-empty "result" (or "status") string.`);
  }

  const data = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)
    ? raw.data
    : {};

  const error = typeof raw.error === 'string' ? raw.error : undefined;
  if (error && !('error' in data)) {
    data.error = error;
  }

  return { result, data };
}

function filterProducedData(data, produces) {
  if (!produces || produces.length === 0) {
    return data;
  }

  const filtered = {};
  for (const key of produces) {
    if (Object.prototype.hasOwnProperty.call(data, key)) {
      filtered[key] = data[key];
    }
  }
  return filtered;
}

function printUsage() {
  console.error('Usage: step-machine-cli <step-flow.yaml> [--initial-data <json>] [--store <memory|file>] [--store-dir <directory>] [--resume]');
  console.error('       step-machine-cli --store file --store-dir <directory> --pause');
  console.error('       step-machine-cli --store file --store-dir <directory> --status');
  console.error('');
  console.error('Example:');
  console.error('  step-machine-cli examples/cli/step-machine-demo/two-step-math.flow.yaml --initial-data "{\"a\":3,\"b\":4}"');
  console.error('  step-machine-cli ./flow.yaml --store file --store-dir ./.runs');
  console.error('  step-machine-cli ./flow.yaml --store file --store-dir ./.runs --resume');
  console.error('  step-machine-cli --store file --store-dir ./.runs --pause');
  console.error('  step-machine-cli --store file --store-dir ./.runs --status');
}

main().catch((error) => {
  const msg = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(msg);
  process.exit(1);
});
