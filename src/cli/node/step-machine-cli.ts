import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadStepFlow, createStepMachine, buildStepHandlersForFlow } from '../../step-machine-public/index.js';
import { MemoryStore, KVStorageStore } from '../../stores/index.js';
import { invokeRefSync } from './execution-adapter.js';
import { createFsKvStorage } from './storage-fs-adapters.js';
import type { StepMachineStore, StepMachineState } from '../../step-machine/types.js';
import { parseRef, serializeRef } from '../common/storage-interface.js';

export class CliExitError extends Error {
  constructor(public readonly code: number, message?: string) {
    super(message);
    this.name = 'CliExitError';
  }
}

const PAUSE_FILE_NAME = '.pause';

type StoreContext = {
  storeType: 'memory' | 'file';
  storeDir: string | undefined;
  pauseFilePath: string | undefined;
  persistRuntimeRef: string | undefined;
  store: StepMachineStore;
};

export async function cli(args: string[]): Promise<void> {
  const parsed = parseCliArgs(args);

  if (parsed.help || args.length === 0) {
    printUsage();
    throw new CliExitError(args.length === 0 ? 1 : 0);
  }

  const {
    flowArg,
    dataArg,
    persistRuntimeRefArg,
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

  const storeContext = createStoreContext(persistRuntimeRefArg);

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
      console.warn('[step-machine-cli] No paused run found in the persisted runtime store.');
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
    throw new CliExitError(1);
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

function parseCliArgs(args: string[]) {
  const valueFlags = new Set(['--initial-data', '--persist-runtime-ref']);
  const values: Record<string, string> = {};
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
    persistRuntimeRefArg: values['--persist-runtime-ref'],
    resumeRequested,
    pauseRequested,
    statusRequested,
  };
}

function resolveInputPath(inputPath: string): string {
  return path.isAbsolute(inputPath)
    ? inputPath
    : path.resolve(process.cwd(), inputPath);
}

function createStoreContext(persistRuntimeRefArg: string | undefined): StoreContext {
  if (!persistRuntimeRefArg) {
    return {
      storeType: 'memory',
      storeDir: undefined,
      pauseFilePath: undefined,
      persistRuntimeRef: undefined,
      store: new MemoryStore(),
    };
  }

  const parsedRef = parseRef(persistRuntimeRefArg);
  if (parsedRef.kind !== 'fs-path') {
    throw new Error(`[step-machine-cli] --persist-runtime-ref must be an fs-path ref. Received kind "${parsedRef.kind}".`);
  }

  const storeDir = resolveInputPath(parsedRef.value);
  const persistRuntimeRef = serializeRef({ kind: 'fs-path', value: storeDir });
  return {
    storeType: 'file',
    storeDir,
    pauseFilePath: path.join(storeDir, PAUSE_FILE_NAME),
    persistRuntimeRef,
    store: new KVStorageStore(createFsKvStorage(storeDir)),
  };
}

async function listRunStates(store: StepMachineStore): Promise<StepMachineState[]> {
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

function hasPauseRequest(storeContext: StoreContext): boolean {
  if (storeContext.storeType !== 'file' || !storeContext.pauseFilePath) {
    return false;
  }
  return fs.existsSync(storeContext.pauseFilePath);
}

function clearPauseRequest(storeContext: StoreContext): void {
  if (!hasPauseRequest(storeContext)) {
    return;
  }
  fs.unlinkSync(storeContext.pauseFilePath!);
}

async function requestPause(storeContext: StoreContext): Promise<void> {
  if (storeContext.storeType !== 'file' || !storeContext.pauseFilePath) {
    throw new Error('[step-machine-cli] --pause requires --persist-runtime-ref <ref>.');
  }

  const states = await listRunStates(storeContext.store);
  if (states.length === 0) {
    console.warn('[step-machine-cli] No runs found in the persisted runtime store. Pause is a no-op.');
    console.log(JSON.stringify({ status: 'noop', reason: 'no-runs' }, null, 2));
    return;
  }

  const running = states.find((s) => s.status === 'running');
  if (!running) {
    console.warn('[step-machine-cli] No running run found. Pause is a no-op.');
    console.log(JSON.stringify({ status: 'noop', reason: 'no-running-run' }, null, 2));
    return;
  }

  fs.mkdirSync(storeContext.storeDir!, { recursive: true });
  fs.writeFileSync(storeContext.pauseFilePath, JSON.stringify({ requestedAt: Date.now() }), 'utf-8');
  console.log(JSON.stringify({ status: 'pause-requested', persistRuntimeRef: storeContext.persistRuntimeRef }, null, 2));
}

async function resolveRunIdToResume(storeContext: StoreContext): Promise<string | undefined> {
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

async function markRunPaused(store: StepMachineStore, runId: string): Promise<StepMachineState | null> {
  const state = await store.loadRunState(runId);
  if (!state) {
    return null;
  }
  const pausedState: StepMachineState = {
    ...state,
    status: 'paused' as const,
    pausedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await store.saveRunState(runId, pausedState);
  return pausedState;
}

async function printStoreStatus(storeContext: StoreContext): Promise<void> {
  if (storeContext.storeType !== 'file') {
    throw new Error('[step-machine-cli] --status requires --persist-runtime-ref <ref>.');
  }

  const states = await listRunStates(storeContext.store);
  const summary = {
    store: 'file',
    persistRuntimeRef: storeContext.persistRuntimeRef,
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

function parseInitialData(dataArg: string | undefined): Record<string, unknown> | undefined {
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

function normalizeExecutionRef(ref: unknown): unknown {
  if (!ref || typeof ref !== 'object') return ref;
  const r = ref as Record<string, unknown>;
  if (typeof r['whatToRun'] !== 'string' || !(r['whatToRun'] as string).startsWith('b64:')) return ref;

  try {
    const payload = (r['whatToRun'] as string).slice(4);
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const json = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const decoded = JSON.parse(json);
    if (!decoded || typeof decoded !== 'object' || typeof decoded.value !== 'string') {
      return ref;
    }
    return { ...r, whatToRun: decoded };
  } catch {
    return ref;
  }
}

function buildStepHandlers(flow: unknown, flowDir: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoke = (ref: unknown, args: unknown) => invokeRefSync(normalizeExecutionRef(ref) as any, args as any, { cliDir: flowDir, cwd: flowDir });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return buildStepHandlersForFlow(flow as any, { invoke });
}

function printUsage() {
  console.error('Usage: step-machine-cli <step-flow.yaml> [--initial-data <json>] [--persist-runtime-ref <ref>] [--resume]');
  console.error('       step-machine-cli --persist-runtime-ref <ref> --pause');
  console.error('       step-machine-cli --persist-runtime-ref <ref> --status');
  console.error('');
  console.error('Example:');
  console.error('  step-machine-cli examples/cli/step-machine-demo/two-step-math.flow.yaml --initial-data "{\"a\":3,\"b\":4}"');
  console.error('  step-machine-cli ./flow.yaml --persist-runtime-ref <b64-fs-path-ref>');
  console.error('  step-machine-cli ./flow.yaml --persist-runtime-ref <b64-fs-path-ref> --resume');
  console.error('  step-machine-cli --persist-runtime-ref <b64-fs-path-ref> --pause');
  console.error('  step-machine-cli --persist-runtime-ref <b64-fs-path-ref> --status');
}


