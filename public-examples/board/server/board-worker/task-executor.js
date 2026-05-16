#!/usr/bin/env node

/**
 * task-executor.js — Registry-driven source executor for the demo board worker.
 *
 * Supported subcommands:
 *   run-source-fetch         — execute one source_def via its registered flow
 *   describe-capabilities    — emit registry-derived kinds, schemas, and probe info as JSON
 *   validate-source-def      — validate one source_def against registry rules from stdin
 *   probe-source-preflight   — perform a lightweight preflight for one source_def from stdin
 *
 * Runtime invocation shapes used by board-live-cards:
 *   run-source-fetch --in-ref <b64ref> --out-ref <b64ref> [--err-ref <b64ref>] [--extra <base64json>]
 *   validate-source-def       <stdin: source JSON>
 *   probe-source-preflight    <stdin: source JSON> [--extra <base64json>]
 *
 * Payload read from --in-ref (raw source definition or { source_def, callback } envelope):
 *   {
 *     "bindTo": "token_name",
 *     "outputFile": "relative/path.json",
 *     "_projections": { "refKey": <resolvedValue> },
 *     // ...plus the authored fields used by the resolved registry kind
 *   }
 *
 * Output written to --out-ref:
 *   - JSON result produced by the resolved source flow when the flow does not
 *     write directly to the destination blob itself.
 *
 * Error text written to --err-ref when provided:
 *   - Plain-text failure details for fetch-time errors before process exit.
 *
 * Decoded --extra context (optional; schema comes from source_def_flows.json.extraSchema):
 *   {
 *     "boardSetupRoot": "<abs path>",
 *     "boardId": "<board id>",
 *     "boardRuntimeDir": "<relative>",
 *     "runtimeStatusDir": "<relative>",
 *     "cardsDir": "<relative>",
 *     "serverUrl": "<base url>",
 *     "boardLiveCardsCliJs": "<abs path>",
 *     "stepMachineCliPath": "<abs path>"
 *   }
 *
 * Source kinds are resolved from source_def_flows.json in resolveOrder.
 * See that registry for the current set of advertised kinds and capabilities.
 * Flow execution is generic here; kind-specific behavior lives in the registry
 * and in per-kind flow/handler modules under source-def-flows/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseRef, blobStorageForRef, reportComplete, reportFailed } from 'yaml-flow/board-worker-adapter';
import { loadStepFlow, createStepMachine, MemoryStore, buildStepHandlersForFlow } from 'yaml-flow/step-machine-public';
import { invokeExecutionRef } from 'yaml-flow/board-live-cards-node';

const WORKER_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(WORKER_DIR, '..', '..');
const SOURCE_DEF_FLOWS_FILE = path.join(WORKER_DIR, 'source_def_flows.json');
const EXECUTOR_NAME = 'board-worker';
const LOG_PREFIX = `[${EXECUTOR_NAME}]`;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function fail(msg, errFile) {
  if (errFile) {
    try {
      fs.writeFileSync(errFile, msg);
    } catch {}
  }
  console.error(`${LOG_PREFIX} ${msg}`);
  process.exit(1);
}

function loadSourceDefFlowsConfig() {
  try {
    return readJson(SOURCE_DEF_FLOWS_FILE);
  } catch (err) {
    fail(
      `Cannot read source flow registry (${SOURCE_DEF_FLOWS_FILE}): ${String(err && err.message || err)}`,
    );
  }
}

function matchesDetectRule(sourceDef, detect) {
  if (!detect || typeof detect !== 'object') return false;
  if (typeof detect.field === 'string') {
    return sourceDef[detect.field] !== undefined;
  }
  if (Array.isArray(detect.anyOfFields)) {
    return detect.anyOfFields.some((field) => sourceDef[field] !== undefined);
  }
  return false;
}

function resolveSourceKind(sourceDef, registry) {
  const kinds = registry?.kinds && typeof registry.kinds === 'object' ? registry.kinds : {};
  const order = Array.isArray(registry?.resolveOrder) ? registry.resolveOrder : Object.keys(kinds);
  const matched = [];
  for (const kind of order) {
    const spec = kinds[kind];
    if (!spec) continue;
    if (matchesDetectRule(sourceDef, spec.detect)) {
      matched.push(kind);
    }
  }

  if (matched.length === 0) {
    const knownKinds = Object.keys(kinds);
    throw new Error(`No recognised source kind. Known kinds: ${knownKinds.join(', ')}`);
  }
  if (matched.length > 1) {
    throw new Error(`Multiple source kinds specified: [${matched.join(', ')}]. Use exactly one.`);
  }
  return matched[0];
}

async function executeStepMachineSourceFlow(context) {
  const { kind, registry } = context;
  const spec = registry?.kinds?.[kind];
  if (!spec) {
    throw new Error(`Missing flow registration for kind: ${kind}`);
  }

  const flowRef = spec.flow;
  if (typeof flowRef !== 'string' || flowRef.length === 0) {
    throw new Error(`Invalid or missing flow for kind: ${kind}`);
  }

  const flowPath = path.resolve(WORKER_DIR, flowRef);
  const flow = await loadStepFlow(flowPath);

  const invoke = async (ref, args) => {
    if (ref.howToRun === 'demo-local-module') {
      const whatValue = typeof ref.whatToRun === 'object' ? ref.whatToRun.value : parseRef(ref.whatToRun).value;
      const modulePath = path.resolve(WORKER_DIR, whatValue);
      const mod = await import(pathToFileURL(modulePath).href);
      if (typeof mod.execute !== 'function') {
        throw new Error(`Flow module ${JSON.stringify(ref.whatToRun)} must export execute(context)`);
      }
      return mod.execute(args);
    }
    return invokeExecutionRef(ref, args, { cliDir: PROJECT_ROOT, cwd: process.cwd() });
  };

  const handlers = buildStepHandlersForFlow(flow, { invoke });
  const machine = createStepMachine(flow, handlers, { store: new MemoryStore() });
  const run = await machine.run({
    ...context,
    extra: context.extra ?? {},
    serverUrl: context.extra?.serverUrl ?? null,
    executorDir: PROJECT_ROOT,
  });

  if (run.status !== 'completed') {
    const reason = run.error?.message ?? run.intent ?? run.status;
    throw new Error(`flow execution failed: ${reason}`);
  }

  if (run.intent !== 'success') {
    const reason = typeof run.data?.error === 'string' ? run.data.error : `flow returned intent: ${run.intent}`;
    throw new Error(reason);
  }

  return {
    resultValue: run.data?.resultValue,
    wroteOutputDirectly: !!run.data?.wroteOutputDirectly,
  };
}

async function resolveAndExecuteSourceFlow(sourceDef, extra, refs = {}) {
  const registry = loadSourceDefFlowsConfig();
  const kind = resolveSourceKind(sourceDef, registry);
  const mockDb = kind === 'mock'
    ? (await import(pathToFileURL(path.join(WORKER_DIR, 'source-def-flows', 'mock-handler', 'mock-db.js')).href)).MOCK_DB
    : undefined;
  const flowResult = await executeStepMachineSourceFlow({
    kind,
    registry,
    sourceDef,
    extra,
    inRef: refs.inRef,
    outRef: refs.outRef,
    errRef: refs.errRef,
    ...(mockDb ? { mockDb } : {}),
  });
  return { kind, flowResult };
}

async function runSourceFetchSubcommand(argv) {
  const inIdx = argv.indexOf('--in-ref');
  const outIdx = argv.indexOf('--out-ref');
  const errIdx = argv.indexOf('--err-ref');
  const extraIdx = argv.indexOf('--extra');
  const inRefStr  = inIdx  !== -1 ? argv[inIdx + 1]  : undefined;
  const outRefStr = outIdx !== -1 ? argv[outIdx + 1] : undefined;
  const errRefStr = errIdx !== -1 ? argv[errIdx + 1] : undefined;
  const extraB64  = extraIdx !== -1 ? argv[extraIdx + 1] : undefined;

  let extra = {};
  if (extraB64) {
    try { extra = JSON.parse(Buffer.from(extraB64, 'base64').toString('utf-8')); }
    catch { console.warn(`${LOG_PREFIX} bad --extra base64, ignoring`); }
  }

  if (!inRefStr || !outRefStr) {
    fail('Usage: run-source-fetch --in-ref <b64:<base64url(json)>> --out-ref <b64:<base64url(json)>> [--err-ref <b64:<base64url(json)>>]');
  }

  let inRef, outRef, errRef;
  try {
    inRef  = parseRef(inRefStr);
    outRef = parseRef(outRefStr);
    if (errRefStr) errRef = parseRef(errRefStr);
  } catch (e) {
    fail(`invalid ref argument: ${e.message}`);
  }

  const inStorage  = blobStorageForRef(inRef);
  const outStorage = blobStorageForRef(outRef);
  const errStorage = errRef ? blobStorageForRef(errRef) : undefined;

  // Local error reporter — writes to errStorage and calls back to board if callback present.
  const failRef = (msg, callback) => {
    if (errStorage && errRef) { try { errStorage.write(errRef.value, msg); } catch {} }
    console.error(`${LOG_PREFIX} ${msg}`);
    if (callback) { try { reportFailed(callback, msg); } catch {} }
    process.exit(1);
  };

  const rawIn = inStorage.read(inRef.value);
  if (rawIn === null) {
    failRef(`Input not found: ${inRefStr}`);
  }

  // Payload may be { source_def, callback } (new protocol) or raw source def (legacy).
  let envelope;
  try {
    envelope = JSON.parse(rawIn);
  } catch (err) {
    failRef(`Cannot parse input: ${String(err && err.message || err)}`);
  }

  const callback = envelope.source_def ? envelope.callback : undefined;
  let sourceDef;
  try {
    sourceDef = envelope.source_def ?? envelope;
  } catch (err) {
    failRef(`Cannot resolve source_def: ${String(err && err.message || err)}`, callback);
  }

  let kind;
  let flowResult;
  try {
    const resolved = await resolveAndExecuteSourceFlow(sourceDef, extra, { inRef, outRef, errRef });
    kind = resolved.kind;
    flowResult = resolved.flowResult;
  } catch (err) {
    const detail = (err && (err.stderr || err.stdout)) ? `\n${err.stderr || err.stdout}`.trimEnd() : '';
    failRef(`source invocation failed: ${String(err && err.message || err)}${detail}`, callback);
  }

  if (!flowResult?.wroteOutputDirectly) {
    try {
      outStorage.write(outRef.value, JSON.stringify(flowResult?.resultValue, null, 2));
    } catch (err) {
      failRef(`Cannot write output: ${String(err && err.message || err)}`, callback);
    }
  }

  if (callback) {
    try {
      reportComplete(callback, outRef);
    } catch (err) {
      console.error(`${LOG_PREFIX} reportComplete failed: ${String(err && err.message || err)}`);
      process.exit(1);
    }
  }

}

async function probeSourcePreflightSubcommand(argv) {
  const extraIdx = argv.indexOf('--extra');
  const extraB64 = extraIdx !== -1 ? argv[extraIdx + 1] : undefined;

  let extra = {};
  if (extraB64) {
    try { extra = JSON.parse(Buffer.from(extraB64, 'base64').toString('utf-8')); }
    catch { /* ignore malformed extra */ }
  }

  const startedAt = Date.now();
  try {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const raw = Buffer.concat(chunks).toString('utf-8').trim();
    if (!raw) {
      console.log(JSON.stringify({ ok: false, reachable: false, latencyMs: Date.now() - startedAt, error: 'Missing probe input JSON on stdin' }));
      return;
    }

    let sourceDef;
    try {
      sourceDef = JSON.parse(raw);
    } catch (err) {
      console.log(JSON.stringify({ ok: false, reachable: false, latencyMs: Date.now() - startedAt, error: `Invalid probe JSON: ${String(err && err.message || err)}` }));
      return;
    }

    const projections = sourceDef?._projections;
    const mockProjectionsMissing = !projections || typeof projections !== 'object' || Array.isArray(projections) || Object.keys(projections).length === 0;
    const mockProjectionWarning = mockProjectionsMissing
      ? 'Mock projections / _projections missing. Hence mock run not performed.'
      : undefined;

    const { flowResult } = await resolveAndExecuteSourceFlow(sourceDef, extra);
    console.log(JSON.stringify({
      ok: true,
      reachable: true,
      latencyMs: Date.now() - startedAt,
      ...(mockProjectionWarning ? { error: mockProjectionWarning } : {}),
      ...(!mockProjectionWarning ? { resultValue: flowResult?.resultValue } : {}),
    }));
    return;
  } catch (err) {
    const detail = (err && (err.stderr || err.stdout)) ? `\n${err.stderr || err.stdout}`.trimEnd() : '';
    console.log(JSON.stringify({ ok: false, reachable: false, latencyMs: Date.now() - startedAt, error: `source invocation failed: ${String(err && err.message || err)}${detail}` }));
    return;
  }
}

function getByPath(obj, dottedPath) {
  if (!dottedPath) return undefined;
  return String(dottedPath).split('.').reduce((acc, key) => {
    if (acc == null || typeof acc !== 'object') return undefined;
    return acc[key];
  }, obj);
}

function checkType(value, expectedType) {
  if (expectedType === 'array') return Array.isArray(value);
  if (expectedType === 'object') return value != null && typeof value === 'object' && !Array.isArray(value);
  return typeof value === expectedType;
}

function matchesValidateRule(sourceDef, rule) {
  if (!rule || typeof rule !== 'object') return true;

  if (Array.isArray(rule.anyOf)) {
    return rule.anyOf.some((entry) => matchesValidateRule(sourceDef, entry));
  }

  if (Array.isArray(rule.allOf)) {
    return rule.allOf.every((entry) => matchesValidateRule(sourceDef, entry));
  }

  if (rule.not && typeof rule.not === 'object') {
    return !matchesValidateRule(sourceDef, rule.not);
  }

  if (typeof rule.field === 'string' && typeof rule.type === 'string') {
    const value = getByPath(sourceDef, rule.field);
    return checkType(value, rule.type);
  }

  return true;
}

// ---------------------------------------------------------------------------
// validate-source-def — registry-driven validation of a source definition
// ---------------------------------------------------------------------------
function validateSourceDefSubcommand() {
  let rawInput = '';
  try {
    rawInput = fs.readFileSync(0, 'utf-8').trim();
  } catch (err) {
    console.log(JSON.stringify({ ok: false, errors: [`Cannot read stdin: ${err && err.message || err}`] }));
    process.exit(1);
  }

  if (!rawInput) {
    console.error(`${LOG_PREFIX} Usage: validate-source-def < source.json`);
    process.exit(1);
  }

  let sourceDef;
  try {
    sourceDef = JSON.parse(rawInput);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, errors: [`Cannot parse source JSON from stdin: ${err && err.message || err}`] }));
    process.exit(1);
  }

  const errors = [];
  const registry = loadSourceDefFlowsConfig();

  let kind = '';
  try {
    kind = resolveSourceKind(sourceDef, registry);
  } catch (err) {
    errors.push(String(err && err.message || err));
  }

  const kindSpec = registry?.kinds?.[kind];
  const validateRules = Array.isArray(kindSpec?.validate) ? kindSpec.validate : [];
  for (const rule of validateRules) {
    if (!rule || typeof rule !== 'object') continue;
    if (!matchesValidateRule(sourceDef, rule)) {
      if (typeof rule.field === 'string' && typeof rule.type === 'string') {
        errors.push(rule.message || `${rule.field} must be of type ${rule.type}.`);
      } else {
        errors.push(rule.message || 'Validation rule failed.');
      }
    }
  }

  const result = { ok: errors.length === 0, errors };
  console.log(JSON.stringify(result));
  process.exit(errors.length === 0 ? 0 : 1);
}

function describeCapabilities() {
  const registry = loadSourceDefFlowsConfig();
  const sourceKinds = Object.fromEntries(
    Object.entries(registry?.kinds || {}).map(([kind, spec]) => [
      kind,
      {
        ...(spec?.manifest && typeof spec.manifest === 'object' ? spec.manifest : {}),
        ...(spec?.probe && typeof spec.probe === 'object' ? { probe: spec.probe } : {}),
      },
    ]),
  );
  const payload = {
    version: registry?.version || '1.0',
    executor: registry?.executor || EXECUTOR_NAME,
    subcommands: Array.isArray(registry?.subcommands)
      ? registry.subcommands
      : ['run-source-fetch', 'probe-source-preflight', 'describe-capabilities', 'validate-source-def'],
    sourceKinds,
    ...(registry?.extraSchema ? { extraSchema: registry.extraSchema } : {}),
  };
  console.log(JSON.stringify(payload, null, 2));
}

async function main() {
  const sub = process.argv[2];
  if (sub === 'run-source-fetch') {
    await runSourceFetchSubcommand(process.argv.slice(3));
    return;
  }
  if (sub === 'probe-source-preflight') {
    await probeSourcePreflightSubcommand(process.argv.slice(3));
    return;
  }
  if (sub === 'describe' || sub === 'describe-capabilities') {
    describeCapabilities();
    return;
  }
  if (sub === 'validate-source-def') {
    validateSourceDefSubcommand();
    return;
  }

  console.warn(`${LOG_PREFIX} Unknown subcommand: ${sub}`);
  process.exit(0);
}

main().catch(err => {
  console.error(`${LOG_PREFIX} fatal: ${err && err.message || err}`);
  process.exit(1);
});
