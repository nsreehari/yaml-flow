#!/usr/bin/env node

/**
 * demo-task-executor.js — Simple mock source executor for example-board.
 *
 * Subcommands:
 *   run-source-fetch        — fetch data for one source entry
 *   describe-capabilities   — print supported source kinds + schemas to stdout (JSON)
 *
 * CLI args:
 *   --in    <source.json>   Required. Path to a temp JSON file containing the source definition.
 *   --out   <result.json>   Required. Path where this executor must write its JSON result.
 *   --err   <error.txt>     Optional. Path where this executor writes an error message on failure.
 *   --extra <base64json>    Optional. Base64-encoded JSON with board topology context
 *                           (baked into .task-executor at board init time, passed blindly by the CLI).
 *
 * --in payload (source definition):
 *   {
 *     "bindTo":  "token_name",
 *     "outputFile": "relative/path.json",
 *     "cwd":     "<card directory>",           // injected by CLI
 *     "boardDir":"<board runtime directory>",   // injected by CLI
 *     "_projections":   { "refKey": <resolvedValue> }, // named projections from card_data/requires,
 *                                               // declared in source_defs[].projections and resolved
 *                                               // by the engine before invoking the executor
 *     // ...plus any custom fields authored on the source entry (bindTo, outputFile, projections, etc.)
 *   }
 *
 * --extra (decoded):
 *   {
 *     "boardSetupRoot":   "<abs path>",        // board root (parent of runtime/, surface/, runtime-out/)
 *     "boardId":          "<board id>",        // e.g. "default"
 *     "boardRuntimeDir":  "<relative>",        // e.g. "runtime"
 *     "runtimeStatusDir": "<relative>",        // e.g. "runtime-out"
 *     "cardsDir":         "<relative>",        // e.g. "surface/tmp-cards"
 *     "serverUrl":        "<base url>",        // optional; e.g. "http://127.0.0.1:7799"
 *     "boardLiveCardsCliJs":"<abs path>",      // optional; path to board-live-cards-cli.js
 *     "stepMachineCliPath":"<abs path>"        // optional; path to step-machine-cli.js
 *   }
 *
 * Supported source kinds (based on custom fields in --in):
 *   - { mock: "key" }              → look up key in MOCK_DB (hardcoded below)
 *   - { copilot: { prompt_template, args? } }  → call Copilot CLI with interpolated prompt
 *   - { prompt_template: "..." }   → shorthand copilot call (top-level template)
 *   - { workiq: { query_template, args? } }   → call WorkIQ (M365 Copilot) with interpolated query
 *   - { "url": { url, method?, headers?, args?, cacheTimeout? }, tickersFrom? }
 *       → single URL fetch via curl with {{key}} interpolation from _projections
 *   - { "url-list": { method?, headers?, cacheTimeout? } }
 *       → fan-out over _projections.url_list (string[]); returns array of responses.
 *         Build url_list in projections: e.g. `requires.holdings.ticker.('https://host/' & $ & '?q=1')`
 *     Prefer url-list for multi-URL fan-out sources.
 *   A real executor can also handle: graphapi, teams, mail, incidentdb, script, etc.
 *
 * url / url-list notes:
 *   - Results cached in os.tmpdir()/demo-executor-cache/ per URL (default 1 hour, override via cacheTimeout)
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseRef, blobStorageForRef, reportComplete, reportFailed } from 'yaml-flow/board-worker-adapter';
import { loadStepFlow, createStepMachine } from '../../lib/step-machine/index.js';
import { MemoryStore } from '../../lib/stores/memory.js';
import { buildStepHandlersForFlow } from '../../lib/step-machine-public/index.js';
import { invokeRefSync } from '../../cli/node/execution-adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DEF_FLOWS_FILE = path.join(__dirname, 'source_def_flows.json');

// ---------------------------------------------------------------------------
// Mock data — used when a source has { mock: "key" }.
// Edit these values to change the demo data without needing a mock.db file.
// ---------------------------------------------------------------------------
const MOCK_DB = {
  quotes: {
    quoteResponse: {
      result: [
        { symbol: 'AAPL',  shortName: 'Apple Inc.',      regularMarketPrice: 198.15, regularMarketChange:  2.15, regularMarketChangePercent:  1.10 },
        { symbol: 'MSFT',  shortName: 'Microsoft Corp.', regularMarketPrice: 415.32, regularMarketChange: -1.23, regularMarketChangePercent: -0.30 },
        { symbol: 'GOOGL', shortName: 'Alphabet Inc.',   regularMarketPrice: 174.89, regularMarketChange:  0.89, regularMarketChangePercent:  0.51 },
        { symbol: 'TSLA',  shortName: 'Tesla Inc.',      regularMarketPrice: 247.12, regularMarketChange:  5.43, regularMarketChangePercent:  2.25 },
      ],
      error: null,
    },
  },
};

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function interpolatePrompt(template, args) {
  return String(template).replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
    const v = args?.[key];
    if (v === undefined) return '';
    if (typeof v === 'string') return v;
    return JSON.stringify(v);
  });
}

// Reusable prompt fragments available to all copilot source templates.
// Source definitions can interpolate them with {{view_kind_guidance}} and {{card_layout_guidance}}.
const COPILOT_PROMPT_CONTEXT = {
  view_kind_guidance: [
    'VIEW KIND GUIDANCE (for dynamic ref rendering):',
    '- Return a _view object whenever your output data is meant for a ref element.',
    '- Allowed _view.kind values only: table, editable-table, chart, metric, list, badge, text, narrative, markdown, form, filter, todo, alert.',
    '- If uncertain, use "table".',
    '- For array rows that users should edit, prefer "editable-table" and set _view.data.writeTo to a card_data path.',
    '- For chart, set _view.data.chartType and _view.data.columns with [labelField, valueField].',
    '- Keep _view.data minimal and valid JSON (no comments, no trailing text).',
  ].join('\n'),
  card_layout_guidance: [
    'CARD LAYOUT GUIDANCE:',
    '- Prefer compact outputs that fit a card: one primary structure plus concise rationale text.',
    '- Avoid repeating values already present in upstream inputs.',
    '- If you produce both machine-readable and human-readable content, keep machine-readable fields top-level and concise prose in a separate field.',
  ].join('\n'),
};

function resolveCopilotPrompt(sourceDef) {
  const cfg = sourceDef?.copilot && typeof sourceDef.copilot === 'object' ? sourceDef.copilot : {};
  const template = cfg.prompt_template ?? sourceDef.prompt_template;
  const args = cfg.args ?? cfg.prompt_args ?? sourceDef.prompt_args ?? sourceDef.args ?? {};
  
  // Merge _projections into template interpolation context.
  // _projections contains the named data projections declared in source_defs[].projections,
  // evaluated by the engine from card_data/requires before invoking this executor.
  // Explicit args defined on the source take highest precedence.
  const interpolationContext = {
    ...COPILOT_PROMPT_CONTEXT,
    ...sourceDef._projections,
    ...args,
  };
  
  if (!template || typeof template !== 'string') return null;
  return interpolatePrompt(template, interpolationContext);
}

/**
 * Run a copilot prompt via copilot_wrapper.bat (Windows only).
 *
 * The wrapper handles:
 *   - Session management (--resume UUID for multi-turn continuity)
 *   - Noise/footer stripping (via copilot_wrapper_helper.ps1)
 *   - JSON mode extraction with optional result_shape key matching
 *   - Agentic retry: if the first response isn't valid JSON, the wrapper calls
 *     copilot again in the same session with a correction prompt, then re-extracts.
 *
 * @param {string} prompt         - interpolated prompt string
 * @param {object} sourceDef      - source definition (may contain copilot.result_shape)
 * @param {string} wrapperOutFile - path the wrapper writes its JSON output to
 * @param {string} sessionDir     - persistent dir for session UUID (enables --resume)
 * @param {string} cwd            - working directory for copilot (boardSetupRoot)
 * @returns {unknown} parsed JSON result value
 */
function runCopilotViaWrapper(prompt, sourceDef, wrapperOutFile, sessionDir, cwd) {
  const wrapperPath = path.join(__dirname, 'scripts', 'copilot_wrapper.bat');

  const promptFile = wrapperOutFile + '.prompt.txt';
  fs.writeFileSync(promptFile, prompt, 'utf-8');

  // Optional result_shape_file: top-level keys the response JSON must contain.
  // Sourced from sourceDef.copilot.result_shape or sourceDef.result_shape.
  let shapeFile = '';
  const shape = sourceDef?.copilot?.result_shape ?? sourceDef?.result_shape;
  if (shape && typeof shape === 'object') {
    shapeFile = wrapperOutFile + '.shape.json';
    fs.writeFileSync(shapeFile, JSON.stringify(shape), 'utf-8');
  }

  fs.mkdirSync(sessionDir, { recursive: true });

  try {
    execFileSync('cmd.exe', [
      '/d', '/c',
      wrapperPath,
      wrapperOutFile,                    // OUTPUT_FILE
      sessionDir,                        // SESSION_DIR
      cwd || process.cwd(),             // WORKING_DIR
      '@' + promptFile,                 // REQUEST_OR_FILE (@ prefix = file path)
      'json',                           // RESULT_TYPE — wrapper extracts JSON + retries
      sourceDef.bindTo || 'executor',   // AGENT_NAME (for log file naming)
      '',                               // MODEL (empty = wrapper default)
      shapeFile,                        // RESULT_SHAPE_FILE (empty = accept any JSON)
    ], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
  } finally {
    try { fs.unlinkSync(promptFile); } catch {}
    if (shapeFile) { try { fs.unlinkSync(shapeFile); } catch {} }
  }

  return JSON.parse(fs.readFileSync(wrapperOutFile, 'utf-8').replace(/^\uFEFF/, ''));
}

function fail(msg, errFile) {
  if (errFile) {
    try {
      fs.writeFileSync(errFile, msg);
    } catch {}
  }
  console.error(`[demo-task-executor] ${msg}`);
  process.exit(1);
}

function loadSourceDefFlowsConfig() {
  try {
    return readJson(SOURCE_DEF_FLOWS_FILE);
  } catch (err) {
    fail(`Cannot read source flow registry at ${SOURCE_DEF_FLOWS_FILE}: ${String(err && err.message || err)}`);
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

  const flowPath = path.resolve(__dirname, flowRef);
  const flow = await loadStepFlow(flowPath);

  const invokeHttpRef = async (ref, args) => {
    const rawUrl = typeof ref.whatToRun === 'object' ? ref.whatToRun.value : parseRef(ref.whatToRun).value;

    const base = String(args?.extra?.serverUrl || 'http://127.0.0.1:7799').replace(/\/$/, '');
    const resolvedUrl = /^https?:\/\//i.test(rawUrl)
      ? rawUrl
      : `${base}${rawUrl.startsWith('/') ? '' : '/'}${rawUrl}`;

    let body = args;
    const workiqCfg = args?.sourceDef?.workiq;
    if (workiqCfg && typeof workiqCfg === 'object' && typeof workiqCfg.query_template === 'string') {
      const interpolationContext = {
        ...(args?.sourceDef?._projections || {}),
        ...(workiqCfg.args || {}),
      };
      body = {
        query: interpolatePrompt(workiqCfg.query_template, interpolationContext),
      };
    }

    const method = ref.howToRun === 'http:get' ? 'GET' : 'POST';
    const response = await fetch(resolvedUrl, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
    });

    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { response: text };
    }

    if (!response.ok) {
      const msg = typeof parsed?.error === 'string' ? parsed.error : `HTTP ${response.status}`;
      return { result: 'failure', data: { error: msg }, error: msg };
    }

    if (typeof parsed?.error === 'string') {
      return { result: 'failure', data: { error: parsed.error }, error: parsed.error };
    }

    return {
      result: 'success',
      data: {
        resultValue: Object.prototype.hasOwnProperty.call(parsed, 'response') ? parsed.response : parsed,
      },
    };
  };

  const invoke = async (ref, args) => {
    if (ref.howToRun === 'http:post' || ref.howToRun === 'http:get') {
      return invokeHttpRef(ref, args);
    }
    if (ref.howToRun === 'demo-local-module') {
      const whatValue = typeof ref.whatToRun === 'object' ? ref.whatToRun.value : parseRef(ref.whatToRun).value;
      const modulePath = path.resolve(__dirname, whatValue);
      const mod = await import(pathToFileURL(modulePath).href);
      if (typeof mod.execute !== 'function') {
        throw new Error(`Flow module ${JSON.stringify(ref.whatToRun)} must export execute(context)`);
      }
      return mod.execute(args);
    }
    return invokeRefSync(ref, args, { cliDir: __dirname, cwd: process.cwd() });
  };

  const handlers = buildStepHandlersForFlow(flow, { invoke });
  const machine = createStepMachine(flow, handlers, { store: new MemoryStore() });
  const run = await machine.run({
    ...context,
    promptContext: COPILOT_PROMPT_CONTEXT,
    executorDir: __dirname,
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
    catch { console.warn('[demo-task-executor] bad --extra base64, ignoring'); }
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
    console.error(`[demo-task-executor] ${msg}`);
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

  const registry = loadSourceDefFlowsConfig();
  let kind;
  try {
    kind = resolveSourceKind(sourceDef, registry);
  } catch (err) {
    failRef(String(err && err.message || err), callback);
  }

  let flowResult;
  try {
    flowResult = await executeStepMachineSourceFlow({
      kind,
      registry,
      sourceDef,
      extra,
      inRef,
      outRef,
      errRef,
      mockDb: MOCK_DB,
    });
  } catch (err) {
    const detail = (err && (err.stderr || err.stdout)) ? `\n${err.stderr || err.stdout}`.trimEnd() : '';
    failRef(`${kind} invocation failed: ${String(err && err.message || err)}${detail}`, callback);
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
      console.error(`[demo-task-executor] reportComplete failed: ${String(err && err.message || err)}`);
      process.exit(1);
    }
  }

}

// ---------------------------------------------------------------------------
// validate-source-def — structural validation of a source definition
// ---------------------------------------------------------------------------
function validateSourceDefSubcommand(argv) {
  const inIdx = argv.indexOf('--in');
  const inFile = inIdx !== -1 ? argv[inIdx + 1] : undefined;

  if (!inFile) {
    console.error('[demo-task-executor] Usage: validate-source-def --in <source.json>');
    process.exit(1);
  }

  if (!fs.existsSync(inFile)) {
    console.log(JSON.stringify({ ok: false, errors: [`Input file not found: ${inFile}`] }));
    process.exit(1);
  }

  let sourceDef;
  try {
    sourceDef = readJson(inFile);
  } catch (err) {
    console.log(JSON.stringify({ ok: false, errors: [`Cannot parse source file: ${err && err.message || err}`] }));
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

  // Data-driven validation: rules come from source_def_flows.json "validate" array
  if (kind) {
    const spec = registry.kinds?.[kind];
    const rules = Array.isArray(spec?.validate) ? spec.validate : [];
    for (const rule of rules) {
      if (rule.condition === 'copilot-or-prompt') {
        // Special condition: copilot object OR top-level prompt_template string
        const hasCopilotObj = typeof sourceDef.copilot === 'object';
        const hasTopLevelTemplate = typeof sourceDef.prompt_template === 'string';
        const hasNestedTemplate = hasCopilotObj && typeof sourceDef.copilot.prompt_template === 'string';
        if (!hasCopilotObj && !hasTopLevelTemplate) {
          errors.push(rule.message);
        } else if (hasCopilotObj && !hasNestedTemplate && !hasTopLevelTemplate) {
          errors.push('copilot.prompt_template is required (or use top-level prompt_template).');
        }
      } else if (rule.field) {
        // Dot-path field check: e.g. "url.url" → sourceDef.url.url
        const parts = rule.field.split('.');
        let val = sourceDef;
        for (const p of parts) { val = val != null ? val[p] : undefined; }
        if (val === undefined || val === null || typeof val !== rule.type) {
          errors.push(rule.message);
        }
      }
    }
  }

  const result = { ok: errors.length === 0, errors };
  console.log(JSON.stringify(result));
  process.exit(errors.length === 0 ? 0 : 1);
}

// ---------------------------------------------------------------------------
// describe-capabilities — introspection metadata for this executor
// Entirely derived from source_def_flows.json registry.
// ---------------------------------------------------------------------------
function describeCapabilities() {
  const registry = loadSourceDefFlowsConfig();
  const sourceKinds = Object.fromEntries(
    Object.entries(registry?.kinds || {}).map(([kind, spec]) => {
      const manifest = spec?.manifest && typeof spec.manifest === 'object' ? spec.manifest : {};
      return [kind, manifest];
    }),
  );
  const capabilities = {
    version: registry.version || '1.0',
    executor: registry.executor || 'demo-task-executor',
    subcommands: registry.subcommands || [],
    sourceKinds,
    extraSchema: registry.extraSchema || {},
  };
  console.log(JSON.stringify(capabilities, null, 2));
}

async function main() {
  const sub = process.argv[2];
  if (sub === 'run-source-fetch') {
    await runSourceFetchSubcommand(process.argv.slice(3));
    return;
  }
  if (sub === 'describe' || sub === 'describe-capabilities') {
    describeCapabilities();
    return;
  }
  if (sub === 'validate-source-def') {
    validateSourceDefSubcommand(process.argv.slice(3));
    return;
  }

  console.warn(`[demo-task-executor] Unknown subcommand: ${sub}`);
  process.exit(0);
}

main().catch(err => {
  console.error(`[demo-task-executor] fatal: ${err && err.message || err}`);
  process.exit(1);
});
