#!/usr/bin/env node

// @ts-nocheck
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const srcCli = path.join(__dirname, '..', '..', '..', 'src', 'cli', 'node', 'step-machine-cli.ts');
const tsxCli = path.join(__dirname, '..', '..', '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

if (fs.existsSync(srcCli)) {
  const result = spawnSync(process.execPath, [tsxCli, srcCli, ...process.argv.slice(2)], {
    stdio: 'inherit',
    shell: false,
    windowsHide: true,
  });

  if (result.error) {
    console.error(`[step-machine-cli] Failed to launch dev fallback: ${result.error.message}`);
    process.exit(1);
  }

  process.exit(result.status ?? 0);
}

const libIndexPath = path.join(__dirname, '..', '..', 'lib', 'index.js');
const stepPublicPath = path.join(__dirname, '..', '..', 'lib', 'step-machine-public', 'index.js');
const executionAdapterPath = path.join(__dirname, 'execution-adapter.js');

const { loadStepFlow, createStepMachine, MemoryStore, FileStore } = await import(pathToFileUrl(libIndexPath).href);
const { buildStepHandlersForFlow } = await import(pathToFileUrl(stepPublicPath).href);
const { invokeRefSync } = await import(pathToFileUrl(executionAdapterPath).href);
const PAUSE_FILE_NAME = '.pause';

function pathToFileUrl(filePath) {
  const resolved = path.resolve(filePath).replace(/\\/g, '/');
  return new URL(`file:///${resolved.startsWith('/') ? resolved.slice(1) : resolved}`);
}

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

function normalizeExecutionRef(ref) {
  if (!ref || typeof ref !== 'object') return ref;
  if (typeof ref.whatToRun !== 'string' || !ref.whatToRun.startsWith('b64:')) return ref;

  try {
    const payload = ref.whatToRun.slice(4);
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const decoded = JSON.parse(json);
    if (!decoded || typeof decoded !== 'object' || typeof decoded.value !== 'string') {
      return ref;
    }
    return { ...ref, whatToRun: decoded };
  } catch {
    return ref;
  }
}

function buildStepHandlers(flow, flowDir) {
  const invoke = (ref, args) => invokeRefSync(normalizeExecutionRef(ref), args, { cliDir: flowDir, cwd: flowDir });
  return buildStepHandlersForFlow(flow, { invoke });
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
