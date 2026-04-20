#!/usr/bin/env node

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import jsonata from 'jsonata';

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
    handlersArg,
    dataArg,
    storeArg,
    storeDirArg,
    resumeRequested,
    pauseRequested,
    statusRequested,
  } = parsed;

  if ((pauseRequested || statusRequested) && (handlersArg || dataArg || resumeRequested || flowArg)) {
    throw new Error('[step-machine-cli] --pause and --status are store-level operations. Do not provide flow, handlers, data, or --resume.');
  }

  if (resumeRequested && dataArg) {
    throw new Error('[step-machine-cli] --data cannot be combined with --resume.');
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
  const handlersPath = handlersArg ? resolveInputPath(handlersArg) : undefined;
  const initialData = parseInitialData(dataArg);
  const { store } = storeContext;

  const flow = await loadStepFlow(flowPath);
  const inlineHandlers = handlersPath ? await loadHandlers(handlersPath) : {};
  const handlers = buildStepHandlers(flow, inlineHandlers, flowDir, flow.handler_vars);

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
  const valueFlags = new Set(['--handlers', '--data', '--store', '--store-dir']);
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
    handlersArg: values['--handlers'],
    dataArg: values['--data'],
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
    throw new Error(`[step-machine-cli] Invalid --data value: ${msg}`);
  }
}

async function loadHandlers(handlersPath) {
  const mod = await import(pathToFileURL(handlersPath).href);
  const candidate = mod.default ?? mod.handlers ?? mod;

  if (!candidate || typeof candidate !== 'object') {
    throw new Error('[step-machine-cli] Handlers module must export an object map of stepName -> function.');
  }

  for (const [stepName, handler] of Object.entries(candidate)) {
    if (typeof handler !== 'function') {
      throw new Error(`[step-machine-cli] Handler for step "${stepName}" is not a function.`);
    }
  }

  return candidate;
}

function buildStepHandlers(flow, inlineHandlers, flowDir, handlerVars) {
  const handlers = {};

  for (const [stepName, stepConfig] of Object.entries(flow.steps ?? {})) {
    handlers[stepName] = resolveStepHandler(stepName, stepConfig, inlineHandlers, flowDir, handlerVars);
  }

  return handlers;
}

function resolveStepHandler(stepName, stepConfig, inlineHandlers, flowDir, handlerVars) {
  const produces = Array.isArray(stepConfig?.produces_data) ? stepConfig.produces_data : undefined;
  const spec = stepConfig?.handler;

  if (isCliSpec(spec)) {
    const base = createCliStepHandler(spec, flowDir, stepName, handlerVars);
    return wrapWithOutputFiltering(base, produces);
  }

  if (isInlineSpec(spec)) {
    const inlineName = spec.inline;
    const handler = inlineHandlers[inlineName];
    if (typeof handler !== 'function') {
      throw new Error(`[step-machine-cli] Inline handler "${inlineName}" for step "${stepName}" was not found in --handlers module.`);
    }
    return wrapWithOutputFiltering(handler, produces);
  }

  // Default behavior is explicit and predictable: no configured handler means passthrough.
  return wrapWithOutputFiltering(createPassthroughHandler(), produces);
}

function isCliSpec(spec) {
  return !!spec && typeof spec === 'object' && typeof spec.cli === 'string' && spec.cli.trim().length > 0;
}

function isInlineSpec(spec) {
  return !!spec && typeof spec === 'object' && typeof spec.inline === 'string' && spec.inline.trim().length > 0;
}

function createCliStepHandler(spec, flowDir, stepName, handlerVars) {
  return async (input) => {
    const stepInput = input && typeof input === 'object' && !Array.isArray(input)
      ? input
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

    const payload = JSON.stringify(effectiveInput);
    const result = spawnSync(command, {
      cwd: flowDir,
      shell: true,
      input: payload,
      encoding: 'utf-8',
      windowsHide: true,
    });

    if (result.error) {
      return {
        result: 'failure',
        data: { error: `[step-machine-cli] step "${stepName}" failed to start: ${result.error.message}` },
      };
    }

    const stdout = result.stdout ?? '';
    const stderr = (result.stderr ?? '').trim();
    const resultMode = String(spec['result-mode'] ?? 'json').toLowerCase();

    if (result.status !== 0) {
      return {
        result: 'failure',
        data: {
          error: `[step-machine-cli] step "${stepName}" exited with status ${result.status}${stderr ? `: ${stderr}` : ''}`,
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
          error: `[step-machine-cli] step "${stepName}" returned invalid JSON on stdout: ${msg}`,
        },
      };
    }
  };
}

async function evaluateTransforms(transformSpec, source, stepName, label) {
  if (transformSpec === undefined || transformSpec === null) {
    return {};
  }

  if (!transformSpec || typeof transformSpec !== 'object' || Array.isArray(transformSpec)) {
    throw new Error(`[step-machine-cli] Step "${stepName}" ${label} must be an object map of key -> JSONata expression.`);
  }

  const result = {};
  for (const [key, expression] of Object.entries(transformSpec)) {
    if (typeof expression !== 'string') {
      // Non-string values are treated as literals for convenience.
      result[key] = expression;
      continue;
    }

    if (expression.trim().length === 0) {
      throw new Error(`[step-machine-cli] Step "${stepName}" ${label}.${key} must be a non-empty string expression.`);
    }

    // handler_vars defaults to literal strings for ergonomics; use "=..." for JSONata expressions.
    if (label === 'handler_vars' && !expression.startsWith('=')) {
      result[key] = expression;
      continue;
    }

    const jsonataExpression = label === 'handler_vars' && expression.startsWith('=')
      ? expression.slice(1)
      : expression;

    // Convenience: direct key aliasing supports non-identifier keys like BOARD-DIR-NAME.
    if (Object.prototype.hasOwnProperty.call(source, jsonataExpression)) {
      result[key] = source[jsonataExpression];
      continue;
    }

    try {
      const compiled = jsonata(jsonataExpression);
      result[key] = await compiled.evaluate(source);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`[step-machine-cli] Step "${stepName}" ${label}.${key} failed: ${msg}`);
    }
  }

  return result;
}

function applyCommandTemplate(command, source, stepName) {
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new Error(`[step-machine-cli] Step "${stepName}" handler.cli must be a non-empty command string.`);
  }

  return command.replace(/%%([A-Za-z0-9_-]+)%%/g, (full, key) => {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      throw new Error(`[step-machine-cli] Step "${stepName}" command placeholder ${full} has no matching input or input-transform value.`);
    }

    const value = source[key];
    if (value === undefined || value === null) {
      throw new Error(`[step-machine-cli] Step "${stepName}" command placeholder ${full} resolved to empty value.`);
    }

    return String(value);
  });
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
  console.error('Usage: step-machine-cli <step-flow.yaml> [--handlers <step-handlers.js>] [--data <json>] [--store <memory|file>] [--store-dir <directory>] [--resume]');
  console.error('       step-machine-cli --store file --store-dir <directory> --pause');
  console.error('       step-machine-cli --store file --store-dir <directory> --status');
  console.error('');
  console.error('Example:');
  console.error('  step-machine-cli examples/step-machine-demo/two-step-mixed.flow.yaml --handlers examples/step-machine-demo/two-step-mixed-handlers.js --data "{\"a\":3,\"b\":4}"');
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
